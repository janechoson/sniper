import { randomUUID } from "node:crypto";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
} from "@solana/web3.js";
import { z } from "zod";
import {
  atomicAmountSchema,
  atomicQuoteSchema,
  type SwapProvider,
  type AtomicQuoteRequest,
  type AtomicTradeQuote,
  type UnsignedSwapTransaction,
  type ProviderHealth,
} from "@sniper/core";
import {
  ResilientHttp,
  JsonRpcClient,
  solanaAccountSchema,
  accountInfo,
} from "@sniper/chains";
import { applySlippage, ratioToNumber } from "@sniper/shared";
const order = z.object({
  inAmount: atomicAmountSchema.optional(),
  outAmount: atomicAmountSchema,
  router: z.string(),
  errorCode: z.number().optional(),
  transactionVersion: z.number().optional(),
});
const instruction = z.object({
  programId: z.string(),
  accounts: z
    .array(
      z.object({
        pubkey: z.string(),
        isSigner: z.boolean(),
        isWritable: z.boolean(),
      }),
    )
    .max(128),
  data: z.string().max(20000),
});
const build = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: atomicAmountSchema,
  outAmount: atomicAmountSchema,
  otherAmountThreshold: atomicAmountSchema,
  swapMode: z.literal("ExactIn"),
  slippageBps: z.number().int(),
  computeBudgetInstructions: z.array(instruction).max(4),
  setupInstructions: z.array(instruction).max(20),
  swapInstruction: instruction,
  cleanupInstruction: instruction.nullable(),
  otherInstructions: z.array(instruction).max(20),
  tipInstruction: instruction.nullable(),
  addressesByLookupTableAddress: z
    .record(z.string(), z.array(z.string()).max(256))
    .nullable(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number().int().min(0).max(255)).length(32),
    lastValidBlockHeight: z.number().int().positive(),
  }),
});
export class JupiterSwapProvider implements SwapProvider {
  readonly id = "jupiter-v2";
  readonly chainId = "solana";
  #key?: string;
  private readonly http: ResilientHttp;
  private issued = new Map<string, AtomicTradeQuote>();
  private builds = new Map<
    string,
    { wallet: string; response: z.infer<typeof build> }
  >();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly options: {
      apiKey?: string;
      allowedPrograms: string[];
      quoteTtlMs?: number;
      maxPriorityFeeLamports?: string;
      dexes?: string[];
      fetcher?: typeof fetch;
    },
  ) {
    this.#key = options.apiKey;
    this.http = new ResilientHttp(this.id, undefined, 7000, options.fetcher);
  }
  supports(r: AtomicQuoteRequest) {
    try {
      new PublicKey(r.tokenIn);
      new PublicKey(r.tokenOut);
      return r.chainId === this.chainId && r.tokenIn !== r.tokenOut;
    } catch {
      return false;
    }
  }
  async healthCheck(): Promise<ProviderHealth> {
    return this.#key
      ? this.http.health()
      : {
          id: this.id,
          status: "DOWN",
          reasons: ["JUPITER_API_KEY_MISSING"],
          checkedAt: Date.now(),
        };
  }
  private async get(path: "order" | "build", params: Record<string, string>) {
    if (!this.#key) throw new Error("JUPITER_API_KEY_MISSING");
    const url = new URL(`https://api.jup.ag/swap/v2/${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return this.http.json(url.toString(), {
      headers: { "x-api-key": this.#key },
    });
  }
  async getQuote(r: AtomicQuoteRequest): Promise<AtomicTradeQuote> {
    if (
      !this.supports(r) ||
      !Number.isInteger(r.slippageBps) ||
      r.slippageBps < 0 ||
      r.slippageBps > 2000
    )
      throw new Error("QUOTE_REQUEST_INVALID");
    const amount = BigInt(atomicAmountSchema.parse(r.amountIn));
    if (amount <= 0n) throw new Error("ZERO_INPUT");
    if (
      (r.nativeInput &&
        r.tokenIn !== "So11111111111111111111111111111111111111112") ||
      (r.nativeOutput &&
        r.tokenOut !== "So11111111111111111111111111111111111111112")
    )
      throw new Error("NATIVE_ROUTE_MISMATCH");
    const params = {
      inputMint: r.tokenIn,
      outputMint: r.tokenOut,
      amount: r.amountIn,
      slippageBps: String(r.slippageBps),
      ...(this.options.dexes?.length
        ? { dexes: this.options.dexes.join(",") }
        : {}),
    };
    const at = Date.now();
    const buildParams = r.walletAddress
      ? {
          ...params,
          taker: r.walletAddress,
          transactionVersion: "0",
          wrapAndUnwrapSol: String(!!(r.nativeInput || r.nativeOutput)),
        }
      : undefined;
    const built = buildParams
      ? build.parse(await this.get("build", buildParams))
      : undefined;
    const response = built
      ? order.parse({ ...built, router: "metis" })
      : order.parse(await this.get("order", params));
    if (
      response.errorCode !== undefined ||
      (response.inAmount !== undefined && response.inAmount !== r.amountIn) ||
      BigInt(response.outAmount) === 0n
    )
      throw new Error("JUPITER_QUOTE_INVALID");
    let impact: number | undefined;
    const probe = amount / 10000n;
    if (probe > 0n) {
      try {
        const small = order.parse(
          buildParams
            ? {
                ...(await build.parseAsync(
                  await this.get("build", {
                    ...buildParams,
                    amount: probe.toString(),
                  }),
                )),
                router: "metis",
              }
            : await this.get("order", { ...params, amount: probe.toString() }),
        );
        if (small.errorCode === undefined && BigInt(small.outAmount) > 0n) {
          const ratio = ratioToNumber(
            BigInt(response.outAmount) * probe,
            BigInt(small.outAmount) * amount,
          );
          if (ratio !== undefined) impact = Math.max(0, (1 - ratio) * 100);
        }
      } catch {
        /* Không tự gán tác động giá bằng zero. */
      }
    }
    const quote = atomicQuoteSchema.parse({
      id: randomUUID(),
      providerId: this.id,
      chainId: this.chainId,
      tokenIn: r.tokenIn,
      tokenOut: r.tokenOut,
      amountIn: r.amountIn,
      expectedAmountOut: response.outAmount,
      minimumAmountOut: applySlippage(
        BigInt(response.outAmount),
        r.slippageBps,
      ).toString(),
      decimalsIn: r.decimalsIn,
      decimalsOut: r.decimalsOut,
      priceImpactPct: impact,
      source: "RPC",
      quality: "REAL",
      quotedAt: at,
      expiresAt: at + (this.options.quoteTtlMs ?? 10000),
      routeSummary: response.router,
      rawProviderData: { slippageBps: r.slippageBps },
      nativeInput: r.nativeInput,
      nativeOutput: r.nativeOutput,
    });
    for (const [key, value] of this.issued)
      if (value.expiresAt <= Date.now()) {
        this.issued.delete(key);
        this.builds.delete(key);
      }
    if (this.issued.size >= 500) {
      const first = this.issued.keys().next().value!;
      this.issued.delete(first);
      this.builds.delete(first);
    }
    this.issued.set(quote.id, structuredClone(quote));
    if (built && r.walletAddress)
      this.builds.set(quote.id, { wallet: r.walletAddress, response: built });
    return quote;
  }
  async buildSwap(
    input: AtomicTradeQuote,
    walletAddress: string,
  ): Promise<UnsignedSwapTransaction> {
    const q = atomicQuoteSchema.parse(input);
    const issued = this.issued.get(q.id);
    if (
      !issued ||
      JSON.stringify({ ...issued, estimatedNetworkFeeUsd: undefined }) !==
        JSON.stringify({ ...q, estimatedNetworkFeeUsd: undefined }) ||
      q.expiresAt <= Date.now()
    )
      throw new Error("UNISSUED_OR_STALE_QUOTE");
    const wallet = new PublicKey(walletAddress).toBase58();
    const data = z
      .object({ slippageBps: z.number().int() })
      .parse(q.rawProviderData);
    const cached = this.builds.get(q.id);
    const response =
      cached?.wallet === wallet
        ? cached.response
        : build.parse(
            await this.get("build", {
              inputMint: q.tokenIn,
              outputMint: q.tokenOut,
              amount: q.amountIn,
              taker: wallet,
              slippageBps: String(data.slippageBps),
              transactionVersion: "0",
              wrapAndUnwrapSol: String(!!(q.nativeInput || q.nativeOutput)),
            }),
          );
    if (
      response.inputMint !== q.tokenIn ||
      response.outputMint !== q.tokenOut ||
      response.inAmount !== q.amountIn ||
      response.slippageBps !== data.slippageBps ||
      BigInt(response.otherAmountThreshold) < BigInt(q.minimumAmountOut) ||
      response.tipInstruction
    )
      throw new Error("JUPITER_BUILD_INTENT_MISMATCH");
    const raw = [
      ...response.computeBudgetInstructions,
      ...response.setupInstructions,
      ...response.otherInstructions,
      response.swapInstruction,
      ...(response.cleanupInstruction ? [response.cleanupInstruction] : []),
    ];
    const allow = new Set(this.options.allowedPrograms);
    if (
      raw.some(
        (ix) =>
          !allow.has(ix.programId) ||
          ix.accounts.some((a) => a.isSigner && a.pubkey !== wallet),
      )
    )
      throw new Error("SOLANA_PROGRAM_OR_SIGNER_NOT_ALLOWED");
    const tables: AddressLookupTableAccount[] = [];
    for (const address of Object.keys(
      response.addressesByLookupTableAddress ?? {},
    )) {
      if (tables.length >= 20) throw new Error("TOO_MANY_LOOKUP_TABLES");
      const account = await this.rpc.request(
        "getAccountInfo",
        [address, { encoding: "base64", commitment: "confirmed" }],
        z.object({ value: solanaAccountSchema.nullable() }),
      );
      if (!account.value) throw new Error("LOOKUP_TABLE_UNAVAILABLE");
      const info = accountInfo(account.value);
      if (
        info.owner.toBase58() !== "AddressLookupTab1e1111111111111111111111111"
      )
        throw new Error("LOOKUP_TABLE_OWNER_INVALID");
      tables.push(
        new AddressLookupTableAccount({
          key: new PublicKey(address),
          state: AddressLookupTableAccount.deserialize(info.data),
        }),
      );
    }
    let instructions = raw.map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(ix.data, "base64"),
        }),
    );
    if (!allow.has(ComputeBudgetProgram.programId.toBase58()))
      throw new Error("COMPUTE_BUDGET_PROGRAM_NOT_ALLOWED");
    let units = 1400000;
    for (const ix of instructions) {
      if (
        ix.programId.equals(ComputeBudgetProgram.programId) &&
        ComputeBudgetInstruction.decodeInstructionType(ix) ===
          "SetComputeUnitLimit"
      ) {
        units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
        if (units <= 0 || units > 1400000)
          throw new Error("COMPUTE_BUDGET_LIMIT_INVALID");
      }
    }
    instructions = instructions.filter(
      (ix) =>
        !ix.programId.equals(ComputeBudgetProgram.programId) ||
        ComputeBudgetInstruction.decodeInstructionType(ix) !==
          "SetComputeUnitPrice",
    );
    instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports:
          (BigInt(this.options.maxPriorityFeeLamports ?? "0") * 1000000n) /
          BigInt(units),
      }),
    );
    const message = new TransactionMessage({
      payerKey: new PublicKey(wallet),
      recentBlockhash: new PublicKey(
        response.blockhashWithMetadata.blockhash,
      ).toBase58(),
      instructions,
    }).compileToV0Message(tables);
    if (message.header.numRequiredSignatures !== 1)
      throw new Error("SOLANA_EXTRA_SIGNER");
    const tx = new VersionedTransaction(message);
    return {
      family: "solana",
      chainId: this.chainId,
      walletAddress: wallet,
      quoteId: q.id,
      providerId: this.id,
      transactionBase64: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight: response.blockhashWithMetadata.lastValidBlockHeight,
      validUntil: q.expiresAt,
      allowedPrograms: [...allow],
    };
  }
  close() {
    this.http.close();
  }
}
