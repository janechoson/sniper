import type { Execution, Snapshot, TokenExecutionReport } from "./domain.js";
import { Blocked } from "./domain.js";
import type { Settings } from "./config.js";
import type { Store } from "./store.js";
import type { QuoteSource } from "./jupiter-quotes.js";
import { validateQuote } from "./execution-quote.js";
import { probeExits, assertEntryExit } from "./exit-feasibility.js";
import { DemoLedger, type DemoFill } from "./demo-ledger.js";
import type { FxEvidence } from "./trade-accounting.js";
import { hash } from "./util.js";
import { requireCompatibleToken } from "./token-program.js";

/** Only quote and SQLite capabilities cross this boundary. No Solana provider or key. */
export class DemoExecutor {
  readonly ledger: DemoLedger;
  constructor(
    private store: Store,
    readonly quotes: QuoteSource,
    private readMint: (mint: string) => Promise<TokenExecutionReport>,
  ) {
    this.ledger = new DemoLedger(store.db);
  }
  async prepare(
    e: Execution,
    s: Settings,
    fx: FxEvidence | undefined,
    ensureActive: () => void = () => {},
  ): Promise<DemoFill> {
    ensureActive();
    const i = e.intent;
    if (i.mode !== "demo" || i.strategy !== "KRONOS")
      throw new Blocked("DEMO_MODE_STRATEGY_MISMATCH");
    const market =
      i.side === "BUY"
        ? this.store.latest<Snapshot>("snapshots", i.mint)?.market
        : this.store.latest<Snapshot["market"]>("position_market", i.mint);
    if (
      !market ||
      !market.priceUsd ||
      market.price.state !== "KNOWN" ||
      market.price.value <= 0 ||
      market.decimals === undefined ||
      market.at > Date.now() ||
      Date.now() - market.at > s.maxSnapshotAgeMs ||
      market.liquidity.state !== "KNOWN" ||
      market.liquidity.value <= 0
    )
      throw new Blocked("DEMO_FRESH_EXECUTABLE_MARKET_REQUIRED");
    const token = await this.readMint(i.mint);
    ensureActive();
    requireCompatibleToken(token);
    if (token.decimals !== market.decimals)
      throw new Blocked("TOKEN_DECIMALS_MISMATCH");
    const amount = BigInt(i.amount);
    if (i.side === "BUY")
      this.ledger.reserve(e.id, amount + BigInt(s.feeReserveLamports));
    const q =
      i.side === "BUY"
        ? await this.quotes.quoteBuy(i.mint, amount, s.slippagePercent * 100)
        : await this.quotes.quoteSell(
            i.mint,
            amount,
            s.slippagePercent * 100,
            true,
          );
    ensureActive();
    validateQuote(q, {
      mint: i.mint,
      side: i.side,
      amount,
      wallet: this.quotes.wallet,
      slippageBps: s.slippagePercent * 100,
      routeOnly: true,
    });
    if (
      !q.routeOnly ||
      !Number.isFinite(q.at) ||
      q.at > Date.now() ||
      q.order.priceImpactPct === undefined ||
      q.order.priceImpactPct > s.exitProbeMaxImpactPercent
    )
      throw new Blocked("DEMO_QUOTE_FEASIBILITY_UNPROVEN");
    if (i.side === "BUY") {
      e.exitFeasibility = await probeExits(
        this.quotes,
        i.mint,
        BigInt(q.order.outAmount),
        this.quotes.wallet,
        s,
        "PRE_BUY",
        q,
        () => {
          try {
            ensureActive();
            return false;
          } catch {
            return true;
          }
        },
      );
      ensureActive();
      assertEntryExit(e.exitFeasibility, q, s);
    }
    const estimatedQuotedFee =
      BigInt(q.order.signatureFeeLamports) +
      BigInt(q.order.prioritizationFeeLamports) +
      BigInt(q.order.rentFeeLamports);
    const configured = BigInt(s.paperFeeLamports),
      fee = estimatedQuotedFee > configured ? estimatedQuotedFee : configured;
    const output = BigInt(q.order.otherAmountThreshold);
    if (i.side === "SELL" && output <= fee)
      throw new Blocked("DEMO_SELL_PROCEEDS_BELOW_ESTIMATED_COST");
    if (Date.now() - market.at > s.maxSnapshotAgeMs)
      throw new Blocked("DEMO_MARKET_STALE");
    return {
      executionId: e.id,
      idempotencyKey: `demo:${i.key}`,
      attemptId: i.attemptId,
      positionId: i.positionId,
      mint: i.mint,
      side: i.side,
      requestedAmount: i.amount,
      executedAmount: i.amount,
      quantity: String(i.side === "BUY" ? output : amount),
      grossLamports: String(i.side === "BUY" ? amount : output),
      feeLamports: String(fee),
      decimals: market.decimals,
      fx,
      quoteAt: q.at,
      quoteId: hash(q),
      estimated: true,
    };
  }
}
