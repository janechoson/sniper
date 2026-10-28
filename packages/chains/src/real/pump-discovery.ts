import {
  BorshInstructionCoder,
  BorshCoder,
  EventParser,
  type Idl,
} from "@coral-xyz/anchor";
import type { SolanaSwapObservation } from "./solana-discovery";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { z } from "zod";
import type { TokenDiscoveryEvent } from "@sniper/core";
import type { TrustedQuoteAsset } from "@sniper/config";
import { loadVerifiedIdl } from "./idl";
import type { SolanaTransaction } from "./solana-transaction";
export const WSOL = "So11111111111111111111111111111111111111112";
export type PumpFamily = "pump-fun" | "pump-swap";
const pubkey = z.custom<PublicKey>((value) => value instanceof PublicKey);
export const pumpFamily = (family: string): family is PumpFamily =>
  family === "pump-fun" || family === "pump-swap";
export const curvePda = (mint: string, program: string) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    new PublicKey(program),
  )[0].toBase58();
export function pumpPoolPda(
  index: number,
  creator: string,
  base: string,
  quote: string,
  program: string,
) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(index);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      bytes,
      new PublicKey(creator).toBuffer(),
      new PublicKey(base).toBuffer(),
      new PublicKey(quote).toBuffer(),
    ],
    new PublicKey(program),
  )[0].toBase58();
}
export class PumpDiscoveryDecoder {
  private readonly idl: Idl;
  private readonly coder: BorshInstructionCoder;
  private readonly parser: EventParser;
  readonly idlHash: string;
  constructor(
    readonly family: PumpFamily,
    private readonly dexId: string,
    private readonly quotes: TrustedQuoteAsset[],
  ) {
    const verified = loadVerifiedIdl(family);
    this.idl = verified.idl;
    this.idlHash = verified.hash;
    // Chỉ đọc prefix đối số bắt buộc đã có trong IDL. Các OptionBool/OptionU64 cuối
    // được protocol cho phép bỏ qua; không tự đặt discriminator hoặc offset.
    const prefix = structuredClone(this.idl);
    prefix.instructions = prefix.instructions
      .filter((ix) => this.creates(ix.name))
      .map((ix) => ({
        ...ix,
        args: ix.args.slice(
          0,
          ix.name === "create" ? 4 : ix.name === "create_v2" ? 5 : 5,
        ),
      }));
    this.coder = new BorshInstructionCoder(prefix);
    this.parser = new EventParser(
      new PublicKey(this.idl.address),
      new BorshCoder(this.idl),
    );
  }
  private creates(name: string) {
    return this.family === "pump-fun"
      ? ["create", "create_v2"].includes(name)
      : name === "create_pool";
  }
  matchesHint(normalized: string) {
    return this.idl.instructions.some(
      (ix) =>
        this.creates(ix.name) &&
        ix.name.replaceAll("_", "").toLowerCase() === normalized,
    );
  }
  sampledTrades(
    tx: SolanaTransaction,
    signature: string,
  ): SolanaSwapObservation[] {
    if (!tx.meta?.logMessages || tx.meta.err !== null || tx.blockTime === null)
      return [];
    const result: SolanaSwapObservation[] = [];
    try {
      let index = 0;
      for (const event of this.parser.parseLogs(tx.meta.logMessages, false)) {
        const eventIndex = index++;
        const data = event.data as Record<string, unknown>;
        const amount = (field: string) => {
          const value = String(data[field]);
          if (!/^\d+$/.test(value)) throw new Error("PUMP_TRADE_EVENT_INVALID");
          return value;
        };
        if (this.family === "pump-fun" && event.name === "TradeEvent") {
          const mint = pubkey.parse(data.mint).toBase58();
          let quote = pubkey.parse(data.quote_mint).toBase58();
          if (quote === PublicKey.default.toBase58()) quote = WSOL;
          const buy = z.boolean().parse(data.is_buy),
            tokens = amount("token_amount");
          let quoteAmount = amount("quote_amount");
          if (quote === WSOL && quoteAmount === "0")
            quoteAmount = amount("sol_amount");
          result.push({
            poolAddress: curvePda(mint, this.idl.address),
            inputMint: buy ? quote : mint,
            outputMint: buy ? mint : quote,
            amountIn: buy ? quoteAmount : tokens,
            amountOut: buy ? tokens : quoteAmount,
            at: tx.blockTime * 1000,
            id: `${signature}:${this.idl.address}:${eventIndex}`,
          });
        }
        if (
          this.family === "pump-swap" &&
          (event.name === "BuyEvent" || event.name === "SellEvent")
        ) {
          const buy = event.name === "BuyEvent";
          result.push({
            poolAddress: pubkey.parse(data.pool).toBase58(),
            swapForY: !buy,
            amountIn: amount(buy ? "quote_amount_in" : "base_amount_in"),
            amountOut: amount(buy ? "base_amount_out" : "quote_amount_out"),
            at: tx.blockTime * 1000,
            id: `${signature}:${this.idl.address}:${eventIndex}`,
          });
        }
      }
    } catch {
      return []; /* Layout log chưa hỗ trợ không được diễn giải thành volume 0. */
    }
    return result;
  }
  decode(tx: SolanaTransaction, signature: string): TokenDiscoveryEvent[] {
    if (!tx.meta || tx.meta.err !== null) return [];
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const instructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).flatMap(
        (group) => group.instructions,
      ),
    ];
    const result: TokenDiscoveryEvent[] = [];
    const pools = new Set<string>();
    for (const instruction of instructions) {
      if (keys[instruction.programIdIndex] !== this.idl.address) continue;
      let decoded: ReturnType<BorshInstructionCoder["decode"]>;
      try {
        decoded = this.coder.decode(instruction.data, "base58");
      } catch {
        throw new Error("PUMP_INSTRUCTION_DATA_INVALID");
      }
      if (!decoded || !this.creates(decoded.name)) continue;
      const definition = this.idl.instructions.find(
        (ix) => ix.name === decoded.name,
      )!;
      if (instruction.accounts.length < definition.accounts.length)
        throw new Error("PUMP_INSTRUCTION_ACCOUNTS_INVALID");
      const named = new Map(
        definition.accounts.map((account, index) => [
          account.name,
          keys[instruction.accounts[index] ?? -1],
        ]),
      );
      const required = (name: string) => {
        const value = named.get(name);
        if (!value) throw new Error("PUMP_ACCOUNT_MISSING");
        new PublicKey(value);
        return value;
      };
      for (const account of definition.accounts)
        if (
          "address" in account &&
          account.address &&
          required(account.name) !== account.address
        )
          throw new Error("PUMP_FIXED_ACCOUNT_MISMATCH");
      const program = new PublicKey(this.idl.address);
      if (
        required("program") !== this.idl.address ||
        required("event_authority") !==
          PublicKey.findProgramAddressSync(
            [Buffer.from("__event_authority")],
            program,
          )[0].toBase58()
      )
        throw new Error("PUMP_PROGRAM_IDENTITY_MISMATCH");
      let mint: string,
        quote: string,
        pool: string,
        creator: string,
        tokenProgram: string;
      const details: Record<string, unknown> = { instruction: decoded.name };
      if (this.family === "pump-fun") {
        const args = z
          .object({
            name: z.string().max(32),
            symbol: z.string().max(13),
            uri: z.string().max(200),
            creator: pubkey,
          })
          .parse(decoded.data);
        mint = required("mint");
        pool = required("bonding_curve");
        creator = args.creator.toBase58();
        if (
          creator === PublicKey.default.toBase58() ||
          pool !== curvePda(mint, this.idl.address)
        )
          throw new Error("PUMP_CURVE_IDENTITY_MISMATCH");
        tokenProgram = required("token_program");
        const expected =
          decoded.name === "create" ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
        if (tokenProgram !== expected.toBase58())
          throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
        if (
          required("associated_bonding_curve") !==
          getAssociatedTokenAddressSync(
            new PublicKey(mint),
            new PublicKey(pool),
            true,
            expected,
          ).toBase58()
        )
          throw new Error("PUMP_VAULT_IDENTITY_MISMATCH");
        const extra = instruction.accounts.slice(definition.accounts.length);
        if (
          decoded.name === "create_v2" &&
          extra.length > 0 &&
          extra.length < 3
        )
          throw new Error("PUMP_QUOTE_ACCOUNTS_INCOMPLETE");
        quote =
          decoded.name === "create_v2" && extra.length
            ? keys[extra[0]!]!
            : WSOL;
        if (!quote) throw new Error("PUMP_QUOTE_MISSING");
        details.symbol = args.symbol;
        details.name = args.name;
        details.creatorRole = "TOKEN_CREATOR";
        details.lifecycle = "DISCOVERED_ON_PUMP_FUN";
      } else {
        const args = z
          .object({
            index: z.number().int().min(0).max(65535),
            coin_creator: pubkey,
          })
          .parse(decoded.data);
        mint = required("base_mint");
        quote = required("quote_mint");
        pool = required("pool");
        creator = required("creator");
        tokenProgram = required("base_token_program");
        if (
          pool !==
          pumpPoolPda(args.index, creator, mint, quote, this.idl.address)
        )
          throw new Error("PUMP_POOL_IDENTITY_MISMATCH");
        const quoteProgram = required("quote_token_program");
        if (
          ![
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
          ].includes(tokenProgram) ||
          ![
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
          ].includes(quoteProgram)
        )
          throw new Error("PUMP_TOKEN_PROGRAM_MISMATCH");
        for (const [field, asset, owner] of [
          ["pool_base_token_account", mint, tokenProgram],
          ["pool_quote_token_account", quote, quoteProgram],
        ])
          if (
            required(field!) !==
            getAssociatedTokenAddressSync(
              new PublicKey(asset!),
              new PublicKey(pool),
              true,
              new PublicKey(owner!),
            ).toBase58()
          )
            throw new Error("PUMP_VAULT_IDENTITY_MISMATCH");
        details.coinCreator = args.coin_creator.toBase58();
        details.creatorRole = "POOL_CREATOR";
        details.index = args.index;
        details.lifecycle = "PUMPSWAP_POOL_CREATED";
      }
      if (pools.has(pool)) continue;
      pools.add(pool);
      const trusted =
        this.quotes.some((asset) => asset.address === quote) &&
        !this.quotes.some((asset) => asset.address === mint);
      const timestamp =
        tx.blockTime === null ? Date.now() : tx.blockTime * 1000;
      result.push({
        id: `rpc:solana:${this.dexId}:${pool}`,
        chainId: "solana",
        dexId: this.dexId,
        tokenAddress: mint,
        poolAddress: pool,
        quoteTokenAddress: quote,
        source: "RPC",
        timestamp,
        chainTimestamp: tx.blockTime === null ? undefined : timestamp,
        detectedAt: Date.now(),
        transactionId: signature,
        pairClassification: trusted ? "TRUSTED_QUOTE" : "UNKNOWN_PAIR",
        rawEvent: {
          ...details,
          protocol: this.family,
          tokenIdentity: `solana:${mint}`,
          creator,
          slot: tx.slot,
          tokenProgram,
          programId: this.idl.address,
          idlHash: this.idlHash,
          transactionVersion: tx.version ?? "UNKNOWN",
          quoteMint: quote,
          mintA: mint,
          mintB: quote,
        },
      });
    }
    return result;
  }
}
