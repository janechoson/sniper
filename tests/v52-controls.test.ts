import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type FlowObservation } from "../src/capital-flow.js";
import { env, settingsSchema, STRUCTURE_WATCH_MAX_MS } from "../src/config.js";
import {
  CandidateRejected,
  ProviderFailure,
  type Intent,
} from "../src/domain.js";
import { Engine } from "../src/engine.js";
import {
  type ExecutionQuote,
  type SolanaExecutionProvider,
} from "../src/execution-provider.js";
import { Executor } from "../src/executor.js";
import { RiskEngine } from "../src/risk.js";
import { evolveStructure, SniperStructure } from "../src/sniper-structure.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import {
  candidate,
  MINT,
  position,
  provider,
  quote,
  settings,
  snapshot,
  WALLET,
} from "./fixtures.js";
import { bindFixtureClaim, fakeKronos } from "./kronos-fixtures.js";
import { mockExecutionCase, setup } from "./one-shot-fixtures.js";

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

test("in-flight monitor result cannot resume a removed Position; genuine auth failure records SYSTEM without changing canonical entry controls", async () => {
  for (const failure of [false, true]) {
    const db = new Store(":memory:"),
      g = provider(),
      e = new Engine(db, { gmgn: g.gmgn, kronos: fakeKronos() });
    let enter!: () => void,
      resolve!: (value: Awaited<ReturnType<typeof g.gmgn.security>>) => void,
      reject!: (error: unknown) => void;
    const entered = new Promise<void>((r) => (enter = r));
    const original = g.gmgn.security.bind(g.gmgn);
    const sec = await original(candidate(), settings);
    try {
      const p = { ...position(), id: randomUUID(), mode: "demo" as const };
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
      assert.equal(db.positions("demo")[0]!.quantity, p.quantity);
      assert(db.positions("demo")[0]!.dismissal);
      if (failure)
        assert.match(
          db.get<{ reason: string }>("lastFailure")!.reason,
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

test("dismissal persists across reopen and a stale monitor cannot erase it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-v52-")),
    path = join(dir, "bot.sqlite");
  let db = new Store(path);
  const p = { ...position(), id: randomUUID(), mode: "demo" as const };
  try {
    db.savePosition(p);
    db.dismissPosition(p.id, "demo");
    db.savePosition({ ...p, lastQuoteAt: Date.now() });
    db.close();
    db = new Store(path);
    const g = provider(),
      e = new Engine(db, { gmgn: g.gmgn, kronos: fakeKronos() });
    try {
      await e.monitor();
      await e.processExits();
      assert.equal(g.calls.length, 0);
      assert.equal(db.managedPositions("demo").length, 0);
      assert.equal(db.positions("demo")[0]!.quantity, p.quantity);
      assert(db.bought(MINT, "demo"));
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
    const p = { ...position(), id: randomUUID(), mode: "demo" as const };
    db.savePosition(p);
    const i: Intent = {
      id: randomUUID(),
      key: "pending",
      positionId: p.id,
      mint: MINT,
      provider: "JUPITER",
      side: "SELL",
      mode: "demo",
      amount: "500",
      createdAt: Date.now(),
      expiresAt: Date.now() + 10000,
      snapshotHash: "fixture",
      reason: "manual",
    };
    const ex = db.claim(i);
    assert.throws(() => db.dismissPosition(p.id, "demo"), /PENDING/);
    ex.state = "UNKNOWN";
    ex.signature = "fixture-signed-unknown";
    db.execution(ex);
    assert.throws(() => db.dismissPosition(p.id, "demo"), /PENDING/);
    assert.equal(db.pending()[0]!.signature, ex.signature);
    assert(!db.positions("demo")[0]!.dismissal);
  } finally {
    db.close();
  }
});

test("revoking candidate authority during BUY quote prevents unsigned one-shot execution", async () => {
  const f = mockExecutionCase();
  const quote = f.execution.quoteBuy.bind(f.execution);
  f.execution.quoteBuy = async (...args) => {
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

      db.record("snapshots", MINT, snap);
      const i = bindFixtureClaim(
        db,
        new RiskEngine().approve(
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
        ),
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
