import type { Candidate } from "./domain.js";
import type { LabMarket } from "./kronos-market.js";
import { KronosStore } from "./kronos-store.js";
import { tokenLogo } from "./token-metadata.js";
import type { LiveExecutor } from "./live-executor.js";
import {
  KRONOS,
  decideForecast,
  markPrice,
  paperFill,
  validPrice,
  validateCandles,
  type Forecast,
  type LabCandle,
  type LabDecision,
} from "./kronos-domain.js";
export interface LabInference {
  forecast(c: LabCandle[], at: number): Promise<Forecast>;
  stop(): void;
  status(): unknown;
}
/** Serial strategy lane; optional Node execution adapter never reaches the Python model. */
export class KronosLab {
  private active = false;
  private stopped = false;
  private enabled = false;
  private nextDiscovery = 0;
  private discoveryPending?: Promise<void>;
  private failures = 0;
  private error?: string;
  private currentId?: string;
  private dryRun = false;
  constructor(
    readonly store: KronosStore,
    private market: LabMarket,
    private inference: LabInference,
    readonly mode: "PAPER" | "LIVE" = "PAPER",
    private execution?: LiveExecutor,
  ) {}
  attachExecution(execution: LiveExecutor, dryRun = false) {
    this.execution = execution;
    this.dryRun = dryRun;
  }
  assertLiveAuthority() {
    if (this.mode !== "LIVE" || !this.enabled || this.stopped)
      throw Error("LIVE_NOT_ACTIVE");
  }
  setEnabled(value: boolean) {
    this.enabled = value;
    this.store.set("collectionEnabled", value);
  }
  async discover() {
    const rows = await this.market.discover();
    for (const c of rows) {
      const appearance =
        (this.mode === "LIVE" ? "LIVE:" : "") +
        c.mint +
        ":" +
        (c.discovery?.trending?.sequenceStartedAt ?? c.discoveredAt);
      const trial = this.store.add({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        logo: tokenLogo(c),
        discoveredAt: c.discoveredAt,
        appearance,
        mode: this.mode,
      });
      if (trial) {
        this.store.set("candidate:" + trial.id, {
          mint: c.mint,
          symbol: c.symbol,
          name: c.name,
          logo: tokenLogo(c),
          source: c.source,
          createdAt: c.createdAt,
          discoveredAt: c.discoveredAt,
          discovery: c.discovery,
        });
        this.store.event("KRONOS_DISCOVERY", trial, {
          source: trial.source,
          appearance,
        });
      }
    }
  }
  async tick() {
    if (this.execution) await this.execution.recover(false);
    if (!this.enabled || this.stopped || this.active) return;
    this.active = true;
    try {
      if (Date.now() >= this.nextDiscovery && !this.discoveryPending) {
        this.nextDiscovery = Date.now() + 120000;
        this.discoveryPending = this.discover()
          .then(() => {
            this.error = undefined;
          })
          .catch(() => {
            this.error = "DISCOVERY_UNAVAILABLE";
          })
          .finally(() => {
            this.discoveryPending = undefined;
          });
      }
      const t =
        this.store.due(true, Date.now(), this.mode) ??
        this.store.due(false, Date.now(), this.mode);
      if (t) await this.step(t.id);
    } finally {
      this.active = false;
    }
  }
  async step(id: string) {
    const t = this.store.trial(id);
    if (!t || ["CLOSED", "REJECTED", "ERROR"].includes(t.status)) return;
    if ((t.mode ?? "PAPER") !== this.mode) return;
    if (
      this.mode === "LIVE" &&
      (!this.execution || this.execution.ledger.pending().length)
    )
      return;
    const executionStage =
      this.mode === "LIVE" ? "EXECUTION" : "PAPER_DECISION";
    this.currentId = id;
    t.checkedAt ??= Date.now();
    t.evaluation = {
      at: Date.now(),
      monitor: !!t.entry,
      stages: Object.fromEntries(
        [
          "CHEAP_FILTER",
          "SECURITY",
          "COMPATIBILITY",
          "HISTORY",
          "CAPITAL_FLOW",
          "KRONOS",
          executionStage,
        ].map((k) => [
          k,
          t.entry &&
          [
            "CHEAP_FILTER",
            "SECURITY",
            "COMPATIBILITY",
            "CAPITAL_FLOW",
          ].includes(k)
            ? "SKIPPED"
            : "PENDING",
        ]),
      ),
    };
    this.store.save(t);
    this.store.event("KRONOS_ATTEMPT_START", t, { monitor: !!t.entry });
    const candidate: Candidate = this.store.get("candidate:" + id) ?? {
      mint: t.mint,
      source: "gmgn:trending",
      discoveredAt: t.discoveredAt,
    };
    const stage = async <T>(name: string, work: () => Promise<T>) => {
      const displayStage = name === "MONITOR_HISTORY" ? "HISTORY" : name;
      t.evaluation!.stages[displayStage] = "CHECKING";
      t.gates[name] = { status: "CHECKING", at: Date.now() };
      this.store.save(t);
      this.store.event("KRONOS_STAGE_CHECKING", t, { stage: name });
      try {
        const result = await work();
        t.gates[name] = { status: "PASS", at: Date.now(), evidence: result };
        (t.gatePasses ??= {})[name] = true;
        t.evaluation!.stages[displayStage] = "PASS";
        this.store.save(t);
        this.store.event("KRONOS_STAGE_PASS", t, { stage: name });
        return result;
      } catch (e) {
        t.evaluation!.stages[displayStage] = "FAIL";
        t.gates[name] = {
          status: "FAIL",
          at: Date.now(),
          reason: e instanceof Error ? e.message : "GATE_FAILED",
        };
        this.store.save(t);
        this.store.event("KRONOS_STAGE_FAIL", t, {
          stage: name,
          reason: t.gates[name]!.reason,
        });
        throw e;
      }
    };
    let executionAttempt = false;
    try {
      // Price collection remains useful when model unavailable or decision cap reached.
      if (t.entry) {
        try {
          const price = await this.market.price(t.mint);
          if (validPrice(price, Date.now())) {
            if (this.mode === "LIVE") {
              t.current = price;
              this.execution!.mark(t, price.value, price.observedAt);
            } else markPrice(t, price, Date.now());
          }
        } catch {
          t.error = "CURRENT_PRICE_UNAVAILABLE";
        }
      }
      if (
        t.status === "SELL_DECIDED_PRICE_PENDING" &&
        t.latest?.action === "PAPER_SELL"
      ) {
        if (Date.now() - t.latest.at <= KRONOS.priceMaxAgeMs) {
          const price = await this.market.price(t.mint);
          paperFill(t, t.latest, price, Date.now());
          t.evaluation!.stages.PAPER_DECISION = t.exit ? "PASS" : "PENDING";
          if (t.exit)
            this.store.event("KRONOS_PAPER_SELL", t, {
              price: t.exit,
              pnlPct: t.pnlPct,
            });
          return;
        }
        t.status = "OPEN";
        t.error = "SELL_DECISION_EXPIRED_REINFER_REQUIRED";
      }
      const input = t.entry
        ? await stage("MONITOR_HISTORY", () => this.market.history(candidate))
        : await this.market.prepare(candidate, stage);
      const at = Date.now();
      validateCandles(input.candles, at);
      t.evidence = input.evidence;
      const tail = input.candles.at(-1)!.at + 60000;
      if (t.lastInputTo === tail) return;
      this.store.event("KRONOS_INFERENCE_START", t, {
        inputFrom: input.candles[0]!.at,
        inputTo: tail,
        decisionAt: at,
      });
      t.gates.KRONOS = { status: "CHECKING", at: Date.now() };
      t.evaluation!.stages.KRONOS = "CHECKING";
      this.store.save(t);
      const forecast = await this.inference.forecast(input.candles, at);
      if (this.stopped) return;
      const decision = decideForecast(
        forecast,
        input.candles,
        !!t.entry,
        Date.now(),
      );
      t.gates.KRONOS = { status: "PASS", at: Date.now() };
      t.evaluation!.stages.KRONOS = "PASS";
      t.evaluation!.stages[executionStage] = "CHECKING";
      this.store.save(t);
      t.lastInputTo = tail;
      this.store.event("KRONOS_INFERENCE_RESULT", t, {
        action: decision.action,
        terminalRangePct: decision.terminalRangePct,
        model: forecast.model,
        latencyMs: forecast.latencyMs,
      });
      if (decision.action === "PAPER_BUY" || decision.action === "PAPER_SELL") {
        if (this.mode === "LIVE") {
          // Model outputs retain baseline enum values; LIVE never invokes paperFill.
          this.store.commitDecision(t, decision);
          executionAttempt = true;
          const result = await this.execution!.execute(
            t,
            decision,
            this.dryRun,
          );
          Object.assign(t, this.store.trial(t.id));
          t.execution = {
            id: result.id,
            state: result.state,
            side: result.intent.side,
            signature: result.signature,
            error: result.error,
          };
          t.evaluation!.stages.EXECUTION =
            result.state === "RECONCILED"
              ? "PASS"
              : result.state === "FAILED"
                ? "FAIL"
                : "PENDING";
          this.store.save(t);
          return;
        }
        let price;
        try {
          price = await this.market.price(t.mint);
        } catch {
          /* explicit pending/unavailable fill */
        }
        if (
          decision.action === "PAPER_BUY" &&
          (!t.gates.SECURITY ||
            Date.now() - t.gates.SECURITY.at > KRONOS.priceMaxAgeMs)
        )
          throw Error("PRE_BUY_ELIGIBILITY_EXPIRED");
        paperFill(t, decision, price, Date.now());
        if (
          (decision.action === "PAPER_BUY" && t.entry) ||
          (decision.action === "PAPER_SELL" && t.exit)
        )
          this.store.event("KRONOS_" + decision.action, t, {
            price: decision.action === "PAPER_BUY" ? t.entry : t.exit,
            pnlPct: t.pnlPct,
          });
      } else {
        if (!t.entry) t.status = "WAIT_BUY";
        this.store.event(
          decision.action === "HOLD" ? "KRONOS_HOLD" : "KRONOS_WAIT",
          t,
          { reason: decision.reason },
        );
      }
      t.updatedAt = Date.now();
      t.gates.PAPER_DECISION = {
        status: t.status === "ERROR" ? "FAIL" : "PASS",
        at: Date.now(),
      };
      t.evaluation!.stages.PAPER_DECISION = t.gates.PAPER_DECISION.status;
      this.store.commitDecision(t, decision);
    } catch (error) {
      if (executionAttempt) {
        const saved = this.store.trial(t.id);
        t.execution = saved?.execution;
        t.live = saved?.live;
        t.error =
          error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
            ? error.message
            : "EXECUTION_FAILED";
        t.evaluation!.error = t.error;
        t.evaluation!.stages.EXECUTION = "FAIL";
        if (!t.entry && !t.execution?.signature) t.status = "ERROR";
        this.store.event("KRONOS_EXECUTION_FAILED", t, { reason: t.error });
        // Keep the actual model BUY/SELL decision; execution failure is not model unavailability.
        return;
      }
      this.failures++;
      t.error =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "KRONOS_UNAVAILABLE";
      t.evaluation!.error = t.error;
      const gateFailure = Object.values(t.gates).some(
        (g) => g.status === "FAIL",
      );
      if (!t.entry) t.status = gateFailure ? "REJECTED" : "ERROR";
      const failure: LabDecision = {
        at: Date.now(),
        inputAt: Date.now(),
        action: "UNAVAILABLE",
        reason: t.error,
      };
      if (t.gates.KRONOS?.status === "CHECKING")
        t.gates.KRONOS = { status: "FAIL", at: Date.now(), reason: t.error };
      if (t.evaluation!.stages.KRONOS === "CHECKING")
        t.evaluation!.stages.KRONOS = "FAIL";
      this.store.commitDecision(t, failure);
      this.store.event(
        gateFailure ? "KRONOS_SECURITY_REJECT" : "KRONOS_ERROR",
        t,
        { reason: t.error },
      );
    } finally {
      t.nextAt =
        Date.now() +
        (t.status === "SELL_DECIDED_PRICE_PENDING"
          ? 5000
          : KRONOS.inferenceIntervalMs);
      t.updatedAt = Date.now();
      this.store.save(t);
    }
  }
  private present(t: import("./kronos-domain.js").LabTrial) {
    return {
      ...t,
      priceStale: !validPrice(t.current, Date.now()),
      currentPnlPct:
        validPrice(t.current, Date.now()) || t.exit ? t.pnlPct : null,
    };
  }
  overview() {
    const current = this.currentId
      ? this.store.trial(this.currentId)
      : this.store.page({ limit: 1 }).rows[0];
    const positions = this.store.page({ openOnly: true, limit: 50 });
    return {
      paperOnly: this.mode === "PAPER",
      tradingMode: this.mode,
      execution: this.execution?.status(),
      dryRun: this.dryRun,
      enabled: this.enabled,
      active: this.active,
      concurrency: 1,
      queueDepth: this.store.queueDepth(),
      current: current ? this.present(current) : null,
      candidate: current ? this.store.get("candidate:" + current.id) : null,
      queue: this.store.page({ activeOnly: true, limit: 8 }).rows.map((t) => ({
        id: t.id,
        mint: t.mint,
        symbol: t.symbol,
        logo: t.logo,
      })),
      positions: {
        ...positions,
        rows: positions.rows.map((t) => this.present(t)),
      },
      logs: this.store.events(current?.id, undefined, 100),
      inference: this.inference.status(),
      error: this.error,
      recordsCount: this.store.count(),
      failures: this.failures,
    };
  }
  status() {
    return {
      paperOnly: this.mode === "PAPER",
      tradingMode: this.mode,
      enabled: this.enabled,
      active: this.active,
      concurrency: 1,
      queueDepth: this.store.queueDepth(),
      failures: this.failures,
      error: this.error,
      inference: this.inference.status(),
      summary: this.store.summary(),
      records: this.store.page({ limit: 50 }).rows.map((t) => this.present(t)),
      policy: KRONOS,
      limitations: [
        this.mode === "PAPER"
          ? "PAPER ONLY: no fees, slippage, impact or executable route guarantee"
          : "LIVE: reconciled SOL economics; GMGN mark is an estimate; missing accounting remains UNKNOWN",
        "Three sample paths are not calibrated confidence",
      ],
    };
  }
  reset(confirmation: string) {
    if (this.enabled || this.active) throw Error("PAUSE_AND_WAIT_BEFORE_RESET");
    if (this.discoveryPending) throw Error("DISCOVERY_STILL_ACTIVE");
    this.store.reset(confirmation);
    this.nextDiscovery = 0;
  }
  async stop() {
    this.stopped = true;
    this.enabled = false;
    this.inference.stop();
    while (this.active) await new Promise((r) => setTimeout(r, 20));
    await this.discoveryPending;
  }
}
