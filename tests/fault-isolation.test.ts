import assert from "node:assert/strict";
import { test } from "node:test";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { env } from "../src/config.js";
import { ControlledSession } from "../src/controlled-session.js";
import {
  Blocked,
  CandidateRejected,
  ProviderFailure,
  type FailureInfo,
} from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { failureInfo, ProviderFailures } from "../src/failures.js";
import { positionViews } from "../src/position-view.js";
import { Store } from "../src/store.js";
import { candidate, MINT, position, provider, settings } from "./fixtures.js";
import { fakeKronos } from "./kronos-fixtures.js";

test("system and transaction errors preserve manual and environment entry controls", () => {
  const db = new Store(":memory:");
  const enabled = env.NEW_ENTRIES_ENABLED;
  try {
    env.NEW_ENTRIES_ENABLED = true;
    for (const scope of ["SYSTEM", "TRANSACTION"] as const) {
      for (const manual of [true, false]) {
        db.set("newEntriesEnabled", manual);
        db.reportFailure("fixture failure", scope);
        assert.equal(db.entriesEnabled(), manual);
        assert.equal(db.get("newEntriesEnabled"), manual);
        assert.equal(db.get("haltReason"), undefined);
        assert.equal(db.get("haltScope"), undefined);
        assert.equal(db.get<{ scope: string }>("lastFailure")?.scope, scope);
      }
    }
    env.NEW_ENTRIES_ENABLED = false;
    db.set("newEntriesEnabled", true);
    db.reportFailure("fixture environment disabled", "SYSTEM");
    assert.equal(db.entriesEnabled(), false);
    assert.equal(
      db.get<Record<string, number>>("faultMetrics")?.globalEntryPauses,
      undefined,
    );
    assert.equal(
      db.get<Record<string, number>>("faultMetrics")?.systemFailures,
      5,
    );
  } finally {
    env.NEW_ENTRIES_ENABLED = enabled;
    db.close();
  }
});

function fault(mint = MINT, now = Date.now()): FailureInfo {
  return failureInfo(
    new CandidateRejected("TOKEN_SAFETY_FAILED", {
      reason: "SIMULATED_BALANCE_MISMATCH",
    }),
    { mint, symbol: "IMAGINE", stage: "PRE_BUY" },
    now,
  );
}
function candidates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...candidate(),
    mint: i === 0 ? MINT : `fixture-${i}`,
    symbol: i === 0 ? "IMAGINE" : `C${i}`,
    listing: { liquidity: 1000000 - i * 10000, volume: 10000 },
    discoveredAt: Date.now(),
  }));
}
test("candidate failure releases the queue slot immediately and permits the next mint", async () => {
  const db = new Store(":memory:"),
    g = provider();
  db.set("strategyV2", { ...settings, candidatesPerCycle: 20 });
  const e = new Engine(db, { gmgn: g.gmgn, kronos: fakeKronos() }),
    seen: string[] = [];
  g.gmgn.trending = async () => candidates(11);
  e.analyze = async (mint) => {
    seen.push(mint);
    const row = e.candidates.get(mint)!;
    e.attempts.begin(db.token(mint)!, {
      appearanceId: row.appearanceId!,
      batchId: row.batchId!,
    });
    e.attempts.end("REJECTED");
    if (mint === MINT) throw new CandidateRejected("TOKEN_SAFETY_FAILED");
  };
  try {
    await e.tick();
    assert.equal(seen.length, 11);
    assert.equal(db.entriesEnabled(), true);
    assert.equal(e.candidates.list().length, 0);
    assert.equal(db.executions().length, 0);
  } finally {
    await e.stop();
    db.close();
  }
});
test("owned IMAGINE safety error persists attention, remains in badge, does not block other candidates and manual exit bypasses backoff", async () => {
  const db = new Store(":memory:"),
    gmgn = provider().gmgn;
  db.set("strategyV2", settings);
  const engine = new Engine(db, { gmgn, kronos: fakeKronos() });
  const p = {
    ...position(),
    mode: "demo" as const,
    symbol: "IMAGINE",
    entryAt: 1,
    initialLiquidity: 1000000,
  };
  db.savePosition(p);
  let calls = 0;
  engine.executor.execute = async () => {
    calls++;
    throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
      reason: "SIMULATED_BALANCE_MISMATCH",
    });
  };
  try {
    await engine.monitor();
    await engine.settleExitWork();
    const saved = db.positions("demo")[0]!;
    assert.equal(saved.state, "OPEN");
    assert.equal(saved.quantity, p.quantity);
    assert.equal(saved.attention?.status, "NEEDS_ATTENTION");
    assert.equal(saved.attention?.issue.scope, "POSITION");
    assert.equal(saved.attention?.protectiveExit, "BACKOFF");
    assert.equal(db.entriesEnabled(), true);
    assert.equal(positionViews([saved], [])[0]?.requiresAttention, true);
    await engine.monitor();
    await engine.settleExitWork();
    assert.equal(calls, 1);
    const seen: string[] = [];
    gmgn.trending = async () => [...candidates(2)].slice(1);
    engine.analyze = async (mint) => {
      seen.push(mint);
    };
    await engine.tick();
    assert.equal(seen.length, 1);
    engine.emergency(p.id);
    await engine.monitor();
    await engine.settleExitWork();
    assert.equal(calls, 2);
  } finally {
    db.close();
  }
});
test("signer mismatch records position attention without disabling entries", async () => {
  const db = new Store(":memory:");
  db.set("strategyV2", settings);
  const engine = new Engine(db, {
    gmgn: provider().gmgn,
    kronos: fakeKronos(),
  });
  db.savePosition({
    ...position(),
    mode: "demo",
    entryAt: 1,
    initialLiquidity: 1000000,
  });
  engine.executor.execute = async () => {
    throw new Blocked("SOLANA_SIGNER_WALLET_MISMATCH");
  };
  try {
    await engine.monitor();
    await engine.settleExitWork();
    assert.equal(db.entriesEnabled(), true);
    assert.equal(db.get("haltScope"), undefined);
    assert.equal(db.get<{ scope: string }>("lastFailure")?.scope, "SYSTEM");
    assert.equal(
      db.positions("demo")[0]?.attention?.issue.code,
      "SOLANA_SIGNER_WALLET_MISMATCH",
    );
  } finally {
    db.close();
  }
});
test("retryable candidate failures are terminal and never create Deferred or Watch state", async () => {
  const db = new Store(":memory:"),
    life = new CandidateLifecycle(db, () => settings),
    c = candidate();
  try {
    life.refill([c]);
    life.setState(MINT, "ANALYZING");
    life.fail(fault());
    assert.equal(life.get(MINT)?.state, "REJECTED");
    life.finish(MINT);
    assert.deepEqual(life.refill([c], Date.now() + 3600000), []);
    assert.equal(db.executions().length, 0);
  } finally {
    db.close();
  }
});
test("a later Trending appearance gets fresh qualification without the old failure count", async () => {
  const db = new Store(":memory:"),
    life = new CandidateLifecycle(db, () => settings),
    c = candidate();
  try {
    life.refill([c]);
    life.setState(MINT, "ANALYZING");
    life.fail(fault());
    life.finish(MINT);
    const next = structuredClone(c);
    next.discovery!.trending!.lastSeenAt++;
    life.refill([next]);
    assert.equal(life.get(MINT)?.state, "QUEUED");
    assert.equal(life.get(MINT)?.issue, undefined);
    assert.equal(life.get(MINT)?.failureCount, 0);
  } finally {
    db.close();
  }
});
test("scope distinguishes unsigned token failure, position failure, submitted ambiguity and actual system invariant", () => {
  const error = new CandidateRejected("TOKEN_SIMULATION_FAILED");
  assert.equal(
    failureInfo(error, { mint: MINT, stage: "PRE_BUY" }).scope,
    "CANDIDATE",
  );
  assert.equal(
    failureInfo(error, { mint: MINT, stage: "PRE_SELL", position: true }).scope,
    "POSITION",
  );
  assert.equal(
    failureInfo(error, { mint: MINT, stage: "PRE_BUY", submitted: true }).scope,
    "TRANSACTION",
  );
  assert.equal(
    failureInfo(new Blocked("UNEXPECTED_SIGNER"), {
      mint: MINT,
      stage: "PRE_BUY",
    }).scope,
    "SYSTEM",
  );
});
test("one provider token failure isolates, three unrelated mints escalate, authentication is immediately systemic", () => {
  const evidence = new ProviderFailures(),
    e = new ProviderFailure("JUPITER_TIMEOUT", "JUPITER"),
    now = Date.now();
  assert.equal(evidence.observe(e, "a", now), false);
  assert.equal(evidence.observe(e, "a", now + 1), false);
  assert.equal(evidence.observe(e, "b", now + 2), false);
  assert.equal(evidence.observe(e, "c", now + 3), true);
  assert.equal(
    new ProviderFailures().observe(
      new ProviderFailure("JUPITER_HTTP_401", "JUPITER", false),
      "a",
    ),
    true,
  );
});
test("position badge counts active, pending/unknown and attention while excluding closed history", () => {
  const p = position();
  const count = (list: (typeof p)[]) =>
    positionViews(list, []).filter((p) => p.relevant).length;
  assert.equal(count([]), 0);
  assert.equal(count([p]), 1);
  assert.equal(count([p, { ...p, id: "second" }]), 2);
  const closed = Array.from({ length: 10 }, (_, i) => ({
    ...p,
    id: `closed-${i}`,
    state: "CLOSED" as const,
    quantity: "0",
  }));
  assert.equal(count([p, ...closed]), 1);
  assert.equal(count([{ ...p, state: "CLOSED", quantity: "0" }]), 0);
  const unknown = {
    ...p,
    state: "PENDING_ENTRY" as const,
    quantity: "0",
    attention: {
      status: "UNKNOWN" as const,
      issue: { ...fault(), scope: "TRANSACTION" as const },
      lastChecked: 0,
      nextCheckAt: 0,
      failureCount: 1,
      protectiveExit: "RECONCILING" as const,
    },
  };
  assert.equal(count([unknown]), 1);
  assert.equal(positionViews([unknown], [])[0]?.requiresAttention, true);
});
test("restart does not restore an in-flight candidate approval or retry a consumed appearance", async () => {
  const db = new Store(":memory:"),
    c = candidate();
  let life = new CandidateLifecycle(db, () => settings);
  try {
    life.refill([c]);
    life.setState(MINT, "ANALYZING");
    life = new CandidateLifecycle(db, () => settings);
    assert.equal(life.list().length, 0);
    assert.deepEqual(life.refill([c]), []);
    assert.equal(db.executions().length, 0);
  } finally {
    db.close();
  }
});
test("controlled resume retains the same position and consumes no second BUY allowance", () => {
  const db = new Store(":memory:"),
    p = position();
  try {
    db.savePosition(p);
    db.set("controlledLiveRunV1", {
      id: "fixture-run",
      positionId: p.id,
      mint: p.mint,
      buySignature: "fixture-confirmed",
      status: "POSITION_OPEN_FAILURE",
    });
    const session = ControlledSession.resume(db);
    assert.equal(session.read().status, "OPEN");
    assert.equal(session.read().buySignature, "fixture-confirmed");
    assert.equal(db.entriesEnabled(), false);
    assert.equal(db.positions("live")[0]?.id, p.id);
  } finally {
    db.close();
  }
});
