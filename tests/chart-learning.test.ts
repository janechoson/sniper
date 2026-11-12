import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { ChartStore, chartId, type ChartDecision } from "../src/chart-store.js";
import { ChartLearning } from "../src/chart-learning.js";
import {
  chartFeatures,
  preEventFeatures,
  validChartCandle,
  CHART_POLICY,
  type LearningRule,
} from "../src/chart-features.js";
import { validateLearningRule, walkForward } from "../src/chart-validation.js";
import {
  CodexRuntime,
  type ReasoningResult,
  type ReasoningRuntime,
} from "../src/codex-runtime.js";
import { ExitCoordinator } from "../src/exit-coordinator.js";
import { assertStrategySell } from "../src/strategy-authority.js";
import { createTradeReplay } from "../src/chart-replay.js";
import { normalizeMarket } from "../src/gmgn.js";
import { parseMarketHistory, type Candle } from "../src/market-history.js";
import type { Intent } from "../src/domain.js";
import {
  candidate,
  info,
  MINT,
  position,
  provider,
  seedEntryAccounting,
} from "./fixtures.js";
import { candles, setup } from "./one-shot-fixtures.js";
import { lease } from "./kronos-fixtures.js";
import {
  fakeKronos,
  fixtureRpc,
  fixtureQuotes,
  fundFixtureHolding,
  fixtureDecision,
} from "./kronos-fixtures.js";
import { Engine } from "../src/engine.js";
import { compareWalkForward } from "../src/chart-backtest.js";

function history() {
  return parseMarketHistory(candles(60), {
    ...candidate(),
    createdAt: undefined,
  });
}
function rule(at = Date.now()): LearningRule {
  return {
    id: "LR-fixture",
    version: 1,
    at,
    name: "Fixture decline",
    description: "Controlled regression evidence only",
    status: "DRAFT",
    window: 15,
    behaviors: ["SLOW_RISE"],
    action: "BLOCK",
    invalidation: "Volume strengthens or price stops rising",
    supportingEventIds: [],
    contradictoryEventIds: [],
  };
}
function runtime(result: Partial<ReasoningResult> = {}): ReasoningRuntime {
  return {
    status: () => ({
      state: "READY",
      model: "FIXTURE_ONLY",
      promptVersion: "test",
    }),
    analyze: async () => ({
      action: "PASS",
      reason: "Fixture analysis",
      ruleIds: [],
      supportingEventIds: [],
      contradictoryEventIds: [],
      uncertainty: "Fixture only",
      hypothesis: null,
      ...result,
    }),
  };
}
test("Chart Learning has a single runtime.analyze call site: the manual Analyzer", () => {
  const src = join(process.cwd(), "src");
  const callsites = readdirSync(src).filter((name) => name.endsWith(".ts"))
    .filter((name) => /(?:this\.)?runtime\.analyze\s*\(/.test(readFileSync(join(src, name), "utf8")));
  assert.deepEqual(callsites, ["chart-analyzer.ts"]);
});
test("case-decision migration is additive and idempotent across Learning DB reopen", async () => {
  const { openLearningDatabase } = await import("../src/learning-database.js");
  const dir = mkdtempSync(join(tmpdir(), "chart-learning-migration-"));
  try {
    let db = openLearningDatabase(join(dir, "learning.sqlite"));
    assert.ok(db.prepare("SELECT version FROM migrations WHERE version=20").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chart_case_decisions'").get());
    db.close();
    db = openLearningDatabase(join(dir, "learning.sqlite"));
    assert.equal(db.prepare("SELECT count(*) n FROM migrations WHERE version=20").get()!.n, 1);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chart_case_decisions'").get());
    db.close();
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("chart-learning-migration-"));
    rmSync(dir, { recursive: true, force: true });
  }
});
/** Fixture-only seeded validation; production never imports or invokes this helper. */
function validated(charts: ChartStore, action: "BLOCK" | "SELL" = "BLOCK") {
  const h = history();
  // Prefix is a real deterministic input fixture, not an AI-supplied ID.
  h.candles[0]!.low = h.candles[0]!.open * 0.55;
  charts.ingest(MINT, h);
  const event = charts.events().find((e) => e.kind === "RUG_30")!;
  const r = {
    ...rule(),
    action,
    status: "VALIDATED" as const,
    supportingEventIds: [event.id],
    validationId: "fixture-validation",
  };
  charts.db.prepare("INSERT INTO chart_validations VALUES(?,?,?)").run(
    r.validationId,
    r.at,
    JSON.stringify({
      passed: true,
      ruleId: r.id,
      ruleVersion: r.version,
      definitionHash: chartId(r.behaviors, r.window, r.action),
    }),
  );
  charts.saveRule(r);
  return r;
}

test("RUG_30 boundaries, malformed candles and unfinished candles", () => {
  const store = new Store(":memory:"),
    charts = new ChartStore(store),
    h = history();
  try {
    const end = h.candles.at(-1)!.at;
    for (const [i, drop] of [29.9, 30, 45].entries()) {
      const c: Candle = {
        at: end - (3 - i) * 60000,
        open: 100,
        high: 101,
        low: 100 - drop,
        close: 90,
        volumeUsd: 12,
      };
      charts.ingest("fixture-" + i, { ...h, candles: [c] });
      assert.equal(
        charts
          .events()
          .filter((e) => e.mint === "fixture-" + i && e.kind === "RUG_30")
          .length,
        drop >= 30 ? 1 : 0,
      );
    }
    assert.equal(
      validChartCandle({ ...h.candles[0]!, open: NaN }, Date.now()),
      false,
    );
    assert.equal(
      validChartCandle({ ...h.candles[0]!, low: 0 }, Date.now()),
      false,
    );
    assert.equal(
      validChartCandle({ ...h.candles[0]!, at: Date.now() }, Date.now()),
      false,
    );
    const count = Number(
      charts.db.prepare("SELECT count(*) n FROM chart_candles").get()!.n,
    );
    charts.ingest("bad", { ...h, candles: [{ ...h.candles[0]!, open: NaN }] });
    assert.equal(
      Number(
        charts.db.prepare("SELECT count(*) n FROM chart_candles").get()!.n,
      ),
      count,
    );
  } finally {
    store.close();
  }
});
test("predictive features exclude event candle and every future candle", () => {
  const h = history(),
    at = h.candles.at(-1)!.at;
  const before = preEventFeatures(h.candles, at);
  h.candles.at(-1)!.low = 0.00001;
  h.candles.at(-1)!.close = 0.00002;
  h.candles.push({ ...h.candles[0]!, at: at + 60000, close: 1000, high: 1001 });
  assert.deepEqual(preEventFeatures(h.candles, at), before);
  assert.equal(
    chartFeatures([{ ...h.candles[0]!, volumeUsd: null }], at).volumeRatio,
    null,
  );
});
test("pre-buy Guard is read-only while explicit Learning ingestion stays immutable", async () => {
  const s = new Store(":memory:"),
    g = provider(),
    c = new ChartLearning(s, g.gmgn, runtime());
  try {
    const h = history();
    c.charts.ingest(MINT, h);
    c.charts.ingest(MINT, h);
    assert.equal(c.charts.candles(MINT).length, h.candles.length);
    const snapshotsBeforeGuard = Number(c.charts.db.prepare("SELECT count(*) n FROM chart_snapshots").get()!.n);
    const d = await c.decide(candidate(), h, normalizeMarket(info()), "demo");
    assert.equal(d.action, "PASS");
    assert.equal(d.runtime, "NOT_INVOKED_COLD_START");
    assert.equal(c.charts.decisions("demo").length, 0);
    assert.equal(Number(c.charts.db.prepare("SELECT count(*) n FROM chart_snapshots").get()!.n), snapshotsBeforeGuard);
    assert.equal(c.charts.decisions("live").length, 0);
  } finally {
    await c.stop();
    s.close();
  }
});
test("Learning Cases require a confirmed BUY and OPEN position, are idempotent per position", async () => {
  const s = new Store(":memory:"), c = new ChartLearning(s, provider().gmgn, runtime());
  try {
    const first = { ...position(), mode: "demo" as const, state: "OPEN" as const };
    s.savePosition(first);
    assert.equal(c.registerBoughtPosition(first), false);
    const intent = { id: randomUUID(), key: randomUUID(), positionId: first.id, mode: "demo" as const, mint: first.mint, side: "BUY" as const, amount: first.costLamports, provider: "JUPITER" as const, createdAt: Date.now(), expiresAt: Date.now()+60000, snapshotHash: "fixture", reason: "pending fixture" };
    s.execution({ id: "pending-"+first.id, intent, state: "PENDING_CONFIRMATION", at: Date.now() });
    assert.equal(c.registerBoughtPosition(first), false);
    s.execution({ id: "failed-"+first.id, intent: { ...intent, id: randomUUID() }, state: "FAILED", at: Date.now() });
    assert.equal(c.registerBoughtPosition(first), false);
    assert.equal(Number(c.charts.db.prepare("SELECT count(*) n FROM chart_learning_cases").get()!.n), 0);
    seedEntryAccounting(s, first);
    assert.equal(c.registerBoughtPosition(first), true);
    assert.equal(c.registerBoughtPosition(first), true);
    const second = { ...first, id: randomUUID() };
    s.savePosition(second);
    seedEntryAccounting(s, second);
    assert.equal(c.registerBoughtPosition(second), true);
    assert.equal(Number(c.charts.db.prepare("SELECT count(*) n FROM chart_learning_cases WHERE mint=?").get(first.mint)!.n), 2);
  } finally { await c.stop(); s.close(); }
});
test("no history and unvalidated/contradictory evidence PASS; invalid data is explicitly ERROR", async () => {
  const s = new Store(":memory:"),
    g = provider();
  let calls = 0;
  const r = runtime();
  r.analyze = async () => {
    calls++;
    throw Error("must not invoke");
  };
  const c = new ChartLearning(s, g.gmgn, r);
  try {
    assert.equal(
      (await c.decide(candidate(), history(), normalizeMarket(info()), "demo"))
        .action,
      "PASS",
    );
    c.charts.saveRule(rule());
    assert.equal(
      (await c.decide(candidate(), history(), normalizeMarket(info()), "demo"))
        .action,
      "PASS",
    );
    assert.equal(calls, 0);
    assert.equal(
      (
        await c.decide(
          candidate(),
          { ...history(), freshness: "UNKNOWN" },
          normalizeMarket(info()),
          "demo",
        )
      ).action,
      "ERROR",
    );
    assert.equal(
      (
        await c.decide(
          candidate(),
          { ...history(), candles: [], status: "INSUFFICIENT_DATA" },
          normalizeMarket(info()),
          "demo",
        )
      ).action,
      "ERROR",
    );
  } finally {
    await c.stop();
    s.close();
  }
});
test("validated rule BLOCK records actual references and fabricated IDs are rejected", async () => {
  const s = new Store(":memory:"),
    g = provider();
  let r = runtime();
  const c = new ChartLearning(s, g.gmgn, {
    status: () => r.status(),
    analyze: (i) => r.analyze(i),
  });
  try {
    const rule = validated(c.charts);
    r = runtime({
      action: "BLOCK",
      ruleIds: [rule.id],
      supportingEventIds: rule.supportingEventIds,
    });
    const d = await c.decide(
      candidate(),
      history(),
      normalizeMarket(info()),
      "demo",
    );
    assert.equal(d.action, "BLOCK");
    assert.equal(d.rules[0]!.id, rule.id);
    r = runtime({
      action: "BLOCK",
      ruleIds: [rule.id],
      supportingEventIds: ["NONEXISTENT"],
    });
    assert.equal(
      (await c.decide(candidate(), history(), normalizeMarket(info()), "demo"))
        .action,
      "BLOCK",
    );
    assert.throws(
      () =>
        c.charts.saveRule({
          ...rule,
          id: "bad",
          status: "DRAFT",
          supportingEventIds: ["FAKE"],
        }),
      /FABRICATED/,
    );
    assert.throws(
      () =>
        c.charts.saveRule({
          ...rule,
          id: "unvalidated",
          validationId: undefined,
        }),
      /VALIDATION_REQUIRED/,
    );
  } finally {
    await c.stop();
    s.close();
  }
});
test("guard integration runs before KRONOS and BLOCK prevents entry inference", async () => {
  const f = setup();
  try {
    f.engine.chartLearning.decide = async () =>
      ({
        action: "BLOCK",
        reason: "controlled guard fixture",
      }) as ChartDecision;
    await assert.rejects(f.engine.analyze(MINT), /TEMPORARY_RISK_CHANGE/);
    await f.engine.settleEntryEvaluations();
    assert.equal(f.calls(), 0);
    assert.equal(f.store.executions().length, 0);
    assert.equal(f.engine.attempts.current!.failedStage, "CODEX_GUARD");
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
test("PASS lets KRONOS BUY use existing executor and WAIT creates no order", async () => {
  for (const wait of [false, true]) {
    const f = setup();
    try {
      if (wait)
        f.engine.kronos.evaluateEntry = async () => ({
          strategy: "KRONOS",
          action: "WAIT",
          decisionId: randomUUID(),
          decisionAt: Date.now(),
          reason: "FIXTURE_WAIT",
          evidence: {} as never,
        });
      if (wait)
        await assert.rejects(f.engine.analyze(MINT), /TEMPORARY_RISK_CHANGE/);
      else await f.engine.analyze(MINT);
      await f.engine.settleEntryEvaluations();
      assert.equal(f.engine.chartLearning.charts.decisions("demo").length, 0);
      assert.equal(f.store.executions().length, wait ? 0 : 1);
      if (!wait)
        {
          assert.equal(f.store.executions()[0]!.evidence?.simulated, true);
          const bought = f.store.positions("demo").find((p) => p.state === "OPEN")!;
          assert.equal(f.engine.chartLearning.registerBoughtPosition(bought), true);
          assert.equal(
            f.engine.chartLearning.charts.db
              .prepare("SELECT mode,status FROM chart_learning_cases WHERE position_id=?")
              .get(bought.id)?.status,
            "OPEN",
          );
        }
      else
        assert.equal(
          Number(f.engine.chartLearning.charts.db.prepare("SELECT count(*) n FROM chart_learning_cases").get()!.n),
          0,
        );
    } finally {
      await f.engine.stop();
      f.store.close();
    }
  }
});

function codexSell(charts: ChartStore): ChartDecision {
  const p = {
    ...position(),
    mode: "demo" as const,
    strategy: "KRONOS" as const,
    quantity: "123456",
    originalQuantity: "123456",
  };
  charts.store.savePosition(p);
  const r = validated(charts, "SELL"),
    at = Date.now();
  const d: ChartDecision = {
    id: randomUUID(),
    mint: p.mint,
    mode: p.mode,
    positionId: p.id,
    accountId: charts.account(p.mode),
    at,
    action: "SELL",
    reason: "Fixture independent sell",
    snapshotId: charts.snapshot(p.mint, at, { fixture: true }),
    policy: CHART_POLICY,
    rules: [r],
    observedBehaviors: ["SLOW_RISE"],
    runtime: "FIXTURE_ONLY",
    quantity: p.quantity,
    expiresAt: at + 15000,
  };
  charts.decision(d);
  return d;
}
function sellIntent(d: ChartDecision, opportunityId: string): Intent {
  return {
    id: randomUUID(),
    key: randomUUID(),
    mode: d.mode,
    mint: d.mint,
    positionId: d.positionId!,
    provider: "JUPITER",
    side: "SELL",
    amount: d.quantity!,
    createdAt: Date.now(),
    expiresAt: Date.now() + 15000,
    reason: d.reason,
    snapshotHash: "fixture",
    strategy: "KRONOS",
    decisionSource: "CODEX",
    decisionId: d.id,
    exitAuthority: "CODEX",
    exitOpportunityId: opportunityId,
  };
}
test("CODEX SELL is independent; source HOLD/error cannot remove other source; atomic claims deduplicate", () => {
  const s = lease(new Store(":memory:")),
    charts = new ChartStore(s),
    coordinator = new ExitCoordinator(s);
  try {
    const d = codexSell(charts);
    assert.equal(coordinator.submitCodex(d), true);
    assert.equal(coordinator.submitCodex(d), false);
    let p = s.positions("demo")[0]!;
    ExitCoordinator.clearSource(p, "KRONOS");
    s.savePosition(p);
    const i = sellIntent(d, p.pendingExits![0]!.id);
    assert.doesNotThrow(() => assertStrategySell(i, p));
    assert.throws(
      () => assertStrategySell({ ...i, positionId: "WRONG" }, p),
      /MISMATCH/,
    );
    assert.throws(
      () => assertStrategySell(i, p, d.at + 16000),
      /FRESH_FULL_CODEX/,
    );
    s.claim(i);
    assert.throws(
      () => s.claim({ ...i, id: randomUUID(), key: randomUUID() }),
      /pending|open/i,
    );
    assert.equal(
      s.executions().filter((e) => e.intent.side === "SELL").length,
      1,
    );
    assert.equal(s.positions("demo")[0]!.state, "PENDING_EXIT");
    p = {
      ...p,
      pendingExits: [{ ...p.pendingExits![0]!, decisionSource: "KRONOS" }],
    };
    ExitCoordinator.clearSource(p, "CODEX");
    assert.equal(p.pendingExits!.length, 1);
  } finally {
    s.close();
  }
});
test("wrong position, stale and unpersisted Codex sells never acquire exit authority", () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s),
    coordinator = new ExitCoordinator(s);
  try {
    const d = codexSell(charts);
    assert.throws(
      () => coordinator.submitCodex({ ...d, positionId: "wrong" }),
      /WRONG_POSITION/,
    );
    assert.throws(() => coordinator.submitCodex(d, d.expiresAt + 1), /STALE/);
    assert.throws(
      () => coordinator.submitCodex({ ...d, id: "FAKE" }),
      /NOT_PERSISTED/,
    );
  } finally {
    s.close();
  }
});
test("rule versions retain contrary evidence and cannot promote on in-sample data", () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s);
  try {
    charts.ingest(MINT, history());
    const e = charts.events()[0]!;
    const r = { ...rule(), contradictoryEventIds: [e.id] };
    charts.saveRule(r);
    charts.saveRule({ ...r, version: 2, status: "VALIDATING", at: Date.now() });
    assert.equal(
      Number(
        s.db
          .prepare("SELECT count(*) n FROM chart_rule_versions WHERE version=1")
          .get()!.n,
      ),
      1,
    );
    assert.deepEqual(charts.rules()[0]!.contradictoryEventIds, [e.id]);
    assert.equal(validateLearningRule(charts, r).passed, false);
    assert.equal(
      Number(
        s.db.prepare("SELECT count(*) n FROM chart_rule_versions").get()!.n,
      ),
      2,
    );
  } finally {
    s.close();
  }
});
test("historical availability prevents newly collected old candles entering replay", async () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s);
  try {
    const h = history();
    charts.ingest(MINT, h);
    const start = h.candles[0]!.at + 60000,
      end = h.candles.at(-1)!.at + 60000;
    let calls = 0;
    const result = await walkForward(charts, MINT, start, end, async () => {
      calls++;
      return "BUY";
    });
    assert.equal(calls, 0);
    assert.equal(result.trace.length, 0);
  } finally {
    s.close();
  }
});
test("trade replay uses actual accounting and does not invent executable better points", () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s);
  try {
    const p = { ...position(), mode: "demo" as const };
    s.savePosition(p);
    seedEntryAccounting(s, p);
    charts.ingest(MINT, history());
    const replay = createTradeReplay(charts, p);
    assert.equal(replay.fills[0]!.label, "ACTUAL BUY");
    assert.equal(replay.fills[0]!.at, p.entryAt);
    assert.ok(
      replay.candidates.every(
        (c) =>
          c.classification === "INSUFFICIENT_DATA" &&
          c.estimatedExecution === null &&
          !c.influencesLearning,
      ),
    );
  } finally {
    s.close();
  }
});
test("Codex API sends no tools or private keys, validates JSON and records usage", async () => {
  let body: any;
  const response: ReasoningResult = {
    action: "PASS",
    reason: "No evidence",
    ruleIds: [],
    supportingEventIds: [],
    contradictoryEventIds: [],
    uncertainty: "Insufficient samples",
    hypothesis: null,
  };
  const transport: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init!.body));
    return new Response(
      JSON.stringify({
        status: "completed",
        usage: { total_tokens: 42 },
        output: [
          {
            content: [{ type: "output_text", text: JSON.stringify(response) }],
          },
        ],
      }),
    );
  };
  const r = new CodexRuntime("fixture-key", "fixture-model", transport);
  assert.deepEqual(await r.analyze({ price: 1 }, true), response);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(r.status().tokens, 42);
  assert.equal(JSON.stringify(body).includes("SOLANA_PRIVATE_KEY"), false);
  assert.equal(
    new CodexRuntime("", "fixture").status().state,
    "MISSING_OPENAI_API_KEY",
  );
});

for (const action of ["HOLD", "SELL", "ERROR"] as const)
  test(`independent CODEX SELL executes once when KRONOS is ${action}`, async () => {
    const s = new Store(":memory:");
    const k = fakeKronos();
    k.evaluatePosition = async () => {
      if (action === "ERROR") throw Error("FIXTURE_KRONOS_ERROR");
      return fixtureDecision(action);
    };
    const e = new Engine(s, {
      gmgn: provider().gmgn,
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      kronos: k,
      codex: runtime({ action: "HOLD" }),
    });
    try {
      const d = codexSell(e.chartLearning.charts),
        p = s.positions("demo")[0]!;
      fundFixtureHolding(s, p);
      s.record("position_market", p.mint, normalizeMarket(info()));
      e.exitCoordinator.submitCodex(d);
      (e as any).scheduleKronosPosition(p, history());
      await Promise.all((e as any).kronosJobs.values());
      assert.equal(
        s
          .positions("demo")[0]!
          .pendingExits!.some((o) => o.decisionSource === "CODEX"),
        true,
      );
      (e as any).solPrice = "100";
      (e as any).solPriceAt = Date.now();
      await Promise.all([e.processExits(), e.processExits()]);
      const executions = s.executions().filter((e) => e.intent.side === "SELL");
      assert.equal(
        executions.length,
        1,
        JSON.stringify(s.positions("demo")[0]!.attention),
      );
      assert.equal(
        executions[0]!.state,
        "CONFIRMED",
        JSON.stringify(executions[0]),
      );
      assert.equal(
        executions[0]!.intent.decisionSource,
        action === "SELL" ? "KRONOS" : "CODEX",
      );
      assert.equal(executions[0]!.evidence?.simulated, true);
      assert.equal(s.positions("demo")[0]!.state, "CLOSED");
    } finally {
      await e.stop();
      s.close();
    }
  });

test("an expired Codex SELL never suppresses a fresh KRONOS SELL", () => {
  const p = { ...position(), strategy: "KRONOS" as const };
  p.codexDecision = {
    action: "SELL",
    id: "old",
    at: Date.now() - 60000,
    expiresAt: Date.now() - 1,
    quantity: p.quantity,
    positionId: p.id,
  } as ChartDecision;
  p.kronosDecision = {
    ...fixtureDecision("SELL"),
    quantity: p.quantity,
    inputTo: Date.now(),
  };
  p.pendingExits = [
    {
      id: "c",
      kind: "STRATEGIC",
      decisionSource: "CODEX",
      decisionId: "old",
      reason: "old",
      sellBps: 10000,
      triggeredAt: Date.now() - 60000,
    },
    {
      id: "k",
      kind: "STRATEGIC",
      decisionSource: "KRONOS",
      decisionId: p.kronosDecision.decisionId,
      reason: "fresh",
      sellBps: 10000,
      triggeredAt: Date.now(),
    },
  ];
  assert.equal(ExitCoordinator.strategic(p)?.decisionSource, "KRONOS");
});

test("three walk-forward strategies use closed prefixes and explicit fees/slippage", async () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s);
  try {
    const start = Math.floor(Date.now() / 60000) * 60000 - 20 * 60000;
    for (let i = 0; i < 9; i++) {
      const c: Candle = {
        at: start + i * 60000,
        open: 10 + i,
        close: 10 + i,
        high: 10.1 + i,
        low: 9.9 + i,
        volumeUsd: 100,
      };
      const available = c.at + 60000;
      charts.ingest(
        MINT,
        { ...history(), fetchedAt: available, candles: [c] },
        null,
        available,
      );
    }
    const result = await compareWalkForward(
      charts,
      MINT,
      start,
      start + 10 * 60000,
      {
        initialCapitalUsd: 100,
        positionSizeUsd: 12,
        feePerFillUsd: 1,
        slippageBps: 0,
      },
      async (candles, at) => {
        assert.ok(candles.every((c) => c.at + 60000 <= at));
        return {
          entry: candles.length === 3 ? "BUY" : "WAIT",
          exit: candles.length === 6 ? "SELL" : "HOLD",
        };
      },
    );
    assert.equal(result.authoritative, false);
    assert.equal(result.outcomes.length, 3);
    for (const o of result.outcomes) {
      assert.equal(o.completedTrades, 1);
      assert.equal(o.netRealizedPnl, 1);
      assert.equal(o.estimatedFees, 2);
      assert.equal(o.winRate, 1);
    }
    const open = await compareWalkForward(
      charts,
      MINT,
      start,
      start + 10 * 60000,
      {
        initialCapitalUsd: 100,
        positionSizeUsd: 12,
        feePerFillUsd: 1,
        slippageBps: 100,
      },
      async (rows) => ({
        entry: rows.length === 3 ? "BUY" : "WAIT",
        exit: "HOLD",
      }),
    );
    for (const o of open.outcomes) {
      assert.equal(o.openPosition, true);
      assert.equal(o.estimatedFees, 1);
      assert.ok(o.estimatedSlippageUsd > 0);
    }
    assert.equal(
      charts.db
        .prepare("SELECT count(*) n FROM chart_validations WHERE id=?")
        .get(result.id)!.n,
      1,
    );
  } finally {
    s.close();
  }
});
test("Codex token budget survives runtime reconstruction without making a request", async () => {
  let calls = 0;
  const used = {
    day: Math.floor(Date.now() / 86400000),
    dayTokens: 250000,
    hour: Math.floor(Date.now() / 3600000),
    hourCalls: 1,
  };
  const r = new CodexRuntime(
    "fixture",
    "fixture",
    async () => {
      calls++;
      throw Error("unexpected");
    },
    { read: () => used, write: () => {} },
  );
  await assert.rejects(r.analyze({}), /RESOURCE_BUDGET/);
  assert.equal(calls, 0);
});

test("market event recovery outcomes use only completed observed candles and are deduplicated", async () => {
  const s = new Store(":memory:"),
    c = new ChartLearning(s, provider().gmgn, runtime());
  try {
    const h = history();
    h.candles[25]!.low = h.candles[25]!.open * 0.55;
    c.charts.ingest(MINT, h);
    const event = c.charts.events().find((e) => e.kind === "RUG_30")!;
    c.charts.linkCaseEvidence(readyCase(c), event.id, "EVENT", "POST_BUY_OBSERVATION", event.availableAt);
    (c as any).followups("demo", Date.now());
    (c as any).followups("demo", Date.now());
    const rows = s.db
      .prepare("SELECT payload FROM chart_event_outcomes WHERE event_id=?")
      .all(event.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => JSON.parse(String(r.payload)).coverage >= 0.8));
  } finally {
    await c.stop();
    s.close();
  }
});

function readyCase(c: ChartLearning, id = randomUUID()) {
  const at = Date.now() - 2 * 3600000, accountId = c.charts.account("demo");
  c.charts.db.prepare("INSERT INTO chart_learning_cases(position_id,mint,mode,account_id,buy_confirmed_at,learning_started_at,entry_price_usd,entry_quantity,status,entry_snapshot_id,exit_snapshot_id,realized_pnl_lamports,realized_pnl_pct,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,1,'100','CLOSED',NULL,NULL,'-10',-10,?,?,?)")
    .run(id, MINT, "demo", accountId, at, at, at, at, JSON.stringify({positionId:id,mint:MINT,mode:"demo",closedAt:at+60000,simulated:true}));
  c.charts.db.prepare("INSERT INTO chart_case_collection(case_id,status,data_quality,updated_at,payload) VALUES(?,'READY_FOR_ANALYSIS','COMPLETE',?, '{}')").run(id, at);
  c.charts.db.prepare("INSERT INTO chart_replays VALUES(?,?,?,?,?)").run(id,"demo",accountId,at,JSON.stringify({positionId:id,mint:MINT,entryAt:at,closedAt:at+60000,fills:[]}));
  return id;
}
test("closed case retains 5/15/30/60 post-SELL collection and persists real coverage", async () => {
  const s = new Store(":memory:"), g = provider(async (args) => args[1] === "kline" ? candles(60) : undefined), c = new ChartLearning(s, g.gmgn, runtime());
  try {
    const caseId = readyCase(c), now = Date.now(), closedAt = now - 5 * 60000;
    s.db.prepare("UPDATE chart_learning_cases SET payload=? WHERE position_id=?")
      .run(JSON.stringify({positionId:caseId,mint:MINT,mode:"demo",closedAt,exitPriceUsd:0.9,simulated:true}), caseId);
    s.db.prepare("UPDATE chart_case_collection SET status='POSITION_CLOSED' WHERE case_id=?").run(caseId);
    (c as any).schedulePostSell({ id: caseId, closedAt }, now);
    assert.deepEqual(s.db.prepare("SELECT horizon FROM chart_case_followups WHERE case_id=? ORDER BY horizon").all(caseId).map((r:any)=>Number(r.horizon)), [5,15,30,60]);
    s.db.prepare("UPDATE chart_case_followups SET due_at=?,next_attempt_at=? WHERE case_id=? AND horizon=5")
      .run(now - 1000, now - 1000, caseId);
    assert.equal(await (c as any).collectPostSellOne(now), true);
    const result = s.db.prepare("SELECT state,payload,error FROM chart_case_followups WHERE case_id=? AND horizon=5").get(caseId)!;
    assert.equal(result.state, "COLLECTED", String(result.error));
    assert.ok(JSON.parse(String(result.payload)).coverage >= 0.8);
    assert.equal(s.db.prepare("SELECT status FROM chart_case_collection WHERE case_id=?").get(caseId)!.status, "POST_SELL_COLLECTING");
  } finally { await c.stop(); s.close(); }
});
test("pending post-SELL follow-up survives collector reconstruction and is collected", async () => {
  const learning = new Store(":memory:"), gmgn = provider(async (args) => args[1] === "kline" ? candles(60) : undefined).gmgn;
  const first = new ChartLearning(learning, gmgn, runtime());
  const caseId = readyCase(first), now = Date.now(), closedAt = now - 5 * 60000;
  try {
    learning.db.prepare("UPDATE chart_learning_cases SET payload=? WHERE position_id=?")
      .run(JSON.stringify({positionId:caseId,mint:MINT,mode:"demo",closedAt,exitPriceUsd:0.9,simulated:true}), caseId);
    (first as any).schedulePostSell({ id: caseId, closedAt }, now);
    learning.db.prepare("UPDATE chart_case_followups SET due_at=?,next_attempt_at=? WHERE case_id=? AND horizon=5")
      .run(now - 1000, now - 1000, caseId);
  } finally { await first.stop(); }
  const restarted = new ChartLearning(learning, gmgn, runtime());
  try {
    assert.equal(await (restarted as any).collectPostSellOne(Date.now()), true);
    assert.equal(learning.db.prepare("SELECT state FROM chart_case_followups WHERE case_id=? AND horizon=5").get(caseId)!.state, "COLLECTED");
  } finally { await restarted.stop(); learning.close(); }
});
test("shared Learning DB manual analysis does not query execution tables from another database", async () => {
  const { openLearningDatabase } = await import("../src/learning-database.js");
  const db = openLearningDatabase(":memory:"), demo = new Store(":memory:", { mode: "demo", learningDb: db }), live = new Store(":memory:", { mode: "live", learningDb: db });
  const c = new ChartLearning(demo, provider().gmgn, runtime({ action: "REVIEW" }), [demo, live]);
  try {
    const caseId = readyCase(c), accepted = c.analyzer.request([caseId]);
    for (let i = 0; i < 100 && c.analyzer.job(accepted.jobs[0]!.id)?.state !== "COMPLETED"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(c.analyzer.job(accepted.jobs[0]!.id)?.state, "COMPLETED", String(c.analyzer.job(accepted.jobs[0]!.id)?.error));
    assert.equal(c.analyzer.status().mode, "MANUAL");
    assert.equal(db.prepare("SELECT count(*) n FROM chart_case_analyses WHERE case_id=?").get(caseId)!.n, 1);
  } finally { await c.stop(); demo.close(); live.close(); db.close(); }
});
test("collector pump never invokes Codex; post-BUY-only evidence cannot create a hindsight BUY rule", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  let response: Partial<ReasoningResult> = {
    action: "REVIEW",
    reason: "Fixture analysis",
    supportingEventIds: [],
    contradictoryEventIds: [],
    hypothesis: { name: "Regression hypothesis", description: "Unproven", behaviors: ["SLOW_RISE"], window: "15", action: "BLOCK", invalidation: "Volume recovers" },
  };
  const r = runtime(response);
  let analysisPayload: any;
  r.analyze = async (input) => { calls++; analysisPayload = (input as any).payload; return runtime(response).analyze({}); };
  const c = new ChartLearning(s, provider().gmgn, r);
  try {
    const h = history();
    h.candles[25]!.low = h.candles[25]!.open * 0.55;
    const snapshot = c.charts.ingest(MINT, h), event = c.charts.events().find((e) => e.kind === "RUG_30")!;
    response = { ...response, supportingEventIds: [event.id] };
    const caseId = readyCase(c);
    const snapshotId = c.charts.snapshot(MINT, Date.now(), { market: { price: 1 }, phase: "HOLD" });
    c.charts.linkCaseEvidence(caseId, snapshotId, "SNAPSHOT", "POST_BUY_OBSERVATION", Date.now());
    c.recordCaseDecision(caseId, "KRONOS", { decisionId: "hold-fixture", decisionAt: Date.now(), action: "HOLD" }, true);
    c.charts.linkCaseEvidence(caseId, event.id, "EVENT", "POST_BUY_OBSERVATION", event.availableAt);
    c.charts.linkCaseEvidence(caseId, chartId(MINT,"GMGN_KLINE_1M",h.candles[0]!.at), "CANDLE", "POST_BUY_OBSERVATION", event.availableAt);
    c.charts.job("EVENT_REVIEW", event.id, event, "demo");
    c.pump("demo", false);
    await (c as any).active;
    assert.equal(calls, 0);
    const accepted = c.analyzer.request([caseId]);
    const duplicate = c.analyzer.request([caseId]);
    assert.equal(accepted.jobs.length, 1);
    assert.equal(duplicate.jobs[0]!.id, accepted.jobs[0]!.id);
    for (let i = 0; i < 100 && c.analyzer.job(accepted.jobs[0]!.id)?.state !== "COMPLETED"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(analysisPayload.snapshots.some((item: any) => item.id === snapshotId), true);
    assert.equal(analysisPayload.decisions.some((item: any) => item.id === "hold-fixture" && item.action === "HOLD" && item.simulated), true);
    assert.equal(c.analyzer.job(accepted.jobs[0]!.id)?.state, "COMPLETED");
    assert.equal(c.charts.rules().length, 0);
    assert.equal(c.charts.db.prepare("SELECT state FROM chart_jobs WHERE kind='EVENT_REVIEW'").get()!.state, "PENDING");
    assert.ok(snapshot);
  } finally {
    await c.stop();
    s.close();
  }
});
test("manual analysis quota errors are persisted and never retry automatically", async () => {
  const s = new Store(":memory:"), r = runtime(), c = new ChartLearning(s, provider().gmgn, r);
  let calls = 0;
  r.analyze = async () => { calls++; throw Error("CODEX_RESOURCE_BUDGET_EXHAUSTED"); };
  try {
    const caseId = readyCase(c), accepted = c.analyzer.request([caseId]);
    for (let i = 0; i < 100 && c.analyzer.job(accepted.jobs[0]!.id)?.state !== "FAILED"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    assert.equal(c.analyzer.job(accepted.jobs[0]!.id)?.error, "CODEX_RESOURCE_BUDGET_EXHAUSTED");
    assert.equal(c.analyzer.job(accepted.jobs[0]!.id)?.state, "FAILED");
  } finally { await c.stop(); s.close(); }
});
test("restart marks interrupted manual analysis failed and never resumes it", async () => {
  const s = new Store(":memory:"),
    charts = new ChartStore(s);
  const c = new ChartLearning(s, provider().gmgn, runtime()), caseId = readyCase(c);
  const job = randomUUID();
  s.db.prepare("INSERT INTO chart_analysis_jobs(id,case_id,requested_by,requested_at,state,started_at,analysis_version) VALUES(?,?,?,?,'RUNNING',?,'test')")
    .run(job, caseId, "test", Date.now(), Date.now());
  await c.stop();
  const worker = new ChartLearning(s, provider().gmgn, runtime());
  try {
    const row = s.db
      .prepare("SELECT state,error FROM chart_analysis_jobs WHERE id=?")
      .get(job)!;
    assert.equal(row.state, "FAILED");
    assert.equal(row.error, "INTERRUPTED_MANUAL_REQUEST_RETRY_REQUIRED");
    assert.equal(charts.decisions("demo").length, 0);
  } finally {
    await worker.stop();
    s.close();
  }
});
