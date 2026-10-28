import {
  BorshInstructionCoder,
  BorshEventCoder,
  BorshCoder,
  EventParser,
  utils,
  type Idl,
} from "@coral-xyz/anchor";
import anchor from "@coral-xyz/anchor";
type BN = import("@coral-xyz/anchor").BN;
const BN = anchor.BN;
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { TokenDiscoveryEvent } from "@sniper/core";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import { JsonRpcClient } from "../rpc/http";
import type { DiscoveryCursorStore } from "./evm-discovery";
import { loadVerifiedIdl } from "./idl";
import { SolanaTransactionReader } from "./solana-transaction";
import { PumpDiscoveryDecoder } from "./pump-discovery";
const programs = {
  "pump-fun": {
    address: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    file: "pump-fun.json",
  },
  "pump-swap": {
    address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    file: "pump-swap.json",
  },
  "raydium-cpmm": {
    address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    file: "raydium-cpmm.json",
  },
  "meteora-dlmm": {
    address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    file: "meteora-dlmm.json",
  },
} as const;
const eventCpiTag = createHash("sha256")
  .update("anchor:event")
  .digest()
  .subarray(0, 8);
const signatureSchema = z.object({
  signature: z.string(),
  slot: z.number().int(),
  err: z.unknown().nullable(),
  blockTime: z.number().nullable(),
});
export class SolanaProgramDiscovery {
  private polling = false;
  private stopped = false;
  private hints = new Set<string>();
  private observedSignatures = new Set<string>();
  private failures = new Map<
    string,
    { at: number; attempts: number; retryAt: number }
  >();
  private droppedHints = 0;
  private duplicateHints = 0;
  private validationFailures = 0;
  private expired = 0;
  stats() {
    return {
      pendingSignatures: this.hints.size,
      droppedHints: this.droppedHints,
      duplicates: this.duplicateHints,
      validationFailures: this.validationFailures,
      expired: this.expired,
    };
  }
  private lastFallback = 0;
  private readonly idl: Idl;
  private readonly transactions: SolanaTransactionReader;
  private readonly pump?: PumpDiscoveryDecoder;
  private readonly instructions: BorshInstructionCoder;
  private readonly events: BorshEventCoder;
  private readonly parser: EventParser;
  readonly idlHash: string;
  constructor(
    private readonly chainId: string,
    private readonly rpc: JsonRpcClient,
    private readonly deployment: DexDeploymentConfig,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly cursors: DiscoveryCursorStore,
    private readonly onCreator?: (
      event: TokenDiscoveryEvent,
      address: string,
    ) => Promise<void>,
    private readonly onSwap?: (value: SolanaSwapObservation) => Promise<void>,
    private readonly onCoverage?: (through: number, complete: boolean) => void,
    private readonly options: {
      observationOnly?: boolean;
      transactionReader?: SolanaTransactionReader;
    } = {},
  ) {
    if (
      deployment.family !== "raydium-cpmm" &&
      deployment.family !== "meteora-dlmm" &&
      deployment.family !== "pump-fun" &&
      deployment.family !== "pump-swap"
    )
      throw new Error("SOLANA_DEX_UNSUPPORTED");
    const pinned = programs[deployment.family];
    if (deployment.programId !== pinned.address)
      throw new Error("SOLANA_PROGRAM_NOT_VERIFIED");
    const verified = loadVerifiedIdl(deployment.family);
    this.idlHash = verified.hash;
    const parsed: unknown = verified.idl;
    if (
      z
        .object({
          address: z.string(),
          instructions: z.array(z.unknown()),
          types: z.array(z.unknown()),
        })
        .parse(parsed).address !== pinned.address
    )
      throw new Error("IDL_PROGRAM_MISMATCH");
    this.idl = parsed as Idl;
    this.transactions =
      options.transactionReader ?? new SolanaTransactionReader(rpc);
    if (deployment.family === "pump-fun" || deployment.family === "pump-swap")
      this.pump = new PumpDiscoveryDecoder(
        deployment.family,
        deployment.id,
        quotes,
      );
    this.instructions = new BorshInstructionCoder(this.idl);
    this.events = new BorshEventCoder(this.idl);
    this.parser = new EventParser(
      new PublicKey(pinned.address),
      new BorshCoder(this.idl),
    );
  }
  stop() {
    this.stopped = true;
  }
  async poll(callback: (event: TokenDiscoveryEvent) => Promise<void>) {
    if (this.polling || this.stopped) return;
    if (this.options.observationOnly) return this.pollObservation(callback);
    this.polling = true;
    try {
      const program = this.deployment.programId!;
      const key = `discovery:${this.chainId}:${this.deployment.id}`;
      const cursor = await this.cursors.readCursor(key);
      const coveredSlot = await this.rpc.request(
        "getSlot",
        [{ commitment: "confirmed" }],
        z.number().int(),
      );
      const recent = await this.rpc.request(
        "getSignaturesForAddress",
        [
          program,
          {
            limit: cursor ? 100 : 20,
            commitment: "confirmed",
            minContextSlot: coveredSlot,
          },
        ],
        z.array(signatureSchema).max(100),
      );
      const end = cursor
        ? recent.findIndex((row) => row.signature === cursor)
        : -1;
      if (cursor && end < 0 && recent.length >= 100) {
        // A history gap must not starve verified new-launch WS hints. Drain
        // bounded hints/sampling without advancing the strict cursor or claiming
        // complete swap coverage; the gap remains an entry/readiness blocker.
        this.polling = false;
        await this.pollObservation(callback);
        throw new Error("SOLANA_DISCOVERY_GAP_REQUIRES_BACKFILL");
      }
      const pending = recent.slice(0, end < 0 ? recent.length : end).reverse();
      let complete = true;
      for (const entry of pending) {
        if (this.stopped) return;
        if (entry.err === null) {
          complete =
            (await this.processSignature(entry.signature, callback)) &&
            complete;
        }
        await this.cursors.writeCursor(key, entry.signature);
      }
      const through = await this.rpc.request(
        "getBlockTime",
        [coveredSlot],
        z.number().nullable(),
      );
      if (through !== null) this.onCoverage?.(through * 1000, complete);
      else this.onCoverage?.(Date.now(), false);
    } finally {
      this.polling = false;
    }
  }
  hint(value: unknown) {
    const notice = z
      .object({
        value: z.object({
          signature: z.string().max(100),
          err: z.unknown().nullable(),
          logs: z.array(z.string()).max(1000),
        }),
      })
      .safeParse(value);
    if (
      !notice.success ||
      notice.data.value.err !== null ||
      !notice.data.value.logs.some((log) => {
        const instruction = /^Program log: Instruction: ([A-Za-z0-9_]+)\s*$/
          .exec(log)?.[1]
          ?.replaceAll("_", "")
          .toLowerCase();
        if (!instruction) return false;
        if (this.pump) return this.pump.matchesHint(instruction);
        return this.idl.instructions.some(
          (ix) =>
            (this.deployment.family === "raydium-cpmm"
              ? ["initialize", "initialize_with_permission"].includes(ix.name)
              : ix.name.startsWith("initialize") &&
                ix.name.includes("lb_pair")) &&
            ix.name.replaceAll("_", "").toLowerCase() === instruction,
        );
      })
    )
      return;
    if (
      this.observedSignatures.has(notice.data.value.signature) ||
      this.hints.has(notice.data.value.signature)
    ) {
      this.duplicateHints++;
      return;
    }
    if (this.hints.size >= 128) {
      this.droppedHints++;
      return;
    }
    if (
      this.hints.size < 128 &&
      !this.observedSignatures.has(notice.data.value.signature)
    )
      this.hints.add(notice.data.value.signature);
  }
  private async pollObservation(
    callback: (event: TokenDiscoveryEvent) => Promise<void>,
  ) {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (Date.now() - this.lastFallback >= 15000) {
        this.lastFallback = Date.now();
        try {
          const recent = await this.rpc.request(
            "getSignaturesForAddress",
            [this.deployment.programId!, { limit: 5, commitment: "confirmed" }],
            z.array(signatureSchema).max(5),
          );
          for (const row of recent.reverse())
            if (
              row.err === null &&
              !this.observedSignatures.has(row.signature) &&
              this.hints.size < 128
            )
              this.hints.add(row.signature);
        } catch (error) {
          if (this.hints.size === 0)
            throw error; /* Lỗi fallback không chặn hint WS đã nhận. */
        }
      }
      for (const signature of [...this.hints]
        .filter(
          (signature) =>
            (this.failures.get(signature)?.retryAt ?? 0) <= Date.now(),
        )
        .slice(0, 10)) {
        if (this.stopped) return;
        try {
          await this.processSignature(
            signature,
            async (event) =>
              callback({
                ...event,
                rawEvent: {
                  ...(event.rawEvent && typeof event.rawEvent === "object"
                    ? event.rawEvent
                    : {}),
                  discoveryCoverage: "OPPORTUNISTIC_RPC_WS",
                },
              }),
            false,
          );
        } catch (error) {
          const old = this.failures.get(signature) ?? {
            at: Date.now(),
            attempts: 0,
            retryAt: 0,
          };
          old.attempts++;
          old.retryAt =
            Date.now() +
            Math.min(30000, 1000 * 2 ** Math.min(5, old.attempts - 1));
          this.failures.set(signature, old);
          const invalid =
            error instanceof z.ZodError ||
            (error instanceof Error && /^PUMP_/.test(error.message));
          if (invalid || Date.now() - old.at > 120000) {
            if (invalid) this.validationFailures++;
            else this.expired++;
            this.hints.delete(signature);
            this.failures.delete(signature);
            this.observedSignatures.add(signature);
            if (this.observedSignatures.size > 1024)
              this.observedSignatures.delete(
                this.observedSignatures.values().next().value!,
              );
          }
          // Một signature lỗi không chặn các launch khác. Không tuyên bố đủ coverage.
          continue;
        }
        this.hints.delete(signature);
        this.failures.delete(signature);
        this.observedSignatures.add(signature);
        if (this.observedSignatures.size > 1024)
          this.observedSignatures.delete(
            this.observedSignatures.values().next().value!,
          );
      }
      // Initialization hints + bounded recent sampling cannot certify a complete swap stream.
      this.onCoverage?.(Date.now(), false);
    } finally {
      this.polling = false;
    }
  }
  private async processSignature(
    signature: string,
    callback: (event: TokenDiscoveryEvent) => Promise<void>,
    captureSwaps = true,
  ): Promise<boolean> {
    const program = this.deployment.programId!;
    let complete = true;
    const tx = await this.transactions.read(signature);
    if (!tx?.meta) throw new Error("TRANSACTION_UNAVAILABLE_RETRY");
    if (tx.meta.err === null && this.pump) {
      for (const event of this.pump.decode(tx, signature))
        await callback(event);
      for (const trade of this.pump.sampledTrades(tx, signature))
        await this.onSwap?.(trade);
      return false; // Lấy mẫu các transaction Pump không chứng minh stream swap đầy đủ.
    }
    if (tx.meta.err === null) {
      if (
        captureSwaps &&
        this.onSwap &&
        this.deployment.family === "raydium-cpmm"
      ) {
        if (!tx.meta.logMessages || tx.blockTime === null) complete = false;
        else {
          let eventIndex = 0;
          for (const event of this.parser.parseLogs(
            tx.meta.logMessages,
            false,
          )) {
            const index = eventIndex++;
            if (event.name !== "SwapEvent") continue;
            const raw: unknown = event.data;
            const value = z
              .object({
                pool_id: z.custom<PublicKey>((v) => v instanceof PublicKey),
                input_mint: z.custom<PublicKey>((v) => v instanceof PublicKey),
                output_mint: z.custom<PublicKey>((v) => v instanceof PublicKey),
                input_amount: z.custom<BN>((v) => BN.isBN(v)),
                output_amount: z.custom<BN>((v) => BN.isBN(v)),
              })
              .parse(raw);
            await this.onSwap({
              poolAddress: value.pool_id.toBase58(),
              inputMint: value.input_mint.toBase58(),
              outputMint: value.output_mint.toBase58(),
              amountIn: value.input_amount.toString(),
              amountOut: value.output_amount.toString(),
              at: tx.blockTime * 1000,
              id: `${signature}:log:${index}`,
            });
          }
        }
      }
      const keys = [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const all = [
        ...tx.transaction.message.instructions,
        ...(tx.meta.innerInstructions ?? []).flatMap(
          (item) => item.instructions,
        ),
      ];
      for (const [instructionIndex, ix] of all.entries()) {
        if (keys[ix.programIdIndex] !== program) continue;
        if (this.deployment.family === "raydium-cpmm") {
          const decoded = this.instructions.decode(ix.data, "base58");
          if (
            !decoded ||
            !["initialize", "initialize_with_permission"].includes(decoded.name)
          )
            continue;
          const definition = this.idl.instructions.find(
            (item) => item.name === decoded.name,
          );
          if (!definition) continue;
          const named = new Map(
            definition.accounts.map((item, index) => [
              item.name,
              keys[ix.accounts[index] ?? -1],
            ]),
          );
          const pool = named.get("pool_state"),
            a = named.get("token_0_mint"),
            b = named.get("token_1_mint");
          if (!pool || !a || !b)
            throw new Error("POOL_INSTRUCTION_ACCOUNTS_INVALID");
          const event = this.normalize(
            pool,
            a,
            b,
            signature,
            tx.blockTime,
            tx.version,
          );
          if (event) {
            const creator = named.get("creator");
            if (creator && this.onCreator) await this.onCreator(event, creator);
            await callback(event);
          }
        } else {
          // Anchor emit_cpi: 8 byte instruction tag, sau đó event discriminator + payload.
          const bytes = utils.bytes.bs58.decode(ix.data);
          if (
            bytes.length < 16 ||
            !Buffer.from(bytes.subarray(0, 8)).equals(eventCpiTag)
          )
            continue;
          const event = this.events.decode(
            Buffer.from(bytes.subarray(8)).toString("base64"),
          );
          if (!event) continue;
          if (captureSwaps && event.name === "Swap2Evt" && this.onSwap) {
            const raw: unknown = event.data;
            const value = z
              .object({
                lb_pair: z.custom<PublicKey>((v) => v instanceof PublicKey),
                amount_in: z.custom<BN>((v) => BN.isBN(v)),
                amount_out: z.custom<BN>((v) => BN.isBN(v)),
                swap_for_y: z.boolean(),
              })
              .parse(raw);
            if (tx.blockTime === null) complete = false;
            else
              await this.onSwap({
                poolAddress: value.lb_pair.toBase58(),
                swapForY: value.swap_for_y,
                amountIn: value.amount_in.toString(),
                amountOut: value.amount_out.toString(),
                at: tx.blockTime * 1000,
                id: `${signature}:cpi:${instructionIndex}`,
              });
            continue;
          }
          if (event.name !== "LbPairCreate") continue;
          const data: unknown = event.data;
          const value = z
            .object({
              lb_pair: z.custom<PublicKey>((v) => v instanceof PublicKey),
              token_x: z.custom<PublicKey>((v) => v instanceof PublicKey),
              token_y: z.custom<PublicKey>((v) => v instanceof PublicKey),
            })
            .parse(data);
          const normalized = this.normalize(
            value.lb_pair.toBase58(),
            value.token_x.toBase58(),
            value.token_y.toBase58(),
            signature,
            tx.blockTime,
            tx.version,
          );
          if (normalized) await callback(normalized);
        }
      }
    }

    return complete;
  }
  private normalize(
    pool: string,
    a: string,
    b: string,
    signature: string,
    blockTime: number | null,
    transactionVersion?: "legacy" | 0 | 1,
  ): TokenDiscoveryEvent | undefined {
    const q0 = this.quotes.find((q) => q.address === a),
      q1 = this.quotes.find((q) => q.address === b);
    if (Boolean(q0) === Boolean(q1)) return;
    const timestamp = blockTime === null ? Date.now() : blockTime * 1000;
    return {
      id: `rpc:${this.chainId}:${this.deployment.id}:${pool}`,
      chainId: this.chainId,
      dexId: this.deployment.id,
      poolAddress: pool,
      tokenAddress: q0 ? b : a,
      quoteTokenAddress: (q0 ?? q1)!.address,
      source: "RPC",
      timestamp,
      chainTimestamp: blockTime === null ? undefined : timestamp,
      detectedAt: Date.now(),
      transactionId: signature,
      pairClassification: "TRUSTED_QUOTE",
      rawEvent: {
        transactionVersion: transactionVersion ?? "UNKNOWN",
        programId: this.deployment.programId,
        idlHash: this.idlHash,
        mintA: a,
        mintB: b,
      },
    };
  }
}
export interface SolanaSwapObservation {
  poolAddress: string;
  inputMint?: string;
  outputMint?: string;
  swapForY?: boolean;
  amountIn: string;
  amountOut: string;
  at: number;
  id: string;
}
