import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { Jev } from "../src/jev.js";
import { RiskEngine } from "../src/risk.js";
import { settingsSchema, env } from "../src/config.js";
import { activateNormalLive } from "../src/normal-live.js";
import { SMOKE_MAINNET_GENESIS } from "../src/smoke-policy.js";
import { CandidateRejected } from "../src/domain.js";
import { failureInfo } from "../src/failures.js";
import {
  qualifiedWatch,
  seedEntryAccounting,
  candidate,
  position,
  provider,
  settings,
  snapshot,
  jev,
  MINT,
} from "./fixtures.js";

for (const count of [1, 5, 10, 20]) {
  test(`${count} owned positions including IMAGINE attention do not block an independently approved BUY`, async () => {
    const db = new Store(":memory:"),
      gmgn = provider().gmgn,
      j = new Jev();
    j.decide = async (state) => jev(state);
    db.set("strategyV2", { ...settings, maxPositions: 1 });
    db.set("controlledLiveRunV1", {
      status: "COMPLETE",
      buySignature: "historical",
      closedTrades: 1,
    });
    const engine = new Engine(db, { gmgn, jev: j });
    try {
      for (let n = 0; n < count; n++) {
        db.savePosition({
          ...position(),
          id: `owned-${n}`,
          mint: Keypair.generate().publicKey.toBase58(),
          mode: "paper",
          symbol: n === 0 ? "IMAGINE" : `OWNED${n}`,
          lastQuoteAt: Date.now(),
        });
      }
      const imagine = db.positions("paper")[0]!;
      imagine.attention = {
        status: "NEEDS_ATTENTION",
        failureCount: 3,
        lastChecked: Date.now(),
        nextCheckAt: Date.now() + 1800000,
        protectiveExit: "BACKOFF",
        issue: failureInfo(
          new CandidateRejected("TOKEN_SAFETY_FAILED", {
            reason: "SIMULATED_BALANCE_MISMATCH",
          }),
          { mint: imagine.mint, stage: "PRE_SELL", position: true },
        ),
      };
      db.savePosition(imagine);
      db.discover(candidate());
      qualifiedWatch(engine);
      await engine.tick();
      assert.equal(
        db.positions("paper").filter((p) => p.state === "OPEN").length,
        count + 1,
      );
      assert.ok(
        db.positions("paper").find((p) => p.symbol === "IMAGINE")?.attention,
      );
      assert.equal(engine.executor.controlled, undefined);
      assert.equal(db.entriesEnabled(), true);
      // Normal execution does not stop after its first BUY. Use a new independent mint.
      const next = {
        ...candidate(),
        mint: Keypair.generate().publicKey.toBase58(),
        symbol: "SECOND",
        discovery: db.token(MINT)?.discovery,
      };
      next.discovery = structuredClone(next.discovery);
      next.discovery!.trending!.lastSeenAt = Date.now() + 1;
      gmgn.trending = async () => [next];
      db.discover(next);
      qualifiedWatch(engine, next);
      engine.discovery.feeds.TRENDING.nextAt = 0; // Advance the fixture feed to its next due poll.
      await engine.tick();
      assert.equal(
        db.positions("paper").filter((p) => p.state === "OPEN").length,
        count + 2,
      );
      await engine.tick();
      assert.equal(
        db.executions().filter((e) => e.intent.side === "BUY").length,
        2,
      );
      assert.equal(db.get("haltReason"), undefined);
      assert.equal(
        db.get<{ status: string }>("controlledLiveRunV1")?.status,
        "COMPLETE",
      );
    } finally {
      db.close();
    }
  });
}

test("atomic reservation rechecks spendable funds; unsigned failures release and signed UNKNOWN retains capital and blocks BUY", () => {
  const db = new Store(":memory:"),
    risk = new RiskEngine();
  const intent = risk.approve(
    snapshot(),
    settings,
    {
      balance: 1000000000n,
      pending: 0n,
      positions: 20,
      duplicate: false,
      entriesEnabled: true,
    },
    "paper",
  );
  const budget = { balance: 1000000000n, reserve: 20000000n };
  try {
    const first = db.claim(intent, budget);
    const next = {
      ...intent,
      id: "next",
      key: "next",
      positionId: "next",
      mint: Keypair.generate().publicKey.toBase58(),
    };
    assert.throws(() => db.claim(next, budget), CandidateRejected);
    assert.equal(db.reserved("paper"), BigInt(intent.amount));
    first.state = "FAILED";
    db.execution(first);
    assert.equal(db.reserved("paper"), 0n);
    const second = db.claim(next, budget);
    second.state = "UNKNOWN";
    second.signature = "durable-signature";
    db.execution(second);
    assert.equal(db.reserved("paper"), BigInt(next.amount));
    assert.throws(
      () =>
        db.claim(
          {
            ...intent,
            id: "third",
            key: "third",
            positionId: "third",
            mint: Keypair.generate().publicKey.toBase58(),
          },
          budget,
        ),
      /Unresolved/,
    );
    assert.throws(
      () => db.claim({ ...next, id: "duplicate", key: "duplicate" }, budget),
      /Duplicate/,
    );
    assert.equal(db.pending().length, 1);
  } finally {
    db.close();
  }
});

test("insufficient capital rejects the attempt without a security rejection or position-cap setting", () => {
  const db = new Store(":memory:");
  try {
    const engine = new Engine(db, { gmgn: provider().gmgn });
    engine.candidates.refill([candidate()]);
    const result = new RiskEngine().evaluate(snapshot(), settings, {
      balance: 20000000n,
      pending: 0n,
      positions: 20,
      duplicate: false,
      entriesEnabled: true,
    });
    assert.equal(result.outcome, "SKIP_RISK");
    assert.match(
      result.reason,
      /WAITING_FOR_CAPITAL.*INSUFFICIENT_SPENDABLE_BALANCE/,
    );
    engine.candidates.decision(MINT, result);
    assert.equal(engine.candidates.get(MINT)?.state, "REJECTED");
    assert.equal(
      "maxPositions" in settingsSchema.parse({ maxPositions: 1 }),
      false,
    );
  } finally {
    db.close();
  }
});

test("one position SELL failure cannot abort other positions' monitoring and SELLs", async () => {
  const db = new Store(":memory:"),
    engine = new Engine(db, { gmgn: provider().gmgn });
  const execute = engine.executor.execute.bind(engine.executor),
    sold: string[] = [];
  engine.executor.execute = async (intent, ...rest) => {
    if (intent.positionId === "imagine")
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "SIMULATED_BALANCE_MISMATCH",
      });
    sold.push(intent.positionId);
    return execute(intent, ...rest);
  };
  try {
    for (const id of ["imagine", "healthy-1", "healthy-2"]) {
      const p = {
        ...position(),
        id,
        mint: Keypair.generate().publicKey.toBase58(),
        mode: "paper" as const,
        entryAt: 1,
        initialLiquidity: 1000000,
      };
      db.savePosition(p);
      seedEntryAccounting(db, p);
    }
    await engine.monitor();
    await engine.settleExitWork();
    await engine.processExits();
    assert.deepEqual(sold, ["healthy-1", "healthy-2"]);
    assert.equal(
      db.positions("paper").find((p) => p.id === "imagine")?.state,
      "OPEN",
    );
    assert.equal(
      db.positions("paper").filter((p) => p.state === "CLOSED").length,
      2,
    );
    assert.ok(
      db
        .positions("paper")
        .every(
          (p) =>
            p.monitoring?.lastSuccessAt &&
            p.mfePercent !== undefined &&
            p.maePercent !== undefined,
        ),
    );
    assert.equal(db.entriesEnabled(), true);
    assert.equal(db.get("haltReason"), undefined);
  } finally {
    db.close();
  }
});

test("explicit normal startup verifies existing holdings, leaves controlled history intact, and never clears real halts", async () => {
  const old = {
    TRADING_MODE: env.TRADING_MODE,
    LIVE_TRADING_ACK: env.LIVE_TRADING_ACK,
    WALLET_PUBLIC_KEY: env.WALLET_PUBLIC_KEY,
    SOLANA_PRIVATE_KEY: env.SOLANA_PRIVATE_KEY,
    NEW_ENTRIES_ENABLED: env.NEW_ENTRIES_ENABLED,
    SCANNER_ENABLED: env.SCANNER_ENABLED,
  };
  const wallet = Keypair.generate(),
    db = new Store(":memory:");
  Object.assign(env, {
    TRADING_MODE: "live",
    LIVE_TRADING_ACK: true,
    WALLET_PUBLIC_KEY: wallet.publicKey.toBase58(),
    SOLANA_PRIVATE_KEY: JSON.stringify([...wallet.secretKey]),
    NEW_ENTRIES_ENABLED: true,
    SCANNER_ENABLED: true,
  });
  const engine = new Engine(db, { gmgn: provider().gmgn }),
    p = position();
  const historical = {
    status: "POSITION_OPEN_FAILURE",
    buySignature: p.signature,
    positionId: p.id,
  };
  db.savePosition(p);
  db.set("controlledLiveRunV1", historical);
  db.set("newEntriesEnabled", false);
  engine.rpc.connection.getGenesisHash = async () => SMOKE_MAINNET_GENESIS;
  engine.rpc.connection.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized",
      },
    ],
  });
  engine.rpc.tokenBalance = async () => BigInt(p.quantity);
  engine.rpc.balance = async () => 1000000000n;
  try {
    await activateNormalLive(engine);
    assert.equal(db.entriesEnabled(), true);
    assert.deepEqual(db.get("controlledLiveRunV1"), historical);
    assert.equal(db.positions("live")[0]?.quantity, p.quantity);
    assert.equal(db.executions().length, 0);
    db.halt("real invariant failure", "SYSTEM");
    await assert.rejects(
      () => activateNormalLive(engine),
      /EXISTING_SYSTEM_OR_TRANSACTION_HALT/,
    );
    assert.equal(db.entriesEnabled(), false);
    assert.equal(db.get("haltReason"), "real invariant failure");
    db.set("haltReason", null);
    db.set("haltScope", null);
    engine.rpc.tokenBalance = async () => 0n;
    await assert.rejects(
      () => activateNormalLive(engine),
      /OPEN_POSITION_BALANCE_MISMATCH/,
    );
    assert.equal(db.entriesEnabled(), false);
    engine.rpc.tokenBalance = async () => BigInt(p.quantity);
    const intent = new RiskEngine().approve(
      snapshot(),
      settings,
      {
        balance: 1000000000n,
        pending: 0n,
        positions: 20,
        duplicate: false,
        entriesEnabled: true,
      },
      "live",
    );
    const unresolved = db.claim({
      ...intent,
      mint: Keypair.generate().publicKey.toBase58(),
    });
    unresolved.state = "UNKNOWN";
    unresolved.signature = "unresolved";
    db.execution(unresolved);
    engine.executor.recover = async () => {};
    await activateNormalLive(engine);
    assert(
      db
        .recent("events", 20)
        .some((r) => (r.payload as any).type === "RECOVERY_ONLY_STARTED"),
    );
    assert.equal(db.entriesEnabled(), false);
    assert.ok(db.reserved("live") > 0n);
  } finally {
    Object.assign(env, old);
    wallet.secretKey.fill(0);
    db.close();
  }
});
