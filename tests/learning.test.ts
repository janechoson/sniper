import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { TradingMemory } from "../src/trading-memory.js";
import {
  pnl,
  excursions,
  OutcomeAnalyzer,
  learningSettingsSchema,
  similarity,
  featureVector,
  recencyWeight,
  sampleConfidence,
} from "../src/learning.js";
import { completedFixture, typedJevFixture } from "./learning-fixtures.js";
import { snapshot, settings, MINT } from "./fixtures.js";
import { Jev } from "../src/jev.js";
import { RiskEngine } from "../src/risk.js";
import { known } from "../src/domain.js";
import { env } from "../src/config.js";
const config = learningSettingsSchema.parse({});
test("actual SOL deltas produce fee-inclusive WIN LOSS BREAKEVEN without subtracting network fee twice", () => {
  assert.deepEqual(pnl(-1_005_000n, [1_010_000n]), {
    netLamports: "5000",
    netPnlPercent: 0.4975,
    result: "WIN",
  });
  assert.equal(pnl(-100n, [90n]).result, "LOSS");
  assert.equal(pnl(-100n, [100n]).result, "BREAKEVEN");
  assert.equal(pnl(-100n, [40n, 60n], 5n).netLamports, "-5");
  assert.throws(() => pnl(0n, [1n]));
});
test("MFE/MAE include zero and final return; good entry bad exit differs from weak entry", () => {
  const range = excursions([5, 18, 41, 22, -4, -20]);
  assert.deepEqual(range, { mfePercent: 41, maePercent: -20 });
  const analyzer = new OutcomeAnalyzer(config);
  const good = analyzer.classify({
    netPnlPercent: -20,
    mfePercent: 45,
    maePercent: -20,
    coverage: "SAMPLED",
    exitReasons: ["STOP_LOSS"],
  });
  assert.equal(good.entryQuality, "GOOD");
  assert.equal(good.exitQuality, "POOR");
  assert.ok(good.lessons.includes("PROFIT_WAS_AVAILABLE_BUT_NOT_CAPTURED"));
  assert.ok(
    analyzer
      .classify({
        netPnlPercent: -30,
        mfePercent: 3,
        maePercent: -35,
        coverage: "SAMPLED",
        exitReasons: ["STOP_LOSS"],
      })
      .classifications.includes("BAD_ENTRY"),
  );
  assert.deepEqual(
    analyzer.classify({
      netPnlPercent: -30,
      mfePercent: 0,
      maePercent: -30,
      coverage: "EXIT_ONLY",
      exitReasons: [],
    }).classifications,
    ["UNKNOWN"],
  );
});
test("feature normalization preserves missing fields and similarity requires shared coverage", () => {
  const a = featureVector(snapshot());
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity({ a: null, b: null }, { a: null, b: null }, 2), 0);
  assert.equal(similarity({ a: 0, b: 0 }, { a: 1, b: 1 }, 2), 0);
  assert.equal(
    similarity({ a: 0, b: null, c: null }, { a: 0, b: 0, c: 0 }, 2),
    0,
  );
  const s = snapshot();
  s.intelligence.holders.count = { state: "UNKNOWN", reason: "missing" };
  assert.equal(featureVector(s).holders, null);
});
test("new recovery and unrecovered outcomes retain negative MAE without generating STOP_LOSS", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const recovered = completedFixture(memory, {
      netPercent: 80,
      observations: [-40, 120],
      exitReason: "Take profit",
    });
    const recovery = memory.outcome(recovered.position.id)!;
    assert.equal(recovery.maePercent, -40);
    assert.equal(recovery.mfePercent, 120);
    assert.deepEqual(recovery.exitReasons, ["TAKE_PROFIT"]);
    const unrecovered = completedFixture(memory, {
      netPercent: -70,
      observations: [-35, -70],
      exitReason: "Maximum holding time reached",
    });
    const loss = memory.outcome(unrecovered.position.id)!;
    assert.equal(loss.maePercent, -70);
    assert.equal(loss.mfePercent, 0);
    assert.deepEqual(loss.exitReasons, ["MAX_HOLDING"]);
  } finally {
    store.close();
  }
});
test("sample confidence and half-life weighting are configurable and degrade old history", () => {
  for (const [n, c] of [
    [0, "INSUFFICIENT"],
    [19, "INSUFFICIENT"],
    [20, "LOW"],
    [49, "LOW"],
    [50, "MEDIUM"],
    [100, "HIGH"],
  ] as const)
    assert.equal(sampleConfidence(n), c);
  assert.equal(sampleConfidence(4, [3, 5, 8]), "LOW");
  assert.equal(recencyWeight(0, 14 * 86400000, 14), 0.5);
  assert.equal(recencyWeight(100, 99, 14), 0);
  assert.throws(() =>
    learningSettingsSchema.parse({ confidenceThresholds: [50, 20, 100] }),
  );
});
test("immutable snapshots preserve original decisions, quote and evidence; rebuild cannot change them", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const t = completedFixture(memory, {
      netPercent: -20,
      observations: [5, 45],
      exitReason: "Stop loss",
    });
    const before = JSON.stringify(memory.detail(t.position.id));
    assert.equal(memory.outcome(t.position.id)?.netPnlPercent, -20);
    assert.ok(
      memory
        .outcome(t.position.id)
        ?.classifications.includes("GOOD_ENTRY_BAD_EXIT"),
    );
    assert.throws(
      () =>
        store.db
          .prepare("UPDATE trade_learning_samples SET payload='{}'")
          .run(),
      /Immutable/,
    );
    assert.throws(
      () => store.db.prepare("DELETE FROM trade_observations").run(),
      /Immutable/,
    );
    assert.equal(memory.rebuild().outcomes, 1);
    assert.equal(JSON.stringify(memory.detail(t.position.id)), before);
    assert.equal(memory.rebuild().outcomes, 1);
    assert.equal(memory.report("paper").confidence, "INSUFFICIENT");
    assert.equal(
      Number(
        store.db.prepare("SELECT count(*) n FROM learning_patterns").get()!.n,
      ) > 0,
      true,
    );
  } finally {
    store.close();
  }
});
test("execution failure samples remain auditable but never enter strategy aggregation", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const t = completedFixture(memory, { fail: true, netPercent: -10 });
    const outcome = memory.outcome(t.position.id)!;
    assert.ok(outcome.classifications.includes("EXECUTION_FAILURE"));
    assert.equal(outcome.eligibleForStrategy, false);
    assert.equal(memory.report("paper").completedTrades, 1);
    assert.equal(memory.report("paper").similarTrades, 0);
    assert.equal(memory.report("paper").executionFailures, 1);
  } finally {
    store.close();
  }
});
test("zero history returns INSUFFICIENT with no fabricated statistics or future current-token fields", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const h = memory.retrieve(snapshot(), "live"),
      input = memory.jevContext(
        {
          market: snapshot().market,
          finalPnl: 100,
          mfe: 200,
          exitReason: "FUTURE",
          futurePrice: 30,
        },
        h,
      );
    assert.equal(h.similarTrades, 0);
    assert.equal(h.winRate, null);
    assert.equal(input.historicalExperience.confidence, "INSUFFICIENT");
    assert.equal(input.historicalExperience.usableForDecision, false);
    assert.equal(JSON.stringify(input).includes("FUTURE"), false);
    assert.equal("finalPnl" in input.currentToken, false);
  } finally {
    store.close();
  }
});
test("similarity retrieval aggregates completed past trades only, excludes open/current mint and other mode", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const at = Date.now(),
      base = at - 3600000;
    for (let i = 0; i < 30; i++)
      completedFixture(memory, {
        base,
        netPercent: i < 18 ? 20 : -10,
        observations: i < 18 ? [5, 35] : [2, -15],
      });
    completedFixture(memory, { mint: MINT, base, netPercent: 90 });
    completedFixture(memory, { base, netPercent: 90, mode: "live" });
    completedFixture(memory, { base, close: false });
    const h = memory.retrieve(snapshot(), "paper", at);
    assert.equal(h.similarTrades, 30);
    assert.equal(h.wins, 18);
    assert.equal(h.losses, 12);
    assert.equal(h.winRate, 0.6);
    assert.equal(h.avgNetPnlPercent, 8);
    assert.equal(h.confidence, "LOW");
    const context = memory.jevContext({ market: snapshot().market }, h);
    assert.equal(context.historicalExperience.similarTrades, 30);
    assert.equal(context.historicalExperience.winRate, 0.6);
    assert.ok(JSON.stringify(context).length < 5000);
    assert.equal(
      memory.retrieve(snapshot(), "paper", base + 50000).similarTrades,
      0,
    );
  } finally {
    store.close();
  }
});
test("post-exit evidence cannot leak into an earlier historical decision and cannot change realized PnL", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const t = completedFixture(memory, {
      base: Date.now() - 180000,
      netPercent: 20,
      exitReason: "Take profit",
    });
    const before = memory.outcome(t.position.id)!;
    const at = before.closedAt + 60000;
    memory.observeAfterExit(
      t.position.id,
      { ...t.snapshot.market, at, price: known(2) },
      at,
    );
    const after = memory.outcome(t.position.id)!;
    assert.equal(after.netLamports, before.netLamports);
    assert.equal(after.counterfactualCount, 1);
    assert.ok(after.classifications.includes("TAKE_PROFIT_TOO_EARLY"));
    assert.equal(
      memory.retrieve(snapshot(), "paper", before.closedAt + 1).similarTrades,
      0,
    );
    memory.observeAfterExit(
      t.position.id,
      { ...t.snapshot.market, price: known(3) },
      before.closedAt + 700000,
    );
    assert.equal(memory.outcome(t.position.id)!.counterfactualCount, 1);
  } finally {
    store.close();
  }
});
test("partial exits contribute actual proceeds to later observations and only complete after full token reconciliation", () => {
  const store = new Store(":memory:"),
    memory = new TradingMemory(store);
  try {
    const t = completedFixture(memory, {
      close: false,
      observations: [10, 20],
    });
    const partial = {
      ...t.buy,
      id: randomUUID(),
      intent: {
        ...t.buy.intent,
        id: randomUUID(),
        side: "SELL" as const,
        amount: "500000",
        reason: "Take profit",
      },
      at: t.base + 100000,
      state: "CONFIRMED" as const,
      evidence: {
        solDelta: "600000000",
        tokenDelta: "-500000",
        feeLamports: "5000",
        slot: 3,
      },
    };
    memory.confirmed(partial);
    assert.equal(memory.outcome(t.position.id), undefined);
    memory.observe(
      { ...t.position, quantity: "500000" },
      t.snapshot.market,
      t.snapshot.security,
      550000000n,
      undefined,
      t.base + 150000,
    );
    const observations = memory.detail(t.position.id)!.observations as {
      pnlPercent: number;
    }[];
    assert.equal(observations.at(-1)!.pnlPercent, 15);
  } finally {
    store.close();
  }
});
test("extended typed Jev gets locally aggregated context and cannot invent counts or elevate weak history", async () => {
  const old = env.TYPESAFE_API_KEY;
  env.TYPESAFE_API_KEY = "fixture-only";
  const store = new Store(":memory:"),
    memory = new TradingMemory(store),
    jev = new Jev();
  try {
    completedFixture(memory);
    const h = memory.retrieve(snapshot(), "paper"),
      input = memory.jevContext({ market: snapshot().market }, h);
    let body: Record<string, unknown> = {};
    jev.http.request = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return typedJevFixture("BUY", "SUPPORTS", "HIGH");
    };
    const answer = await jev.decide(input);
    assert.deepEqual(
      (body.state as Record<string, unknown>).historicalExperience,
      input.historicalExperience,
    );
    assert.equal(answer.historicalAssessment!.similarTradeCount, 1);
    assert.equal(answer.historicalAssessment!.strength, "NONE");
    assert.equal(answer.historicalAssessment!.assessment, "UNAVAILABLE");
    assert.equal(answer.confidence, 0.8);
    const snap = snapshot();
    snap.jev = answer;
    snap.security.findings.push({
      level: "CRITICAL",
      code: "HONEYPOT",
      reason: "confirmed honeypot fixture",
    });
    const risk = new RiskEngine().evaluate(snap, settings, {
      balance: 1000000000n,
      pending: 0n,
      positions: 0,
      duplicate: false,
      entriesEnabled: true,
    });
    assert.equal(risk.outcome, "SKIP_RUG");
    assert.equal(settings.positionSizePercent, 1);
  } finally {
    env.TYPESAFE_API_KEY = old;
    store.close();
  }
});
