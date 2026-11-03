import type { Settings } from "./config.js";
import {
  Blocked,
  CandidateRejected,
  ProviderFailure,
  type Position,
} from "./domain.js";
import type {
  ExecutionQuote,
  SolanaExecutionProvider,
} from "./execution-provider.js";
import { validateQuote } from "./execution-provider.js";
import type { Store } from "./store.js";
import { hash, safeError } from "./util.js";

export interface ExitLevel {
  sellBps: number;
  amount: string;
  checkedAt: number;
  routeAvailable: boolean | null;
  expectedSolOut?: string;
  minimumSolOut?: string;
  estimatedCostLamports: string;
  netMinimumLamports?: string;
  economicallyMeaningful: boolean;
  priceImpactPercent: number | null;
  status: "HEALTHY" | "THIN" | "NO_ROUTE" | "UNKNOWN";
  reason: string;
}
export interface ExitFeasibility {
  purpose: "PRE_BUY" | "POSITION";
  mint: string;
  quantity: string;
  checkedAt: number;
  completedAt: number;
  validUntil: number;
  buyQuoteHash?: string;
  policyHash: string;
  levels: ExitLevel[];
  status: "HEALTHY" | "LIMITED" | "POOR" | "NO_EXIT" | "UNKNOWN";
  history?: Array<{ at: number; status: ExitFeasibility["status"] }>;
  basis: "QUOTE_ONLY_ESTIMATE_NOT_A_FUTURE_EXIT_GUARANTEE";
}
const policy = (s: Settings) =>
  hash({
    fee: s.exitProbeFeeBudgetLamports,
    minNet: s.exitProbeMinNetLamports,
    impact: s.exitProbeMaxImpactPercent,
    entry: s.exitProbeEntryBps,
  });
export const buyQuoteBinding = (q: ExecutionQuote) =>
  hash({
    mint: q.mint,
    wallet: q.wallet,
    amount: q.amount,
    output: q.order.outAmount,
    minimum: q.order.otherAmountThreshold,
    at: q.at,
    requestId: q.order.requestId,
  });
export async function probeExits(
  provider: SolanaExecutionProvider,
  mint: string,
  quantity: bigint,
  wallet: string,
  s: Settings,
  purpose: ExitFeasibility["purpose"],
  buy?: ExecutionQuote,
  shouldYield = () => false,
): Promise<ExitFeasibility> {
  const checkedAt = Date.now(),
    levels: ExitLevel[] = [];
  for (const sellBps of [2000, 5000, 10000]) {
    const amount = (quantity * BigInt(sellBps)) / 10000n;
    const level: ExitLevel = {
      sellBps,
      amount: String(amount),
      checkedAt: Date.now(),
      routeAvailable: null,
      estimatedCostLamports: s.exitProbeFeeBudgetLamports,
      economicallyMeaningful: false,
      priceImpactPercent: null,
      status: "UNKNOWN",
      reason: "INSUFFICIENT_EVIDENCE",
    };
    try {
      if (amount <= 0n) {
        level.reason = "BELOW_ONE_ATOMIC_UNIT";
        levels.push(level);
        continue;
      }
      if (shouldYield()) {
        level.reason = "EXECUTION_PRIORITY_YIELD";
        levels.push(level);
        continue;
      }
      const q = await provider.quoteSell(
        mint,
        amount,
        s.slippagePercent * 100,
        true,
      );
      validateQuote(q, {
        mint,
        side: "SELL",
        amount,
        wallet,
        slippageBps: s.slippagePercent * 100,
        routeOnly: true,
      });
      const quoted = BigInt(
          q.order.signatureFeeLamports +
            q.order.prioritizationFeeLamports +
            q.order.rentFeeLamports,
        ),
        budget = BigInt(s.exitProbeFeeBudgetLamports);
      const fee = quoted > budget ? quoted : budget;
      const net = BigInt(q.order.otherAmountThreshold) - fee;
      const impact =
        typeof q.order.priceImpactPct === "number" &&
        Number.isFinite(q.order.priceImpactPct)
          ? q.order.priceImpactPct
          : null;
      Object.assign(level, {
        checkedAt: q.at,
        routeAvailable: true,
        expectedSolOut: q.order.outAmount,
        minimumSolOut: q.order.otherAmountThreshold,
        estimatedCostLamports: String(fee),
        netMinimumLamports: String(net),
        priceImpactPercent: impact,
      });
      level.economicallyMeaningful =
        net >= BigInt(s.exitProbeMinNetLamports) &&
        (impact === null || impact <= s.exitProbeMaxImpactPercent);
      level.status = level.economicallyMeaningful ? "HEALTHY" : "THIN";
      level.reason =
        net < BigInt(s.exitProbeMinNetLamports)
          ? "EXIT_OUTPUT_BELOW_COST_AND_MARGIN"
          : impact !== null && impact > s.exitProbeMaxImpactPercent
            ? "EXIT_PRICE_IMPACT_HIGH"
            : "POSITIVE_CONSERVATIVE_NET_ESTIMATE";
    } catch (error) {
      if (
        error instanceof Blocked &&
        !(error instanceof CandidateRejected) &&
        !(error instanceof ProviderFailure)
      )
        throw error;
      if (error instanceof ProviderFailure && !error.retryable) throw error;
      level.reason = safeError(error);
      if (
        error instanceof CandidateRejected &&
        ["NO_SELL_ROUTE", "TOKEN_NO_ROUTE"].includes(error.code)
      ) {
        level.status = "NO_ROUTE";
        level.routeAvailable = false;
      }
    }
    levels.push(level);
  }
  const healthy = levels.filter((l) => l.status === "HEALTHY").length;
  return {
    purpose,
    mint,
    quantity: String(quantity),
    checkedAt,
    completedAt: Date.now(),
    validUntil:
      checkedAt +
      (purpose === "PRE_BUY" ? s.exitProbeMaxAgeMs : s.positionExitProbeMs * 2),
    buyQuoteHash: buy ? buyQuoteBinding(buy) : undefined,
    policyHash: policy(s),
    levels,
    status:
      healthy === 3
        ? "HEALTHY"
        : healthy > 0
          ? "LIMITED"
          : levels.every((l) => l.status === "NO_ROUTE")
            ? "NO_EXIT"
            : levels.some((l) => l.routeAvailable)
              ? "POOR"
              : "UNKNOWN",
    basis: "QUOTE_ONLY_ESTIMATE_NOT_A_FUTURE_EXIT_GUARANTEE",
  };
}
export function assertEntryExit(
  result: ExitFeasibility,
  q: ExecutionQuote,
  s: Settings,
  now = Date.now(),
) {
  if (
    result.purpose !== "PRE_BUY" ||
    result.mint !== q.mint ||
    result.quantity !== q.order.outAmount ||
    result.buyQuoteHash !== buyQuoteBinding(q) ||
    result.policyHash !== policy(s) ||
    now - result.checkedAt > s.exitProbeMaxAgeMs ||
    result.checkedAt < q.at
  )
    throw new CandidateRejected("EXIT_FEASIBILITY_STALE", {
      mint: q.mint,
      reason: "BUY_QUOTE_OR_EXIT_PROBE_CHANGED",
    });
  if (
    !result.levels.some(
      (l) =>
        s.exitProbeEntryBps.includes(l.sellBps) && l.economicallyMeaningful,
    )
  )
    throw new CandidateRejected(
      result.status === "NO_EXIT"
        ? "NO_PREBUY_EXIT_ROUTE"
        : result.status === "UNKNOWN"
          ? "EXIT_FEASIBILITY_UNAVAILABLE"
          : "EXIT_LIQUIDITY_TOO_THIN",
      { mint: q.mint, reason: result.status },
    );
}
export function exitLiquidityContext(
  p: Position,
  s: Settings,
  now = Date.now(),
) {
  const r = p.exitLiquidity;
  return r
    ? {
        ...r,
        stale:
          r.quantity !== p.quantity ||
          now - r.checkedAt > s.positionExitProbeMs * 2,
        ageMs: now - r.checkedAt,
      }
    : null;
}
export class ExitLiquidityMonitor {
  private queue = new Map<
    string,
    Pick<Position, "id" | "mint" | "quantity" | "mode">
  >();
  private due = new Map<string, number>();
  private active = false;
  private stopped = false;
  private next = 0;
  readonly counters = { checks: 0, probes: 0, failures: 0, discarded: 0 };
  private starts: number[] = [];
  constructor(
    private provider: SolanaExecutionProvider,
    private store: Store,
    private settings: () => Settings,
    private wallet: () => string,
    private busy: () => boolean,
    private changed: (p: Position) => void = () => {},
  ) {}
  schedule(p: Position, now = Date.now()) {
    if (
      p.dismissal ||
      this.stopped ||
      this.queue.has(p.id) ||
      now < (this.due.get(p.id) ?? 0) ||
      this.queue.size >= 100
    )
      return;
    this.due.set(p.id, now + this.settings().positionExitProbeMs);
    this.queue.set(p.id, {
      id: p.id,
      mint: p.mint,
      quantity: p.quantity,
      mode: p.mode,
    });
  }
  async pump(now = Date.now()) {
    if (this.active || this.stopped || this.busy() || now < this.next) return;
    const job = this.queue.values().next().value;
    if (!job) return;
    this.queue.delete(job.id);
    this.active = true;
    this.next = now + this.settings().positionExitProbeSpacingMs;
    try {
      const current = this.store
        .positions(job.mode)
        .find((p) => p.id === job.id);
      if (
        !current ||
        current.dismissal ||
        current.state !== "OPEN" ||
        current.quantity !== job.quantity
      ) {
        this.counters.discarded++;
        return;
      }
      this.starts = [...this.starts.filter((t) => now - t < 60000), now].slice(
        -120,
      );
      const r = await probeExits(
        this.provider,
        job.mint,
        BigInt(job.quantity),
        this.wallet(),
        this.settings(),
        "POSITION",
        undefined,
        () => this.busy() || !this.store.positionManaged(job.id, job.mode),
      );
      this.counters.checks++;
      this.counters.probes += r.levels.filter(
        (l) =>
          l.reason !== "EXECUTION_PRIORITY_YIELD" &&
          l.reason !== "BELOW_ONE_ATOMIC_UNIT",
      ).length;
      const p = this.store.positions(job.mode).find((p) => p.id === job.id);
      if (
        !p ||
        p.dismissal ||
        p.quantity !== job.quantity ||
        p.state !== "OPEN"
      ) {
        this.counters.discarded++;
        return;
      }
      r.history = [
        ...(p.exitLiquidity?.history ?? []),
        ...(p.exitLiquidity?.status !== r.status
          ? [{ at: r.checkedAt, status: r.status }]
          : []),
      ].slice(-12);
      p.exitLiquidity = r;
      this.store.savePosition(p);
      this.changed(p);
    } catch {
      this.counters.failures++;
    } finally {
      this.active = false;
    }
  }
  prune(ids: string[]) {
    const keep = new Set(ids);
    for (const key of this.due.keys())
      if (!keep.has(key)) {
        this.due.delete(key);
        this.queue.delete(key);
      }
  }
  status() {
    return {
      ...this.counters,
      queued: this.queue.size,
      active: this.active,
      checksLastMinute: this.starts.filter((t) => Date.now() - t < 60000)
        .length,
    };
  }
  async stop() {
    this.stopped = true;
    this.queue.clear();
    while (this.active) await new Promise<void>((r) => setTimeout(r, 20));
  }
}
