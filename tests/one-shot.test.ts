import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.js";
import {
  candles,
  mockExecutionCase,
  now,
  recentCandidate,
  setup,
} from "./one-shot-fixtures.js";

import { CandidateAttempts } from "../src/candidate-attempt.js";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { env } from "../src/config.js";
import {
  CandidateRejected,
  ProviderFailure,
  type Execution,
} from "../src/domain.js";
import { GmgnCoordinator } from "../src/gmgn-coordinator.js";
import { normalizeMarket } from "../src/gmgn.js";
import {
  attemptFlow,
  oneShotStructure,
  parseMarketHistory,
} from "../src/market-history.js";
import { PositionCollector } from "../src/position-collector.js";
import { candidate, info, MINT, position, settings } from "./fixtures.js";

import { Keypair } from "@solana/web3.js";

test("history requests one hour and records full older-token coverage without padding", () => {
  const c = { ...recentCandidate(), createdAt: now - 2 * 3600000 };
  const h = parseMarketHistory(candles(60), c, now);
  assert.equal(h.requestedLookback, 3600000);
  assert.equal(h.availableHistory, 3600000);
  assert.equal(h.historyCoverage, 1);
  assert.equal(h.historyStartsAtCreation, false);
});
test("15-minute token uses only actual fifteen minutes; pre-creation is NOT_AVAILABLE", () => {
  const h = parseMarketHistory(candles(), recentCandidate(), now);
  assert.equal(h.tokenAge, 900000);
  assert.equal(h.availableHistory, 900000);
  assert.equal(h.historyCoverage, 1);
  assert.equal(h.candles.length, 15);
  assert.equal(h.historyStartsAtCreation, true);
  assert.equal(h.preCreation, "NOT_AVAILABLE");
  assert.equal(h.status, "AVAILABLE");
  assert.equal(h.diagnostics.timestampUnit, "MILLISECONDS");
});

test("live GMGN millisecond candle shape is parsed without scaling time twice; volume is USD", () => {
  // First bar values captured from a read-only GMGN response on 2026-11-01.
  // Later timestamps repeat that public shape to form a deterministic series.
  const at = 1793504520000,
    checkedAt = at + 3 * 60000 + 30000;
  const bar = {
    time: at,
    open: "0.00029360248",
    close: "0.00031329725",
    high: "0.00032054408",
    low: "0.00028586856",
    volume: "1487.10524076",
    amount: "4923681.514648001",
    source: "",
  };
  const raw = {
    list: [bar, { ...bar, time: at + 60000 }, { ...bar, time: at + 120000 }],
    _gmgnSnapshot: { fetchedAt: checkedAt },
  };
  const h = parseMarketHistory(
    raw,
    { ...candidate(), createdAt: at - 15 * 60000 },
    checkedAt,
  );
  assert.equal(h.candles.length, 3);
  assert.equal(h.candles[0]!.at, at);
  assert.equal(h.candles[0]!.volumeUsd, 1487.10524076);
  assert.notEqual(h.candles[0]!.volumeUsd, Number(bar.amount));
  assert.equal(h.diagnostics.timestampUnit, "MILLISECONDS");
  assert.equal(h.status, "AVAILABLE");
});

test("legacy second timestamps normalize to the same candle history as milliseconds", () => {
  const ms = candles(),
    seconds = {
      ...ms,
      list: ms.list.map((c) => ({ ...c, time: c.time / 1000 })),
    };
  const a = parseMarketHistory(ms, recentCandidate(), now),
    b = parseMarketHistory(seconds, recentCandidate(), now);
  assert.deepEqual(b.candles, a.candles);
  assert.equal(b.diagnostics.timestampUnit, "SECONDS");
  assert.equal(b.availableHistory, 900000);
});

test("an unfinished millisecond candle is excluded individually, not the complete history", () => {
  const raw = candles();
  raw.list.push({ ...raw.list.at(-1)!, time: now });
  const h = parseMarketHistory(raw, recentCandidate(), now + 30000);
  assert.equal(h.candles.length, 15);
  assert.equal(h.diagnostics.inputRows, 16);
  assert.equal(h.diagnostics.rejectedRows.UNFINISHED_OR_FUTURE, 1);
  assert.equal(h.status, "AVAILABLE");
});

test("unknown USD candle volume is not filled with token-unit amount", () => {
  const raw = candles();
  const h = parseMarketHistory(
    { ...raw, list: raw.list.map((c) => ({ ...c, volume: undefined })) },
    recentCandidate(),
    now,
  );
  assert.equal(h.candles.length, 15);
  assert.equal(h.candles[0]!.volumeUsd, null);
});
test("missing or malformed candles remain insufficient; no zero-price rows are synthesized", () => {
  const h = parseMarketHistory(
    { list: [{ time: now / 1000 - 60, open: 0, close: 0, low: 0, high: 0 }] },
    recentCandidate(),
    now,
  );
  assert.equal(h.candles.length, 0);
  assert.equal(h.historyCoverage, 0);
  assert.equal(h.status, "INSUFFICIENT_DATA");
  assert.equal(h.freshness, "UNKNOWN");
});
test("history gaps reduce coverage instead of creating candles", () => {
  const raw = candles();
  raw.list.splice(5, 1);
  const h = parseMarketHistory(raw, recentCandidate(), now);
  assert.equal(h.candles.length, 14);
  assert.equal(h.availableHistory, 840000);
  assert.equal(h.historyCoverage, 14 / 15);
});
test("one-shot structure needs chronological selling, absorption, defense and recovery", () => {
  const h = parseMarketHistory(candles(), recentCandidate(), now),
    m = normalizeMarket(info()),
    f = attemptFlow(
      recentCandidate(),
      m,
      info(),
      h,
      settings.flowMeaningfulChangePercent,
    );
  assert.equal(oneShotStructure(h, f, m).passed, true);
  h.candles = h.candles.slice(-3);
  assert.equal(oneShotStructure(h, f, m).passed, false);
});
test("fresh appearance is consumed once; same mint on later poll has no prior verdict", () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings),
    c = recentCandidate();
  try {
    store.discover(c);
    assert.deepEqual(life.refill([c]), [c.mint]);
    life.setState(c.mint, "ANALYZING");
    life.fail({
      mint: c.mint,
      code: "TOKEN_DATA_INCOMPLETE",
      reasonCode: "OLD_REJECT",
      stage: "DEEP_CHECK",
      scope: "CANDIDATE",
      retryable: true,
      detectedAt: Date.now(),
    });
    assert.equal(life.get(c.mint)?.state, "REJECTED");
    life.finish(c.mint);
    assert.deepEqual(life.refill([c]), []);
    const next = structuredClone(c);
    next.discovery!.trending!.lastSeenAt += 1;
    assert.deepEqual(life.refill([next]), [c.mint]);
    assert.equal(life.get(c.mint)?.issue, undefined);
    assert.equal(life.get(c.mint)?.failureCount, 0);
  } finally {
    store.close();
  }
});
test("back-to-back appearances of the same mint are preserved while first is active", () => {
  const store = new Store(":memory:"),
    life = new CandidateLifecycle(store, () => settings),
    c = recentCandidate(),
    next = structuredClone(c);
  next.discovery!.trending!.lastSeenAt++;
  try {
    life.refill([c]);
    life.setState(c.mint, "ANALYZING");
    life.refill([next]);
    life.finish(c.mint);
    assert.deepEqual(life.refill([]), [c.mint]);
    assert.equal(life.get(c.mint)?.issue, undefined);
  } finally {
    store.close();
  }
});
test("security FAIL stops before history/KRONOS, logs precise stage, and clears temporary state", async () => {
  const x = setup({ badSecurity: true });
  try {
    await assert.rejects(x.engine.analyze(MINT));
    const a = x.engine.attempts.current!;
    assert.equal(a.failedStage, "SECURITY");
    assert.equal(a.stages.SECURITY, "FAIL");
    assert.equal(a.stages.HISTORY, "PENDING");
    assert.equal(x.calls(), 0);
    assert.equal(x.engine.candidates.get(MINT), undefined);
    assert.equal(
      x.store.db.prepare("SELECT count(*) n FROM candidate_flow_states").get()!
        .n,
      0,
    );
    assert.equal(
      x.store.db.prepare("SELECT count(*) n FROM entry_structure_watch").get()!
        .n,
      0,
    );
    await x.engine.observeStructureWatches();
    assert.equal(
      x.p.calls.some((a) => a[1] === "kline"),
      false,
    );
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("a second fresh attempt repeats security and cannot inherit rejection state", async () => {
  const x = setup({ badSecurity: true });
  try {
    await assert.rejects(x.engine.analyze(MINT));
    const id = x.engine.attempts.current!.attemptId;
    await assert.rejects(x.engine.analyze(MINT));
    assert.notEqual(x.engine.attempts.current!.attemptId, id);
    assert.equal(x.p.calls.filter((a) => a[1] === "security").length, 2);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("missing history rejects immediately with no watcher", async () => {
  const x = setup({ missingHistory: true });
  try {
    await assert.rejects(x.engine.analyze(MINT));
    assert.equal(x.engine.attempts.current!.failedStage, "HISTORY");
    assert.equal(x.calls(), 0);
    assert.equal(x.engine.candidates.list().length, 0);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("missing GMGN K-line plan capability rejects the candidate without pausing Position work or all BUYs", async () => {
  const f = setup();
  f.engine.gmgn.marketHistory = async () => {
    throw new ProviderFailure("GMGN_PLAN_UPGRADE_REQUIRED", "GMGN", false);
  };
  try {
    await f.engine.tick();
    assert.equal(f.engine.attempts.current!.failedStage, "HISTORY");
    assert.equal(
      f.engine.attempts.current!.reasonCode,
      "HISTORY_SOURCE_UNAVAILABLE",
    );
    assert.equal(f.store.entriesEnabled(), true);
    assert.equal(f.store.get("haltReason"), undefined);
    assert.equal(f.calls(), 0);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});
test("insufficient current directional flow rejects instead of warming up candidate", async () => {
  const x = setup({ noFlow: true });
  try {
    await assert.rejects(x.engine.analyze(MINT));
    assert.equal(x.engine.attempts.current!.failedStage, "CAPITAL_FLOW");
    assert.equal(x.engine.attempts.current!.reasonCode, "INSUFFICIENT_DATA");
    assert.equal(x.calls(), 0);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("successful one-shot pipeline reaches paper BUY and existing manual partial/full exits", async () => {
  const x = setup();
  try {
    await x.engine.analyze(MINT);
    assert.equal(x.engine.attempts.current!.result, "BOUGHT");
    assert.equal(x.calls(), 1);
    const p = x.store.positions("demo")[0]!;
    assert.equal(p.state, "OPEN");
    assert.equal(x.engine.attempts.current!.stages.SIMULATE, "SKIPPED");
    assert.equal(
      x.p.calls.some((a) => a[0] === "swap"),
      false,
    );
    x.engine.emergency(p.id, 5000);
    await x.engine.monitor();
    await x.engine.settleExitWork();
    assert.equal(
      x.store.positions("demo")[0]!.quantity,
      (BigInt(p.quantity) / 2n).toString(),
    );
    x.engine.emergency(p.id);
    await x.engine.settleExitWork();
    assert.equal(x.store.positions("demo")[0]!.state, "CLOSED");
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("a fully closed reconciled position does not become permanent authority against a fresh appearance", async () => {
  const x = setup();
  try {
    await x.engine.analyze(MINT);
    const id = x.store.positions("demo")[0]!.id;
    x.engine.emergency(id);
    await x.engine.monitor();
    await x.engine.settleExitWork();
    assert.equal(x.store.positions("demo")[0]!.state, "CLOSED");
    await x.engine.analyze(MINT);
    assert.equal(x.engine.attempts.current!.result, "BOUGHT");
    assert.equal(
      x.store.positions("demo").filter((p) => p.state === "OPEN").length,
      1,
    );
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("existing OPEN position rejects before any provider request", async () => {
  const x = setup();
  try {
    const p = { ...position(), mode: "demo" as const };
    x.store.savePosition(p);
    await assert.rejects(x.engine.analyze(MINT));
    assert.equal(
      x.engine.attempts.current!.reasonCode,
      "OPEN_POSITION_DUPLICATE",
    );
    assert.equal(x.p.calls.length, 0);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
for (const state of ["CREATED", "SUBMITTED", "UNKNOWN"] as const)
  test(
    state + " BUY blocks duplicate independently of candidate history",
    async () => {
      const x = setup();
      try {
        const execution = {
          id: "e",
          intent: {
            id: "i",
            mode: env.TRADING_MODE,
            mint: MINT,
            side: "BUY",
            provider: "JUPITER",
            positionId: "p",
          },
          state,
          signature: state === "CREATED" ? undefined : "signed",
        } as Execution;
        x.store.execution(execution);
        await assert.rejects(x.engine.analyze(MINT));
        assert.equal(
          x.engine.attempts.current!.reasonCode,
          "DURABLE_BUY_DUPLICATE",
        );
        assert.equal(x.p.calls.length, 0);
      } finally {
        await x.engine.stop();
        x.store.close();
      }
    },
  );
test("attempt audit preserves failure reason and never marks unexecuted stages PASS", async () => {
  const store = new Store(":memory:"),
    a = new CandidateAttempts(store);
  try {
    a.begin(candidate());
    await assert.rejects(
      a.run("HISTORY", () => {
        throw new CandidateRejected("TOKEN_DATA_INCOMPLETE", {
          reason: "PROVIDER_MISSING",
        });
      }),
    );
    a.end(
      "REJECTED",
      new CandidateRejected("TOKEN_DATA_INCOMPLETE", {
        reason: "PROVIDER_MISSING",
      }),
    );
    const row = store.db.prepare("SELECT * FROM candidate_attempts").get()!;
    assert.equal(row.failed_stage, "HISTORY");
    assert.equal(a.current!.stages.BUY, "PENDING");
    assert.equal(a.current!.reasonCode, "PROVIDER_MISSING");
  } finally {
    store.close();
  }
});
test("bounded collector lets B/C finish while A waits, coalesces duplicate A and isolates failures", async () => {
  const c = new PositionCollector(() => 3);
  let release!: () => void;
  const block = new Promise<void>((r) => (release = r)),
    finished: string[] = [];
  const a = c.collect("A", async () => {
    await block;
    finished.push("A");
  });
  assert.equal(
    c.collect("A", async () => {
      throw Error("duplicate");
    }),
    a,
  );
  await Promise.all([
    c.collect("B", async () => {
      finished.push("B");
    }),
    c.collect("C", async () => {
      finished.push("C");
      throw Error("provider failed");
    }),
  ]);
  assert.deepEqual(finished, ["B", "C"]);
  release();
  await a;
  assert.equal(c.size, 0);
});
test("GMGN provider concurrency isolates a slow request while retaining start rate and dedup", async () => {
  const coordinator = new GmgnCoordinator(() => ({
    intervalMs: 0,
    baseBackoffMs: 1000,
    maxBackoffMs: 10000,
    maxQueue: 20,
    concurrency: 3,
  }));
  let release!: () => void;
  const block = new Promise<void>((r) => (release = r));
  const a = coordinator.read("A", 0, async () => {
    await block;
    return {};
  });
  const b = await coordinator.read("B", 0, async () => ({ ready: true }), {
    priority: 0,
    consumer: "position-monitor",
  });
  assert.equal((b as { ready: boolean }).ready, true);
  release();
  await a;
  await coordinator.stop();
});

// No network or actual signer is used. Exercise the real Engine -> Executor path
// through fixture RPC, quote, simulation, pre-sign and reconciliation boundaries.
test("mock Jupiter pipeline probes exact 20/50/100%, simulates, checks pre-sign and reconciles a Position", async () => {
  const f = mockExecutionCase();
  try {
    await f.e.analyze(MINT);
    assert.equal(f.e.attempts.current!.result, "BOUGHT");
    assert.deepEqual(f.probes, [200000n, 500000n, 1000000n]);
    assert.deepEqual(f.order, [
      "BUY_QUOTE",
      "EXIT_PROBE",
      "EXIT_PROBE",
      "EXIT_PROBE",
      "SIMULATE",
      "PRE_SIGN",
    ]);
    assert.equal(f.stats().signed, 1);
    assert.equal(f.e.attempts.current!.stages.PRE_SIGN, "PASS");
    assert.equal(f.store.positions("live")[0]!.state, "OPEN");
  } finally {
    await f.close();
  }
});
for (const [failure, stage] of [
  ["SECURITY", "FINAL_ANALYSIS"],
  ["COMPATIBILITY", "COMPATIBILITY"],
  ["OWNERSHIP", "CHEAP_FILTER"],
  ["CAPITAL", "COMMON_RISK"],
  ["EXIT", "EXIT_FEASIBILITY"],
  ["SIMULATE", "SIMULATE"],
  ["PRE_SIGN", "PRE_SIGN"],
] as const)
  test("mock execution " + failure + " veto prevents signing", async () => {
    const f = mockExecutionCase(failure);
    try {
      await assert.rejects(f.e.analyze(MINT));
      assert.equal(f.stats().signed, 0);
      assert.equal(f.e.attempts.current!.result, "REJECTED");
      assert.equal(f.e.attempts.current!.failedStage, stage);
      assert.equal(f.e.candidates.list().length, 0);
    } finally {
      await f.close();
    }
  });
test("signed UNKNOWN remains reconcile-only and a new appearance cannot sign a duplicate", async () => {
  const f = mockExecutionCase("UNKNOWN");
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.e.attempts.current!.result, "RECONCILING");
    assert.equal(f.stats().signed, 1);
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.stats().signed, 1);
    assert.equal(f.e.attempts.current!.result, "REJECTED");
    assert.equal(f.e.attempts.current!.failedStage, "CHEAP_FILTER");
  } finally {
    await f.close();
  }
});

test("a slow candidate API does not block Position collection during a scanner cycle", async () => {
  const f = setup(),
    mint = Keypair.generate().publicKey.toBase58();
  f.store.savePosition({
    ...position(),
    strategy: "KRONOS",
    id: "owned",
    mint,
    mode: "demo",
  });
  const trending = f.engine.gmgn.trending.bind(f.engine.gmgn);
  f.engine.gmgn.trending = async () =>
    (await trending()).map((c) => ({ ...c, createdAt: now - 3600000 }));
  const original = f.engine.gmgn.info.bind(f.engine.gmgn);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    waiting = new Promise<void>((r) => (entered = r));
  f.engine.gmgn.info = async (token, ...args) => {
    if (token === MINT) {
      entered();
      await gate;
    }
    return original(token, ...args);
  };
  const cycle = f.engine.tick();
  try {
    await waiting;
    assert.equal(f.engine.scanning, true);
    await f.engine.monitor();
    assert.equal(f.engine.attempts.current!.stages.CHEAP_FILTER, "CHECKING");
    assert(
      f.store.positions("demo").find((p) => p.id === "owned")!.lastQuoteAt,
    );
    release();
    await cycle;
    assert.equal(
      f.engine.attempts.current!.result,
      "BOUGHT",
      f.engine.attempts.current?.reasonCode,
    );
  } finally {
    release();
    await cycle;
    await f.engine.stop();
    f.store.close();
  }
});
