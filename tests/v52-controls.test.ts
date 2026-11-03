import { setup, mockExecutionCase } from "./one-shot-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { Jev } from "../src/jev.js";
import { Executor } from "../src/executor.js";
import { Solana } from "../src/solana.js";
import { RiskEngine } from "../src/risk.js";
import { env, settingsSchema, STRUCTURE_WATCH_MAX_MS } from "../src/config.js";
import { evolveStructure, SniperStructure } from "../src/sniper-structure.js";
import { positionViews } from "../src/position-view.js";
import {
  CandidateRejected,
  ProviderFailure,
  type Intent,
} from "../src/domain.js";
import { type FlowObservation } from "../src/capital-flow.js";
import {
  type SolanaExecutionProvider,
  type ExecutionQuote,
} from "../src/execution-provider.js";
import {
  candidate,
  settings,
  provider,
  position,
  jev,
  snapshot,
  quote,
  MINT,
  WALLET,
} from "./fixtures.js";
import { completedFixture } from "./learning-fixtures.js";

const observation = (
  at: number,
  price = 100,
  buy = 200,
  sell = 100,
): FlowObservation => ({
  at,
  window: "1m",
  priceUsd: price,
  marketCapUsd: 100000,
  liquidityUsd: 10000,
  volumeUsd: buy + sell,
  buyVolumeUsd: buy,
  sellVolumeUsd: sell,
  buys: 10,
  sells: 5,
  holders: 100,
  smartWallets: null,
  smartMoneyBuyUsd: null,
  smartMoneySellUsd: null,
  largeBuyUsd: null,
  largeSellUsd: null,
});

function trending(c = candidate()) {
  const now = Date.now();
  return {
    ...c,
    discovery: {
      sources: ["SNIPER" as const, "TRENDING" as const],
      firstSeenAt: now,
      lastSeenAt: now,
      trending: {
        firstSeenAt: now,
        lastSeenAt: now,
        sequenceStartedAt: now,
        consecutiveObservations: 1,
        rank: 1,
        basis: "fixture",
        history: [],
        movement: "STABLE" as const,
      },
    },
  };
}

test("10m is a maximum: behavior confirms at 2m,5m,9:59 and unconfirmed expires at 10m", () => {
  assert.equal(settings.structureWatchTtlMs, STRUCTURE_WATCH_MAX_MS);
  assert.equal(
    settingsSchema.parse({ structureWatchTtlMs: 1800000 }).structureWatchTtlMs,
    STRUCTURE_WATCH_MAX_MS,
  );
  const start = 1_000_000;
  for (const end of [120000, 300000, 599000]) {
    let r = evolveStructure(
      undefined,
      MINT,
      observation(start),
      settings,
      start,
    );
    const deadline = r.structureWatchExpiresAt;
    for (const [i, p] of [100, 96, 93, 93, 94, 95, 96, 97, 98].entries()) {
      const at = start + end - 120000 + i * 15000;
      r = evolveStructure(
        r,
        MINT,
        observation(
          at,
          p,
          i < 3 ? 200 - i * 40 : 120 + (i - 3) * 50,
          i < 3 ? 100 + i * 30 : 160,
        ),
        settings,
        at,
      );
      assert.equal(r.structureWatchStartedAt, start);
      assert.equal(r.structureWatchExpiresAt, deadline);
    }
    assert.equal(r.status, "PASSED", String(end));
    assert.equal(r.confirmedAt, start + end);
  }
  let r = evolveStructure(undefined, MINT, observation(start), settings, start);
  r = evolveStructure(r, MINT, undefined, settings, start + 300000);
  assert.equal(r.status, "ACTIVE");
  r = evolveStructure(
    r,
    MINT,
    undefined,
    settings,
    start + STRUCTURE_WATCH_MAX_MS,
  );
  assert.equal(r.status, "EXPIRED");
  assert(!/SCAM|MALICIOUS/.test(r.reason));
});

test("legacy candidate observer is inert: no 2m/5m/10m promotion or provider consumption", async () => {
  const f = setup();
  try {
    f.engine.structure.admit(f.store.token(MINT)!, {
      authorityRevision: 0,
      snapshotHash: "old",
    });
    const before = JSON.stringify(f.engine.structure.get(MINT));
    for (const _elapsed of [120000, 300000, 599000])
      await f.engine.observeStructureWatches();
    assert.equal(f.p.calls.length, 0);
    assert.equal(f.engine.candidates.list().length, 0);
    assert.equal(JSON.stringify(f.engine.structure.get(MINT)), before);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("PASS at9:59 ends Watch; fresh post-deadline qualification is allowed, stale/late/invalid defense is not", () => {
  const snap = snapshot();
  const now = Date.now(),
    start = now - 620000;
  let r = evolveStructure(undefined, MINT, observation(start), settings, start);
  for (const [i, p] of [100, 96, 93, 93, 94, 95, 96, 97, 98].entries()) {
    const at = start + 479000 + i * 15000;
    r = evolveStructure(
      r,
      MINT,
      observation(
        at,
        p,
        i < 3 ? 200 - i * 40 : 120 + (i - 3) * 50,
        i < 3 ? 100 + i * 30 : 160,
      ),
      settings,
      at,
    );
  }
  assert.equal(r.confirmedAt, start + 599000);
  r = evolveStructure(r, MINT, observation(now, 98, 400, 160), settings, now);
  assert.equal(r.status, "PASSED");
  assert.equal(r.structureWatchExpiresAt, start + STRUCTURE_WATCH_MAX_MS);
  const ctx = {
    balance: 1000000000n,
    pending: 0n,
    positions: 0,
    duplicate: false,
    entriesEnabled: true,
  };
  snap.entryDiscoverySource = "SNIPER";
  snap.sniperStructureAtEntry = r;
  assert.equal(
    new RiskEngine().evaluate(snap, settings, ctx, now).allowed,
    true,
  );
  for (const bad of [
    { ...r, quality: "STALE" as const },
    { ...r, lastObservedAt: now - settings.structureMaxGapMs - 1 },
    { ...r, confirmedAt: r.structureWatchExpiresAt },
    { ...r, confirmedAt: now + 1 },
  ]) {
    snap.sniperStructureAtEntry = bad;
    assert.equal(
      new RiskEngine().evaluate(snap, settings, ctx, now).allowed,
      false,
    );
  }
  const weakened = evolveStructure(
    r,
    MINT,
    observation(now + 20000, 90, 100, 200),
    settings,
    now + 20000,
  );
  assert.equal(weakened.status, "ACTIVE");
  assert.equal(
    evolveStructure(weakened, MINT, undefined, settings, now + 20001).status,
    "EXPIRED",
  );
});

test("in-flight monitor result cannot resume a removed Position; genuine auth failure still halts SYSTEM", async () => {
  for (const failure of [false, true]) {
    const db = new Store(":memory:"),
      g = provider(),
      e = new Engine(db, { gmgn: g.gmgn });
    let enter!: () => void,
      resolve!: (value: Awaited<ReturnType<typeof g.gmgn.security>>) => void,
      reject!: (error: unknown) => void;
    const entered = new Promise<void>((r) => (enter = r));
    const original = g.gmgn.security.bind(g.gmgn);
    const sec = await original(candidate(), settings);
    try {
      const p = { ...position(), id: randomUUID(), mode: "paper" as const };
      db.savePosition(p);
      g.gmgn.security = async () => {
        enter();
        return new Promise((r, j) => {
          resolve = r;
          reject = j;
        });
      };
      const monitor = e.monitor();
      await entered;
      e.dismissPosition(p.id);
      if (failure)
        reject(new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false));
      else resolve(sec);
      await monitor;
      assert.equal(g.calls.filter((a) => a[1] === "info").length, 0);
      assert.equal(db.positions("paper")[0]!.quantity, p.quantity);
      assert(db.positions("paper")[0]!.dismissal);
      if (failure)
        assert.match(
          db.get<string>("haltReason")!,
          /SYSTEM.*GMGN_AUTHORIZATION_FAILED/,
        );
      else assert.equal(db.get("haltReason"), undefined);
    } finally {
      await e.stop();
      db.close();
    }
  }
});

test("persisted legacy Watch deadline clamps from original T0; restart never grants another window", () => {
  const db = new Store(":memory:");
  try {
    const now = Date.now(),
      w = new SniperStructure(db, () => settings);
    const r = w.admit(
      candidate(),
      { authorityRevision: 0, snapshotHash: "fixture" },
      now - 11 * 60000,
    )!;
    r.structureWatchExpiresAt = r.structureWatchStartedAt + 1800000;
    db.db
      .prepare("UPDATE entry_structure_watch SET payload=? WHERE mint=?")
      .run(JSON.stringify(r), MINT);
    const restored = new SniperStructure(db, () => settings).get(MINT)!;
    assert.equal(
      restored.structureWatchExpiresAt,
      r.structureWatchStartedAt + STRUCTURE_WATCH_MAX_MS,
    );
    assert.equal(restored.status, "EXPIRED");
    assert.equal(
      new SniperStructure(db, () => settings).get(MINT)!
        .structureWatchExpiresAt,
      restored.structureWatchExpiresAt,
    );
  } finally {
    db.close();
  }
});

test("position dismissal stops GMGN/Flow/Jev/exit probes, preserves quantity/history/learning and duplicate ownership", async () => {
  const db = new Store(":memory:"),
    g = provider(),
    j = new Jev(),
    e = new Engine(db, { gmgn: g.gmgn, jev: j });
  let exits = 0,
    executions = 0;
  j.decideExit = async () => {
    exits++;
    return { action: "HOLD", sellBps: 0, confidence: 1, reason: "NO_EDGE" };
  };
  e.executor.execute = async () => {
    executions++;
    throw Error("Unexpected execution");
  };
  try {
    const p = { ...position(), id: randomUUID(), mode: "paper" as const };
    db.savePosition(p);
    db.discover(candidate());
    completedFixture(e.memory);
    const memory = db.db.prepare("SELECT * FROM trade_learning_samples").all();
    await e.monitor();
    await e.exitScheduler.idle();
    const reads = g.calls.length,
      flow = e.capitalFlow.status().observations,
      exitCalls = exits;
    e.exitLiquidity.schedule(db.positions("paper").find((x) => x.id === p.id)!);
    e.dismissPosition(p.id);
    e.dismissPosition(p.id);
    assert.equal(
      db.positions("paper").find((x) => x.id === p.id)!.quantity,
      p.quantity,
    );
    assert.equal(
      db.positions("paper").find((x) => x.id === p.id)!.state,
      "OPEN",
    );
    assert.equal(
      positionViews(db.positions("paper"), db.executions()).find(
        (x) => x.id === p.id,
      )!.relevant,
      false,
    );
    await e.monitor();
    await e.processExits();
    await e.exitLiquidity.pump();
    assert.equal(g.calls.length, reads);
    assert.equal(exits, exitCalls);
    assert.equal(executions, 0);
    assert.equal(e.capitalFlow.status().observations, flow);
    assert.equal(e.exitLiquidity.status().queued, 0);
    assert.deepEqual(
      db.db.prepare("SELECT * FROM trade_learning_samples").all(),
      memory,
    );
    assert(db.bought(MINT, "paper"));
    for (const c of [candidate(), trending()]) {
      db.discover(c);
      assert(e.candidates.refill([c]).includes(MINT));
    }
    assert.throws(() => e.emergency(p.id), /not open/);
  } finally {
    await e.stop();
    db.close();
  }
});

test("dismissal persists across reopen and a stale monitor cannot erase it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-v52-")),
    path = join(dir, "bot.sqlite");
  let db = new Store(path);
  const p = { ...position(), id: randomUUID(), mode: "paper" as const };
  try {
    db.savePosition(p);
    db.dismissPosition(p.id, "paper");
    db.savePosition({ ...p, lastQuoteAt: Date.now() });
    db.close();
    db = new Store(path);
    const g = provider(),
      e = new Engine(db, { gmgn: g.gmgn });
    try {
      await e.monitor();
      await e.processExits();
      assert.equal(g.calls.length, 0);
      assert.equal(db.managedPositions("paper").length, 0);
      assert.equal(db.positions("paper")[0]!.quantity, p.quantity);
      assert(db.bought(MINT, "paper"));
    } finally {
      await e.stop();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

test("pending unsigned or signed UNKNOWN prevents Position dismissal and preserves reconciliation responsibility", () => {
  const db = new Store(":memory:");
  try {
    const p = { ...position(), id: randomUUID(), mode: "paper" as const };
    db.savePosition(p);
    const i: Intent = {
      id: randomUUID(),
      key: "pending",
      positionId: p.id,
      mint: MINT,
      provider: "JUPITER",
      side: "SELL",
      mode: "paper",
      amount: "500",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10000,
      snapshotHash: "fixture",
      reason: "manual",
    };
    const ex = db.claim(i);
    assert.throws(() => db.dismissPosition(p.id, "paper"), /PENDING/);
    ex.state = "UNKNOWN";
    ex.signature = "fixture-signed-unknown";
    db.execution(ex);
    assert.throws(() => db.dismissPosition(p.id, "paper"), /PENDING/);
    assert.equal(db.pending()[0]!.signature, ex.signature);
    assert(!db.positions("paper")[0]!.dismissal);
  } finally {
    db.close();
  }
});

test("revoking candidate authority during BUY quote prevents unsigned one-shot execution", async () => {
  const f = mockExecutionCase();
  const quote = f.e.executor.provider.quoteBuy.bind(f.e.executor.provider);
  f.e.executor.provider.quoteBuy = async (...args) => {
    const q = await quote(...args);
    f.store.dismissCandidate(MINT, "live", true);
    return q;
  };
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.candidates.list().length, 0);
  } finally {
    await f.close();
  }
});

test("a delayed JEV BUY loses its attempt authority when the operator revokes it", async () => {
  const f = setup();
  let release!: (v: ReturnType<typeof jev>) => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r));
  f.j.decide = async () => {
    entered();
    return new Promise((r) => (release = r));
  };
  let running: Promise<void> | undefined;
  try {
    running = f.engine.analyze(MINT);
    await waiting;
    f.store.dismissCandidate(MINT, "paper", true);
    release(jev());
    await assert.rejects(running);
    assert.equal(f.store.executions().length, 0);
    assert.equal(f.engine.attempts.current!.failedStage, "JEV");
    assert.equal(f.engine.candidates.list().length, 0);
  } finally {
    release?.(jev());
    await running?.catch(() => {});
    await f.engine.stop();
    f.store.close();
  }
});

test("a rejected candidate never starts an in-flight Watch info request", async () => {
  const f = setup({ missingHistory: true });
  try {
    await assert.rejects(f.engine.analyze(MINT));
    const reads = f.p.calls.length;
    await f.engine.observeStructureWatches();
    assert.equal(f.p.calls.length, reads);
    assert.equal(f.engine.candidates.list().length, 0);
    assert.equal(f.engine.attempts.current!.result, "REJECTED");
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

for (const phase of ["QUOTE", "MINT_RPC", "PRE_SIGN", "SUBMITTED"] as const)
  test(`LIVE fixture ${phase}: revoke unsigned authority; already submitted receipt still reconciles`, async () => {
    const saved = {
      mode: env.TRADING_MODE,
      ack: env.LIVE_TRADING_ACK,
      wallet: env.WALLET_PUBLIC_KEY,
    };
    env.TRADING_MODE = "live";
    env.LIVE_TRADING_ACK = true;
    env.WALLET_PUBLIC_KEY = WALLET;
    const db = new Store(":memory:"),
      rpc = new Solana(),
      g = provider();
    let sol = 1000000000n,
      tokens = 0n,
      signatures = 0,
      submissions = 0,
      receiptAvailable = false,
      last!: ExecutionQuote;
    const revoke = () => db.dismissCandidate(MINT, "live", true);
    const execution: SolanaExecutionProvider = {
      health: { state: "READY", at: Date.now() },
      getWalletBalance: async () => sol,
      quoteBuy: async (_m, n) => {
        if (phase === "QUOTE") revoke();
        return quote("BUY", n);
      },
      quoteSell: async (_m, n, _bps, routeOnly) =>
        quote("SELL", n, WALLET, routeOnly),
      simulate: async () => {},
      execute: async (q, before, beforeSign) => {
        if (phase === "PRE_SIGN") revoke();
        beforeSign?.();
        signatures++;
        last = q;
        before("fixture-v52-signature");
        submissions++;
        sol -= BigInt(q.amount) + 5000n;
        tokens = 1000000n;
        if (phase === "SUBMITTED") revoke();
        return "fixture-v52-signature";
      },
      confirm: async () => "UNKNOWN",
    };
    rpc.tokenBalance = async () => tokens;
    rpc.balance = async () => sol;
    rpc.connection.getParsedAccountInfo = async () => {
      if (phase === "MINT_RPC") revoke();
      return {
        value: { data: { parsed: { type: "mint", info: { decimals: 6 } } } },
      } as never;
    };
    rpc.receipt = async () =>
      receiptAvailable
        ? ({
            slot: 1,
            meta: { err: null, fee: 5000 },
            transaction: { signatures: ["fixture-v52-signature"] },
          } as never)
        : null;
    rpc.deltas = () => ({
      sol: -BigInt(last.amount) - 5000n,
      tokens: 1000000n,
      beforeSol: 1000000000n,
      afterSol: sol,
      beforeTokens: 0n,
      afterTokens: tokens,
    });
    try {
      const ex = new Executor(db, g.gmgn, rpc, execution),
        snap = snapshot();
      snap.entryAuthority = {
        revision: 0,
        path: "TRENDING",
        policy: "TRENDING_FINAL_STRUCTURE_V1",
      };
      db.record("snapshots", MINT, snap);
      const i = new RiskEngine().approve(
        snap,
        settings,
        {
          balance: sol,
          pending: 0n,
          positions: 0,
          duplicate: false,
          entriesEnabled: true,
        },
        "live",
      );
      const validate = async () =>
        db.assertEntryAuthority(MINT, "live", i.entryAuthority);
      if (phase !== "SUBMITTED") {
        await assert.rejects(
          ex.execute(i, settings, "0", validate),
          CandidateRejected,
        );
        assert.equal(signatures, 0);
        assert.equal(submissions, 0);
      } else {
        const result = await ex.execute(i, settings, "0", validate);
        assert.equal(signatures, 1);
        assert.equal(submissions, 1);
        assert.equal(result.state, "UNKNOWN");
        assert.equal(db.pending().length, 1);
        receiptAvailable = true;
        await ex.reconcile(result, settings);
        assert.equal(db.executions()[0]!.state, "CONFIRMED");
        assert.equal(db.positions("live")[0]!.quantity, "1000000");
        assert(!db.positions("live")[0]!.dismissal);
      }
    } finally {
      db.close();
      env.TRADING_MODE = saved.mode;
      env.LIVE_TRADING_ACK = saved.ack;
      env.WALLET_PUBLIC_KEY = saved.wallet;
    }
  });
