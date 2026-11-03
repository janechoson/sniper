import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { Jev } from "../src/jev.js";
import { env } from "../src/config.js";
import {
  provider,
  jev,
  MINT,
  securityRaw,
  settings,
  candidate,
} from "./fixtures.js";
test("full one-shot paper pipeline buys once per safe ownership state and uses existing manual exits", async () => {
  const store = new Store(":memory:"),
    p = provider(),
    j = new Jev();
  let calls = 0;
  j.decide = async (state) => {
    calls++;
    assert.equal(JSON.stringify(state).includes("historicalExperience"), false);
    return jev(state);
  };
  store.set("strategyV2", settings);
  const e = new Engine(store, { gmgn: p.gmgn, jev: j });
  try {
    await e.tick();
    assert.equal(e.attempts.current!.result, "BOUGHT");
    assert.equal(calls, 1);
    const pos = store.positions("paper")[0]!;
    await e.tick();
    assert.equal(calls, 1);
    assert.equal(store.executions().length, 1);
    e.emergency(pos.id, 5000);
    await e.monitor();
    await e.settleExitWork();
    assert.equal(
      store.positions("paper")[0]!.quantity,
      (BigInt(pos.quantity) / 2n).toString(),
    );
    e.emergency(pos.id);
    await e.settleExitWork();
    assert.equal(store.positions("paper")[0]!.state, "CLOSED");
    assert.equal(
      p.calls.some((a) => a[0] === "swap"),
      false,
    );
  } finally {
    await e.stop();
    store.close();
  }
});
test("critical GMGN evidence rejects before spending a Jev call", async () => {
  const store = new Store(":memory:"),
    p = provider(async (a) =>
      a[0] === "token" && a[1] === "security"
        ? { ...securityRaw, renounced_freeze_account: false }
        : undefined,
    ),
    j = new Jev();
  let calls = 0;
  j.decide = async () => {
    calls++;
    return jev();
  };
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, jev: j });
  try {
    await engine.tick();
    assert.equal(calls, 0);
    assert.equal(engine.attempts.current?.failedStage, "SECURITY");
    assert.equal(store.executions().length, 0);
  } finally {
    store.close();
  }
});
test("optional dev coverage can be missing while authoritative holder data reaches Jev", async () => {
  const store = new Store(":memory:"),
    p = provider(async (a) => {
      if (a[0] === "portfolio" && a[1] === "created-tokens")
        throw Error("test optional account capability unavailable");
    }),
    j = new Jev();
  let calls = 0;
  j.decide = async (state) => {
    calls++;
    assert.equal(JSON.stringify(state).includes("knownBadFunding"), false);
    return { ...jev(state), action: "SKIP" };
  };
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, jev: j });
  try {
    await engine.tick();
    assert.equal(calls, 1);
    assert.equal(engine.attempts.current?.failedStage, "JEV");
    assert.equal(store.entriesEnabled(), true);
  } finally {
    store.close();
  }
});
test("Jev failure pauses new entries and never calls GMGN swap", async () => {
  const store = new Store(":memory:"),
    p = provider(),
    j = new Jev();
  j.decide = async () => {
    throw Error("test provider failure");
  };
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn, jev: j });
  try {
    await engine.tick();
    assert.equal(store.entriesEnabled(), false);
    assert.equal(
      p.calls.some((a) => a[0] === "swap"),
      false,
    );
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
import { Blocked, CandidateRejected } from "../src/domain.js";
test("unsupported candidate does not pause entries or prevent the next candidate from being analyzed", async () => {
  const store = new Store(":memory:"),
    p = provider();
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn });
  const calls: string[] = [];
  const second = "So11111111111111111111111111111111111111112";
  p.gmgn.trending = async () => [
    { ...candidate(), mint: MINT },
    { ...candidate(), mint: second },
  ];
  engine.analyze = async (mint) => {
    calls.push(mint);
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
      const engine = new Engine(store, { gmgn: p.gmgn });
      engine.analyze = async () => {
        throw new CandidateRejected(reason);
      };
      try {
        await engine.tick();
        assert.equal(store.entriesEnabled(), true);
        assert.equal(engine.memory.report("paper").losses, 0);
        assert.equal(engine.memory.report("paper").completedTrades, 0);
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
  test(code + " still globally pauses entries", async () => {
    const store = new Store(":memory:"),
      p = provider();
    store.set("strategyV2", settings);
    const engine = new Engine(store, { gmgn: p.gmgn });
    engine.analyze = async () => {
      throw new Blocked(code);
    };
    try {
      await engine.tick();
      assert.equal(store.entriesEnabled(), false);
      assert.match(store.get<string>("haltReason")!, new RegExp(code));
    } finally {
      store.close();
    }
  });
import { RiskEngine } from "../src/risk.js";
import { snapshot } from "./fixtures.js";
test("candidate error after a durable submission remains globally paused and is never skipped", async () => {
  const store = new Store(":memory:"),
    p = provider();
  store.set("strategyV2", settings);
  const engine = new Engine(store, { gmgn: p.gmgn });
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
      "paper",
    );
    const e = store.claim(i);
    e.state = "SUBMITTED";
    e.signature = "fixture-unresolved";
    store.execution(e);
    throw new CandidateRejected("TOKEN_SIMULATION_FAILED");
  };
  try {
    await engine.tick();
    assert.equal(store.entriesEnabled(), false);
    assert.equal(store.pending().length, 1);
    assert.equal(store.pending()[0]!.signature, "fixture-unresolved");
  } finally {
    store.close();
  }
});
