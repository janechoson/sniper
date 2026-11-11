import { test } from "node:test";
import { bindFixtureClaim, fakeKronos } from "./kronos-fixtures.js";

import assert from "node:assert/strict";

import { Keypair } from "@solana/web3.js";

import { Store } from "../src/store.js";

import { Engine } from "../src/engine.js";

import { RiskEngine } from "../src/risk.js";

import { env } from "../src/config.js";

import { activateNormalLive } from "../src/normal-live.js";

import { SMOKE_MAINNET_GENESIS } from "../src/smoke-policy.js";

import { position, provider, settings, snapshot } from "./fixtures.js";

test("normal startup retires legacy automatic halts while retaining holdings checks and signed transaction locks", async () => {
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
  db.set("strategyV2", settings);
  Object.assign(env, {
    TRADING_MODE: "live",
    LIVE_TRADING_ACK: true,
    WALLET_PUBLIC_KEY: wallet.publicKey.toBase58(),
    SOLANA_PRIVATE_KEY: JSON.stringify([...wallet.secretKey]),
    NEW_ENTRIES_ENABLED: true,
    SCANNER_ENABLED: true,
  });
  const engine = new Engine(db, {
      gmgn: provider().gmgn,
      kronos: fakeKronos(),
    }),
    p = { ...position(), strategy: "KRONOS" as const };
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
    // Extra tokens sent to an existing mint do not enlarge the bot position
    // or prevent startup; only a shortage of the bot-owned quantity blocks it.
    engine.rpc.tokenBalance = async () => BigInt(p.quantity) + 123n;
    await activateNormalLive(engine);
    assert.equal(db.positions("live")[0]?.quantity, p.quantity);
    assert.equal(db.positions("live").length, 1);
    db.reportFailure("real invariant failure", "SYSTEM");
    assert.equal(db.entriesEnabled(), true);
    db.set("newEntriesEnabled", false);
    db.set("haltReason", "legacy automatic halt");
    db.set("haltScope", "SYSTEM");
    await activateNormalLive(engine);
    assert.equal(db.entriesEnabled(), true);
    assert.equal(db.get("haltReason"), null);
    assert.equal(db.get("haltScope"), null);
    assert.equal(
      db.get<{ reason: string }>("lastFailure")?.reason,
      "real invariant failure",
    );
    db.set("newEntriesEnabled", false);
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
    db.set("newEntriesEnabled", true);
    const unresolved = db.claim(
      bindFixtureClaim(db, {
        ...intent,
        mint: Keypair.generate().publicKey.toBase58(),
      }),
    );
    unresolved.state = "UNKNOWN";
    unresolved.signature = "unresolved";
    db.execution(unresolved);
    engine.executor.recover = async () => {};
    await activateNormalLive(engine);
    assert(
      db
        .recent("events", 20)
        .some(
          (r) =>
            (r.payload as any).type === "RECOVERY_WITH_ENTRY_CONTROL_ENABLED",
        ),
    );
    assert.equal(db.entriesEnabled(), true);
    assert.ok(db.reserved("live") > 0n);
    assert.equal(db.pending()[0]?.signature, "unresolved");
  } finally {
    Object.assign(env, old);
    wallet.secretKey.fill(0);
    db.close();
  }
});
