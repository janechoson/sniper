import type { Candidate } from "../src/domain.js";
import type { LabMarket } from "../src/kronos-market.js";
import { KronosStore } from "../src/kronos-store.js";
import { tokenLogo } from "../src/token-metadata.js";
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
} from "./baseline-domain.js";
export interface LabInference {
  forecast(c: LabCandle[], at: number): Promise<Forecast>;
  stop(): void;
  status(): unknown;
}
/** Isolated serial paper state machine. No execution-capable dependencies. */
export class KronosLab {
  private active = false;
  private stopped = false;
  private enabled = false;
  private nextDiscovery = 0;
  private failures = 0;
  private error?: string;
  constructor(
    readonly store: KronosStore,
    private market: LabMarket,
    private inference: LabInference,
  ) {}
  setEnabled(value: boolean) {
    this.enabled = value;
    this.store.set("collectionEnabled", value);
  }
  async discover() {
    const rows = await this.market.discover();
    for (const c of rows.slice(0, KRONOS.maxRecords)) {
      const appearance =
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
    if (!this.enabled || this.stopped || this.active) return;
    this.active = true;
    try {
      if (
        Date.now() >= this.nextDiscovery &&
        this.store.trials().length < KRONOS.maxRecords
      ) {
        this.nextDiscovery = Date.now() + 120000;
        try {
          await this.discover();
        } catch {
          this.error = "DISCOVERY_BRIDGE_UNAVAILABLE";
        }
      }
      const t = this.store
        .trials()
        .filter(
          (t) =>
            [
              "ANALYZING",
              "WAIT_BUY",
              "OPEN",
              "SELL_DECIDED_PRICE_PENDING",
            ].includes(t.status) && t.nextAt <= Date.now(),
        )
        .sort(
          (a, b) =>
            Number(!!b.entry) - Number(!!a.entry) || a.nextAt - b.nextAt,
        )[0];
      if (t) await this.step(t.id);
    } finally {
      this.active = false;
    }
  }
  async step(id: string) {
    const t = this.store.trials().find((t) => t.id === id);
    if (!t || ["CLOSED", "REJECTED", "ERROR"].includes(t.status)) return;
    const candidate: Candidate = this.store.get("candidate:" + id) ?? {
      mint: t.mint,
      source: "gmgn:trending",
      discoveredAt: t.discoveredAt,
    };
    const stage = async (name: string, work: () => Promise<unknown>) => {
      t.gates[name] = { status: "CHECKING", at: Date.now() };
      this.store.save(t);
      try {
        const result = await work();
        t.gates[name] = { status: "PASS", at: Date.now(), evidence: result };
        return result;
      } catch (e) {
        t.gates[name] = {
          status: "FAIL",
          at: Date.now(),
          reason: e instanceof Error ? e.message : "GATE_FAILED",
        };
        throw e;
      }
    };
    try {
      // Price collection remains useful when model unavailable or decision cap reached.
      if (t.entry) {
        try {
          const price = await this.market.price(t.mint);
          if (validPrice(price, Date.now())) markPrice(t, price, Date.now());
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
      if (t.decisionCount >= KRONOS.decisionCap) {
        t.error = "DECISION_STORAGE_CAP_INFERENCE_PAUSED";
        return;
      }
      const input = t.entry
        ? await this.market.history(candidate)
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
      const forecast = await this.inference.forecast(input.candles, at);
      if (this.stopped) return;
      const decision = decideForecast(
        forecast,
        input.candles,
        !!t.entry,
        Date.now(),
      );
      t.lastInputTo = tail;
      this.store.event("KRONOS_INFERENCE_RESULT", t, {
        action: decision.action,
        terminalRangePct: decision.terminalRangePct,
        model: forecast.model,
        latencyMs: forecast.latencyMs,
      });
      if (decision.action === "PAPER_BUY" || decision.action === "PAPER_SELL") {
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
      this.store.commitDecision(t, decision);
    } catch (error) {
      this.failures++;
      t.error =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "KRONOS_UNAVAILABLE";
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
      if (t.decisionCount < KRONOS.decisionCap)
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
  status() {
    return {
      paperOnly: true,
      enabled: this.enabled,
      active: this.active,
      concurrency: 1,
      queueDepth: this.store
        .trials()
        .filter(
          (t) =>
            [
              "ANALYZING",
              "WAIT_BUY",
              "OPEN",
              "SELL_DECIDED_PRICE_PENDING",
            ].includes(t.status) && t.nextAt <= Date.now(),
        ).length,
      failures: this.failures,
      error: this.error,
      inference: this.inference.status(),
      summary: this.store.summary(),
      records: this.store.trials().map((t) => ({
        ...t,
        priceStale: !validPrice(t.current, Date.now()),
        currentPnlPct:
          validPrice(t.current, Date.now()) || t.exit ? t.pnlPct : null,
      })),
      policy: KRONOS,
      limitations: [
        "PAPER ONLY: no fees, slippage, impact or executable route guarantee",
        "Three sample paths are not calibrated confidence",
        `${KRONOS.maxRecords} records is a small experiment; no profitability claim`,
      ],
    };
  }
  reset(confirmation: string) {
    if (this.enabled || this.active) throw Error("PAUSE_AND_WAIT_BEFORE_RESET");
    this.store.reset(confirmation);
    this.nextDiscovery = 0;
  }
  async stop() {
    this.stopped = true;
    this.enabled = false;
    this.inference.stop();
    while (this.active) await new Promise((r) => setTimeout(r, 20));
  }
}
