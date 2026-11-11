import { PublicKey } from "@solana/web3.js";
import { env } from "./config.js";
import { Http, deepFreeze } from "./util.js";
import { Blocked, CandidateRejected, ProviderFailure } from "./domain.js";
import { UNSIGNED_EXECUTION_TIMEOUT_MS } from "./execution-deadline.js";
import {
  orderSchema,
  validateQuote,
  type ExecutionQuote,
} from "./execution-quote.js";
import { z } from "zod";
const SOL = "So11111111111111111111111111111111111111112";
export interface QuoteSource {
  readonly health: Http["health"];
  readonly wallet: string;
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
}
/** Read-only HTTP quotes. No RPC, wallet key, simulation, signer or submission methods. */
export class JupiterQuotes implements QuoteSource {
  readonly http = new Http("JUPITER", 2200, UNSIGNED_EXECUTION_TIMEOUT_MS);
  get health() {
    return this.http.health;
  }
  constructor(
    readonly wallet = env.WALLET_PUBLIC_KEY ||
      "11111111111111111111111111111111",
  ) {}
  quoteBuy(mint: string, amount: bigint, slippageBps: number) {
    return this.quote(mint, amount, slippageBps, "BUY", true);
  }
  quoteSell(
    mint: string,
    amount: bigint,
    slippageBps: number,
    _routeOnly = true,
  ) {
    return this.quote(mint, amount, slippageBps, "SELL", true);
  }
  protected headers(): Record<string, string> {
    return env.JUPITER_API_KEY ? { "x-api-key": env.JUPITER_API_KEY } : {};
  }
  protected async quote(
    mint: string,
    amount: bigint,
    slippageBps: number,
    side: "BUY" | "SELL",
    routeOnly = false,
  ): Promise<ExecutionQuote> {
    new PublicKey(mint);
    new PublicKey(this.wallet);
    if (amount <= 0n) throw new Blocked("INVALID_SWAP_AMOUNT");
    const params = new URLSearchParams({
      inputMint: side === "BUY" ? SOL : mint,
      outputMint: side === "BUY" ? mint : SOL,
      amount: amount.toString(),
      taker: this.wallet,
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
      wallet: this.wallet,
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
      wallet: this.wallet,
      slippageBps,
      routeOnly,
    });
    return q;
  }
}
