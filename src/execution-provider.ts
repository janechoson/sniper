import { readFileSync } from "node:fs";
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  SystemInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { z } from "zod";
import type { LiveConfig } from "./live-config.js";
import {
  inspectMint,
  requireCompatibleToken,
  tokenAccountAddress,
  inspectTokenAccount,
  TOKEN_2022_PROGRAM_ID,
} from "./token-program.js";
import { Blocked, CandidateRejected, ProviderFailure } from "./domain.js";
import { SOL } from "./live-config.js";
import { Solana } from "./solana.js";
import { Http, deepFreeze, sleep, type Health } from "./util.js";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")),
    out = "";
  while (n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    out = "1" + out;
  }
  return out;
}
function decode58(value: string) {
  let n = 0n;
  for (const c of value) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error();
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([
    Buffer.alloc(value.match(/^1*/)?.[0].length ?? 0),
    n ? Buffer.from(hex, "hex") : Buffer.alloc(0),
  ]);
}
export function localWallet(config: LiveConfig): Keypair {
  if (!config.SOLANA_PRIVATE_KEY && !config.SOLANA_KEYPAIR_PATH)
    throw new Blocked("MISSING_SOLANA_SIGNING_KEY");
  try {
    const text =
      config.SOLANA_PRIVATE_KEY ||
      readFileSync(config.SOLANA_KEYPAIR_PATH, "utf8").trim();
    const bytes = text.startsWith("[")
      ? Uint8Array.from(
          z
            .array(z.number().int().min(0).max(255))
            .length(64)
            .parse(JSON.parse(text)),
        )
      : decode58(text);
    const wallet = Keypair.fromSecretKey(Uint8Array.from(bytes));
    bytes.fill(0);
    if (wallet.publicKey.toBase58() !== config.WALLET_PUBLIC_KEY)
      throw new Blocked("SOLANA_SIGNER_WALLET_MISMATCH");
    return wallet;
  } catch (e) {
    if (e instanceof Blocked) throw e;
    throw new Blocked("INVALID_SOLANA_SIGNING_KEY");
  }
}
const atomic = z.string().regex(/^[1-9]\d*$/);
const orderSchema = z.object({
  priceImpactPct: z.preprocess((v) => {
    if ((typeof v !== "number" && typeof v !== "string") || v === "")
      return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }, z.coerce.number().finite().nonnegative().optional()),
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: atomic,
  outAmount: atomic,
  otherAmountThreshold: atomic,
  swapMode: z.literal("ExactIn"),
  slippageBps: z.number().int().min(0).max(10000),
  taker: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  router: z.literal("metis"),
  transaction: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  requestId: z.string().default(""),
  signatureFeeLamports: z.number().int().nonnegative().safe().default(0),
  prioritizationFeeLamports: z.number().int().nonnegative().safe().default(0),
  rentFeeLamports: z.number().int().nonnegative().safe().default(0),
  signatureFeePayer: z
    .string()
    .nullish()
    .transform((v) => v ?? ""),
  lastValidBlockHeight: z.string().optional(),
  expireAt: z.string().optional(),
  routePlan: z
    .array(
      z.object({
        swapInfo: z.object({
          label: z.string(),
          inputMint: z.string(),
          outputMint: z.string(),
        }),
      }),
    )
    .min(1),
});
export interface ExecutionQuote {
  provider: "JUPITER";
  chain: "solana";
  wallet: string;
  mint: string;
  side: "BUY" | "SELL";
  routeOnly?: boolean;
  amount: string;
  at: number;
  maxSlippageBps: number;
  order: z.infer<typeof orderSchema>;
}
export interface SolanaExecutionProvider {
  readonly health: Health;
  getWalletBalance(): Promise<bigint>;
  quoteBuy(
    mint: string,
    amount: bigint,
    slippageBps: number,
  ): Promise<ExecutionQuote>;
  quoteSell(
    mint: string,
    amount: bigint,
    slippageBps: number,
    routeOnly?: boolean,
  ): Promise<ExecutionQuote>;
  simulate(quote: ExecutionQuote): Promise<void>;
  execute(
    quote: ExecutionQuote,
    beforeBroadcast: (signature: string) => void,
    beforeSign?: () => void,
  ): Promise<string>;
  confirm(signature: string): Promise<"CONFIRMED" | "FAILED" | "UNKNOWN">;
}
export function validateQuote(
  q: ExecutionQuote,
  expected: {
    mint: string;
    side: "BUY" | "SELL";
    amount: bigint;
    wallet: string;
    slippageBps: number;
    routeOnly?: boolean;
  },
  now = Date.now(),
) {
  const o = orderSchema.parse(q.order);
  const buy = expected.side === "BUY";
  if (
    q.chain !== "solana" ||
    q.provider !== "JUPITER" ||
    q.wallet !== expected.wallet ||
    !!q.routeOnly !== !!expected.routeOnly ||
    (!expected.routeOnly &&
      (o.taker !== expected.wallet ||
        o.signatureFeePayer !== expected.wallet ||
        !o.transaction ||
        !o.requestId))
  )
    throw new Blocked("QUOTE_CHAIN_OR_WALLET_MISMATCH");
  if (
    q.mint !== expected.mint ||
    q.side !== expected.side ||
    o.inputMint !== (buy ? SOL : expected.mint) ||
    o.outputMint !== (buy ? expected.mint : SOL) ||
    expected.mint === SOL
  )
    throw new Blocked("QUOTE_MINT_OR_DIRECTION_MISMATCH");
  if (
    q.amount !== expected.amount.toString() ||
    o.inAmount !== q.amount ||
    expected.amount <= 0n
  )
    throw new Blocked("QUOTE_AMOUNT_MISMATCH");
  if (
    o.slippageBps > expected.slippageBps ||
    q.maxSlippageBps !== expected.slippageBps ||
    BigInt(o.otherAmountThreshold) > BigInt(o.outAmount) ||
    BigInt(o.otherAmountThreshold) <
      (BigInt(o.outAmount) * BigInt(10000 - expected.slippageBps)) / 10000n
  )
    throw new Blocked("QUOTE_SLIPPAGE_MISMATCH");
  if (
    now - q.at > 20000 ||
    q.at > now + 1000 ||
    (o.expireAt &&
      (!Number.isFinite(Date.parse(o.expireAt)) ||
        Date.parse(o.expireAt) <= now))
  )
    throw new CandidateRejected("QUOTE_STALE");
  if (
    !o.routePlan.some((r) => r.swapInfo.inputMint === o.inputMint) ||
    !o.routePlan.some((r) => r.swapInfo.outputMint === o.outputMint)
  )
    throw new Blocked("QUOTE_ROUTE_MISMATCH");
}
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
function associated(wallet: PublicKey, mint: PublicKey, program = TOKEN) {
  return tokenAccountAddress(wallet, mint, program);
}

/** Jupiter builds/lands; signing stays here. RPC is used only for wallet checks/simulation/confirmation. */
export class JupiterExecutionProvider implements SolanaExecutionProvider {
  readonly http = new Http("JUPITER", 2200);
  get health() {
    return this.http.health;
  }
  private readonly checked = new WeakSet<ExecutionQuote>();
  private readonly consumed = new WeakSet<ExecutionQuote>();
  constructor(
    readonly rpc: Solana,
    readonly configuration: LiveConfig,
  ) {}
  getWalletBalance() {
    return this.rpc.balance(this.configuration.WALLET_PUBLIC_KEY);
  }
  quoteBuy(mint: string, amount: bigint, slippageBps: number) {
    return this.quote(mint, amount, slippageBps, "BUY");
  }
  quoteSell(
    mint: string,
    amount: bigint,
    slippageBps: number,
    routeOnly = false,
  ) {
    return this.quote(mint, amount, slippageBps, "SELL", routeOnly);
  }
  private headers(): Record<string, string> {
    return this.configuration.JUPITER_API_KEY
      ? { "x-api-key": this.configuration.JUPITER_API_KEY }
      : {};
  }
  private async quote(
    mint: string,
    amount: bigint,
    slippageBps: number,
    side: "BUY" | "SELL",
    routeOnly = false,
  ): Promise<ExecutionQuote> {
    new PublicKey(mint);
    new PublicKey(this.configuration.WALLET_PUBLIC_KEY);
    if (amount <= 0n) throw new Blocked("INVALID_SWAP_AMOUNT");
    const params = new URLSearchParams({
      inputMint: side === "BUY" ? SOL : mint,
      outputMint: side === "BUY" ? mint : SOL,
      amount: amount.toString(),
      taker: this.configuration.WALLET_PUBLIC_KEY,
      swapMode: "ExactIn",
      slippageBps: String(slippageBps),
      excludeRouters: "jupiterz,dflow,okx",
      maxSupportedTransactionVersion: "0",
      priorityFeeLamports: "100000",
      broadcastFeeType: "maxCap",
    });
    if (routeOnly) params.delete("taker");
    let raw: unknown;
    try {
      raw = await this.http.request(
        "https://api.jup.ag/swap/v2/order?" + params,
        { headers: this.headers() },
      );
    } catch (error) {
      if (
        error instanceof Blocked &&
        ["JUPITER_HTTP_400", "JUPITER_HTTP_404", "JUPITER_HTTP_422"].includes(
          error.code,
        )
      )
        throw new CandidateRejected(
          side === "BUY" ? "NO_BUY_ROUTE" : "NO_SELL_ROUTE",
          { mint, side },
        );
      throw error;
    }
    const error = z
      .object({
        errorCode: z.number().optional(),
        router: z.string().optional(),
      })
      .passthrough()
      .safeParse(raw);
    if (error.success && error.data.errorCode) {
      if (error.data.errorCode === 3 && error.data.router === "metis")
        throw new CandidateRejected("CONTROLLED_PRINCIPAL_CAP", {
          mint,
          amount: amount.toString(),
          reason: "Route minimum/gasless requirement; amount never increased",
        });
      throw new ProviderFailure(
        "JUPITER_BUILD_ERROR_" + error.data.errorCode,
        "JUPITER",
      );
    }
    const parsed = orderSchema.safeParse(raw);
    if (!parsed.success) {
      if (raw && typeof raw === "object" && "error" in raw)
        throw new CandidateRejected(
          side === "BUY" ? "NO_BUY_ROUTE" : "NO_SELL_ROUTE",
          { mint, side },
        );
      throw new ProviderFailure("JUPITER_INVALID_RESPONSE", "JUPITER");
    }
    const q: ExecutionQuote = deepFreeze({
      provider: "JUPITER",
      chain: "solana",
      wallet: this.configuration.WALLET_PUBLIC_KEY,
      mint,
      side,
      routeOnly,
      amount: amount.toString(),
      maxSlippageBps: slippageBps,
      at: Date.now(),
      order: parsed.data,
    });
    validateQuote(q, {
      mint,
      side,
      amount,
      wallet: this.configuration.WALLET_PUBLIC_KEY,
      slippageBps,
      routeOnly,
    });
    return q;
  }
  private validate(q: ExecutionQuote) {
    validateQuote(q, {
      mint: q.mint,
      side: q.side,
      amount: BigInt(q.amount),
      wallet: this.configuration.WALLET_PUBLIC_KEY,
      slippageBps: q.maxSlippageBps,
    });
  }
  async simulate(q: ExecutionQuote) {
    this.validate(q);
    if (q.routeOnly) throw new Blocked("QUOTE_NOT_EXECUTABLE");
    const wallet = new PublicKey(q.wallet),
      mint = new PublicKey(q.mint);
    const mintInfo = await this.rpc.connection.getAccountInfo(
      mint,
      "confirmed",
    );
    const tokenReport = inspectMint(q.mint, mintInfo);
    requireCompatibleToken(tokenReport);
    const tokenProgram = new PublicKey(tokenReport.programId);
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(
        Buffer.from(q.order.transaction, "base64"),
      );
    } catch {
      throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
        mint: q.mint,
      });
    }
    if (tx.version !== 0)
      throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
        mint: q.mint,
        version: tx.version,
      });
    if (
      tx.message.header.numRequiredSignatures !== 1 ||
      !tx.message.staticAccountKeys[0]?.equals(wallet)
    )
      throw new Blocked("TRANSACTION_SIGNER_MISMATCH");
    const tables = [];
    for (const lookup of tx.message.addressTableLookups) {
      const r = await this.rpc.connection.getAddressLookupTable(
        lookup.accountKey,
      );
      if (!r.value) throw new Blocked("LOOKUP_TABLE_UNAVAILABLE");
      tables.push(r.value);
    }
    const message = TransactionMessage.decompile(tx.message, {
      addressLookupTableAccounts: tables,
    });
    const wrapped = associated(wallet, new PublicKey(SOL));
    let principal = 0n;
    for (const ix of message.instructions) {
      const program = ix.programId.toBase58();
      if (
        ![
          SystemProgram.programId.toBase58(),
          TOKEN.toBase58(),
          ATA.toBase58(),
          TOKEN_2022_PROGRAM_ID.toBase58(),
          ComputeBudgetProgram.programId.toBase58(),
          JUPITER,
        ].includes(program)
      )
        throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
          program,
        });
      if (ix.programId.equals(SystemProgram.programId)) {
        if (SystemInstruction.decodeInstructionType(ix) !== "Transfer")
          throw new Blocked("UNEXPECTED_SYSTEM_INSTRUCTION");
        const t = SystemInstruction.decodeTransfer(ix);
        if (!t.fromPubkey.equals(wallet) || !t.toPubkey.equals(wrapped))
          throw new Blocked("UNEXPECTED_SOL_TRANSFER");
        principal += BigInt(t.lamports);
      }
      if (ix.programId.equals(ATA)) {
        if (
          !ix.keys[0]?.pubkey.equals(wallet) ||
          !ix.keys[2]?.pubkey.equals(wallet)
        )
          throw new Blocked("UNEXPECTED_TRANSACTION_RECIPIENT");
        const targetMint = ix.keys[3]?.pubkey;
        if (!targetMint || ![q.mint, SOL].includes(targetMint.toBase58()))
          throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
            reason: "Additional intermediate ATA creation",
          });
        const expectedProgram = targetMint.equals(mint) ? tokenProgram : TOKEN;
        if (
          !ix.keys[5]?.pubkey.equals(expectedProgram) ||
          !ix.keys[1]?.pubkey.equals(
            associated(wallet, targetMint, expectedProgram),
          )
        )
          throw new Blocked("TOKEN_ACCOUNT_WALLET_OR_MINT_MISMATCH");
        if (
          ix.data.length > 1 ||
          (ix.data.length === 1 && ![0, 1].includes(ix.data[0]!))
        )
          throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
            reason: "Unsupported ATA instruction",
          });
      }
      if (ix.programId.equals(TOKEN_2022_PROGRAM_ID))
        throw new CandidateRejected("UNSUPPORTED_TRANSACTION_LAYOUT", {
          reason:
            "Top-level Token-2022 instruction; swaps must use inspected Jupiter route",
        });
      // No delegate/authority changes, arbitrary token transfers, or account closes outside wSOL cleanup.
      if (ix.programId.equals(TOKEN)) {
        const code = ix.data[0];
        if (
          code !== 17 &&
          !(
            code === 9 &&
            ix.keys[0]?.pubkey.equals(wrapped) &&
            ix.keys[1]?.pubkey.equals(wallet)
          )
        )
          throw new Blocked("UNEXPECTED_TOKEN_INSTRUCTION");
      }
    }
    if (principal !== (q.side === "BUY" ? BigInt(q.amount) : 0n))
      throw new Blocked("TRANSACTION_PRINCIPAL_MISMATCH");
    const token = associated(wallet, mint, tokenProgram);
    const pre = await this.rpc.connection.getMultipleAccountsInfo(
      [wallet, token],
      "confirmed",
    );
    const response = await this.rpc.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [q.wallet, token.toBase58()] },
    });
    if (response.value.err)
      throw new CandidateRejected("TOKEN_SIMULATION_FAILED", {
        mint: q.mint,
        simulationError: response.value.err,
        logs: response.value.logs?.slice(-12).map((line) => line.slice(0, 500)),
      });
    if (!response.value.accounts)
      throw new Blocked("SIMULATION_ACCOUNTS_UNAVAILABLE");
    const post = response.value.accounts;
    const beforeTokens = inspectTokenAccount(
      token,
      pre[1] ?? null,
      wallet,
      mint,
      tokenProgram,
    );
    const simulatedToken = post[1]
      ? {
          ...post[1],
          owner: new PublicKey(post[1].owner),
          data: Buffer.from(post[1].data[0]!, "base64"),
        }
      : null;
    const afterTokens = inspectTokenAccount(
      token,
      simulatedToken,
      wallet,
      mint,
      tokenProgram,
    );
    const delta = afterTokens - beforeTokens;
    const solDelta =
      BigInt(post[0]?.lamports ?? 0) - BigInt(pre[0]?.lamports ?? 0);
    const fees = BigInt(
      q.order.signatureFeeLamports +
        q.order.prioritizationFeeLamports +
        q.order.rentFeeLamports,
    );
    if (fees > 5_000_000n)
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "EXECUTION_FEES_EXCEED_RESERVE",
      });
    if (
      q.side === "BUY"
        ? delta < BigInt(q.order.otherAmountThreshold) ||
          solDelta >= 0n ||
          -solDelta > BigInt(q.amount) + fees
        : delta !== -BigInt(q.amount) || solDelta <= 0n
    )
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "SIMULATED_BALANCE_MISMATCH",
        mint: q.mint,
        principal: q.amount,
        quotedFeesLamports: fees.toString(),
        simulatedSolDelta: solDelta.toString(),
        simulatedTokenDelta: delta.toString(),
        minimumOutput: q.order.otherAmountThreshold,
      });
    this.checked.add(q);
  }
  async execute(
    q: ExecutionQuote,
    beforeBroadcast: (signature: string) => void,
    beforeSign?: () => void,
  ) {
    this.validate(q);
    if (!this.checked.has(q) || this.consumed.has(q))
      throw new Blocked("UNSIMULATED_OR_DUPLICATE_QUOTE");
    const wallet = localWallet(this.configuration);
    const tx = VersionedTransaction.deserialize(
      Buffer.from(q.order.transaction, "base64"),
    );
    try {
      beforeSign?.();
      tx.sign([wallet]);
    } finally {
      wallet.secretKey.fill(0);
    }
    const signature = base58(tx.signatures[0]!);
    this.consumed.add(q);
    // The caller commits this signature durably before the first possible broadcast.
    beforeBroadcast(signature);
    const result = z
      .object({
        signature: z.string().optional(),
        status: z.string().optional(),
        code: z.number().optional(),
      })
      .parse(
        await this.http.request(
          "https://api.jup.ag/swap/v2/execute",
          {
            method: "POST",
            headers: { ...this.headers(), "Content-Type": "application/json" },
            body: JSON.stringify({
              signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
              requestId: q.order.requestId,
              lastValidBlockHeight: q.order.lastValidBlockHeight,
            }),
          },
          false,
        ),
      );
    if (result.signature && result.signature !== signature)
      throw new Blocked("EXECUTION_SIGNATURE_MISMATCH");
    // Even a Failed/timeout response remains unresolved until RPC evidence says otherwise.
    return signature;
  }
  async confirm(signature: string) {
    for (let n = 0; n < 12; n++) {
      const s = (
        await this.rpc.connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (s?.err) return "FAILED" as const;
      if (s && ["confirmed", "finalized"].includes(s.confirmationStatus ?? ""))
        return "CONFIRMED" as const;
      if (n < 11) await sleep(2000);
    }
    return "UNKNOWN" as const;
  }
}
