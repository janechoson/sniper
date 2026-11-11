import assert from "node:assert/strict";
import { test } from "node:test";
import { env } from "../src/config.js";
import { Blocked, CandidateRejected } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { RiskEngine } from "../src/risk.js";
import { Store } from "../src/store.js";
import {
  candidate,
  MINT,
  provider,
  securityRaw,
  settings,
  snapshot,
} from "./fixtures.js";
import { bindFixtureClaim, fakeKronos } from "./kronos-fixtures.js";
import { setup } from "./one-shot-fixtures.js";
test("DEMO shares one-shot BUY, duplicate protection, and existing manual partial/full exits", async () => {
  const f = setup();
  try {
    await f.engine.analyze(MINT);
    await f.engine.settleEntryEvaluations();
    assert.equal(f.engine.attempts.current!.result, "BOUGHT");
    assert.equal(f.calls(), 1);
    const p = f.store.positions("demo")[0]!;
    await assert.rejects(f.engine.analyze(MINT));
    assert.equal(f.calls(), 1);
    assert.equal(f.store.executions().length, 1);
    f.engine.emergency(p.id, 5000);
    await f.engine.monitor();
    await f.engine.settleExitWork();
    assert.equal(
      f.store.positions("demo")[0]!.quantity,
      (BigInt(p.quantity) / 2n).toString(),
    );
    f.engine.emergency(p.id);
    await f.engine.processExits();
    await f.engine.settleExitWork();
    assert.equal(f.store.positions("demo")[0]!.state, "CLOSED");
    assert.equal(
      f.p.calls.some((a) => a[0] === "swap"),
      false,
    );
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test("critical GMGN evidence rejects before spending KRONOS inference", async () => {
  const store = new Store(":memory:"),
    p = provider(async (a) =>
      a[0] === "token" && a[1] === "security"
        ? { ...securityRaw, renounced_freeze_account: false }
        : undefined,
    );
  const calls = 0;
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, kronos: fakeKronos() });
  try {
    await engine.tick();
    assert.equal(calls, 0);
    assert.equal(engine.attempts.current?.failedStage, "SECURITY");
    assert.equal(store.executions().length, 0);
  } finally {
    store.close();
  }
});
test("paper mode cannot invoke any GMGN mutating command even with ACK set", async () => {
  const old = env.LIVE_TRADING_ACK;
  env.LIVE_TRADING_ACK = true;
  const p = provider();
  try {
    await assert.rejects(
      () => p.gmgn.run(["swap", "--chain", "sol"]),
      /Unsupported/,
    );
    await assert.rejects(
      () => p.gmgn.run(["order", "strategy", "cancel", "--chain", "sol"]),
      /Unsupported/,
    );
    assert.equal(p.calls.length, 0);
    await assert.rejects(
      () => p.gmgn.run(["multi-swap", "--chain", "sol"]),
      /Unsupported/,
    );
    await assert.rejects(
      () => p.gmgn.run(["cooking", "create-token", "--chain", "sol"]),
      /Unsupported/,
    );
  } finally {
    env.LIVE_TRADING_ACK = old;
  }
});
test("unsupported candidate does not pause entries or prevent the next candidate from being analyzed", async () => {
  const store = new Store(":memory:"),
    p = provider();
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, kronos: fakeKronos() });
  const calls: string[] = [];
  const second = "So11111111111111111111111111111111111111112";
  const base = candidate();
  p.gmgn.trending = async () => [
    { ...structuredClone(base), mint: MINT },
    { ...structuredClone(base), mint: second },
  ];
  engine.analyze = async (mint) => {
    calls.push(mint);
    const row = engine.candidates.get(mint)!;
    store.atomic(() => {
      engine.candidates.setState(mint, "ANALYZING");
      engine.attempts.begin(store.token(mint)!, {
        appearanceId: row.appearanceId!,
        batchId: row.batchId!,
      });
    });
    engine.attempts.end("REJECTED");
    if (calls.length === 1)
      throw new CandidateRejected("UNSUPPORTED_TOKEN_EXTENSION");
  };
  try {
    await engine.tick();
    assert.equal(calls.length, 2);
    assert.equal(store.entriesEnabled(), true);
    assert.equal(store.get("haltReason"), undefined);
    assert.equal(engine.lastError, undefined);
    assert.equal(
      store.latest<{ outcome: string }>("decisions", calls[0]!)?.outcome,
      "SKIP_MARKET",
    );
  } finally {
    store.close();
  }
});
for (const reason of [
  "NO_BUY_ROUTE",
  "NO_SELL_ROUTE",
  "TOKEN_SIMULATION_FAILED",
  "UNSUPPORTED_TRANSACTION_LAYOUT",
] as const)
  test(
    reason + " skips without pausing scanner or recording a loss",
    async () => {
      const store = new Store(":memory:"),
        p = provider();
      store.set("strategyV2", settings);
      const engine = new Engine(store, { gmgn: p.gmgn, kronos: fakeKronos() });
      engine.analyze = async () => {
        throw new CandidateRejected(reason);
      };
      try {
        await engine.tick();
        assert.equal(store.entriesEnabled(), true);
      } finally {
        store.close();
      }
    },
  );
for (const code of [
  "SOLANA_SIGNER_WALLET_MISMATCH",
  "RPC_TIMEOUT",
  "JUPITER_HTTP_503",
  "TOKEN_ACCOUNT_WALLET_OR_MINT_MISMATCH",
])
  test(
    code + " records system fault and preserves canonical entry control",
    async () => {
      const store = new Store(":memory:"),
        p = provider();
      store.set("strategyV2", settings);
      const engine = new Engine(store, { gmgn: p.gmgn, kronos: fakeKronos() });
      engine.analyze = async () => {
        throw new Blocked(code);
      };
      try {
        await engine.tick();
        assert.equal(store.entriesEnabled(), true);
        assert.match(
          store.get<{ reason: string }>("lastFailure")!.reason,
          new RegExp(code),
        );
      } finally {
        store.close();
      }
    },
  );
test("durable submitted execution retains its reservation and reconciliation responsibility after candidate error", async () => {
  const store = new Store(":memory:"),
    p = provider();
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, kronos: fakeKronos() });
  engine.analyze = async () => {
    const i = new RiskEngine().approve(
      snapshot(),
      settings,
      {
        balance: 1000000000n,
        pending: 0n,
        positions: 0,
        duplicate: false,
        entriesEnabled: true,
      },
      "demo",
    );
    const e = store.claim(bindFixtureClaim(store, i));
    e.state = "SUBMITTED";
    e.signature = "fixture-unresolved";
    store.execution(e);
    throw new CandidateRejected("TOKEN_SIMULATION_FAILED");
  };
  try {
    await engine.tick();
    assert.equal(store.entriesEnabled(), true);
    assert.equal(store.pending().length, 1);
    assert.equal(store.pending()[0]!.signature, "fixture-unresolved");
  } finally {
    store.close();
  }
});
