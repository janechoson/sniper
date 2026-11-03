import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Keypair,
  MessageV0,
  PublicKey,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import { env, settingsSchema } from "../src/config.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { Solana } from "../src/solana.js";
import { exitDecision } from "../src/risk.js";
import { detectExits } from "../src/exit-lifecycle.js";
import { CandidateRejected, type Position } from "../src/domain.js";
import {
  position,
  provider,
  info,
  WALLET,
  MINT,
  seedEntryAccounting,
} from "./fixtures.js";
import { SOL } from "../src/gmgn.js";
import { completedFixture } from "./learning-fixtures.js";

const s = settingsSchema.parse({ smartMoneyExitMode: "OFF" });
function backoff() {
  return {
    status: "NEEDS_ATTENTION" as const,
    issue: {
      code: "TOKEN_SAFETY_FAILED",
      scope: "POSITION" as const,
      stage: "PRE_SELL" as const,
      mint: MINT,
      reasonCode: "SIMULATED_BALANCE_MISMATCH",
      retryable: true,
      detectedAt: Date.now(),
    },
    failureCount: 3,
    lastChecked: Date.now(),
    nextCheckAt: Date.now() + 1800000,
    protectiveExit: "BACKOFF" as const,
  };
}
function monitoringHarness() {
  const db = new Store(":memory:");
  db.set("strategyV2", s);
  let price = 0.1;
  const local = provider(async (args) => {
    if (args[0] === "token" && args[1] === "info") {
      const mint = args[args.indexOf("--address") + 1]!;
      const data = info(mint);
      return mint === SOL
        ? data
        : { ...data, price: { ...data.price, price: String(price) } };
    }
  });
  const engine = new Engine(db, { gmgn: local.gmgn });
  // observe() changes the fixture market virtually; request a new fixture snapshot.
  const freshInfo = local.gmgn.info.bind(local.gmgn);
  local.gmgn.info = (mint) => freshInfo(mint, 0);
  engine.settings.jevExitMinIntervalMs = 0;
  engine.settings.jevExitRecheckMs = 0;
  engine.settings.jevExitTradeCooldownMs = 0;
  engine.jev.decideExit = async () => ({
    action:
      price >= 0.17 ? "FULL_SELL" : price >= 0.13 ? "PARTIAL_SELL" : "HOLD",
    sellBps: price >= 0.17 ? 10000 : price >= 0.13 ? 5000 : 0,
    confidence: 0.9,
    reason: "PROFIT_MANAGEMENT",
  });
  const p: Position = {
    ...position(),
    mode: "paper",
    quantity: "1000000",
    originalQuantity: "1000000",
    entryAt: Date.now() - 21600000,
  };
  db.savePosition(p);
  seedEntryAccounting(db, p);
  const observe = async (percent: number) => {
    price = (0.1 * (100 + percent)) / 100;
    const saved = db.positions("paper").find((x) => x.id === p.id)!;
    delete saved.lastQuoteAt;
    db.savePosition(saved);
    await engine.monitor();
    await engine.settleExitWork();
    return db.positions("paper").find((x) => x.id === p.id)!;
  };
  return {
    db,
    engine,
    p,
    observe,
    local,
    setPrice: (n: number) => {
      price = n;
    },
  };
}

for (const minutes of [31, 120, 360, 1440, 10080])
  test(`long hold ${minutes} minutes and negative PnL never creates a time/price stop`, () => {
    for (const percent of [-10, -30, -50, -80])
      assert.equal(
        exitDecision(
          { ...position(), entryAt: Date.now() - minutes * 60000 },
          BigInt((1000000 * (100 + percent)) / 100),
          s,
          {},
        ),
        undefined,
      );
    assert.equal(
      "maxHoldSeconds" in settingsSchema.parse({ maxHoldSeconds: 1800 }),
      false,
    );
  });

test("six-hour recovery can execute independent partial and full Jev decisions without marking legacy TP", async () => {
  const h = monitoringHarness();
  try {
    for (const percent of [-70, -50, -20, 10]) {
      const saved = await h.observe(percent);
      assert.equal(saved.quantity, "1000000");
      assert.equal(
        h.db.executions().filter((e) => e.intent.side === "SELL").length,
        0,
      );
    }
    let saved = await h.observe(30);
    assert.equal(saved.quantity, "500000");
    assert.deepEqual(saved.takenProfits, []);
    assert.equal(
      saved.pendingExits?.some((x) => x.takeProfitIndex === 0),
      false,
    );
    assert.equal(saved.state, "OPEN");
    saved = await h.observe(70);
    assert.equal(saved.state, "CLOSED");
    assert.deepEqual(saved.takenProfits, []);
    assert.equal(
      h.db.executions().filter((e) => e.intent.jevExitDecisionId).length,
      2,
    );
  } finally {
    h.db.close();
  }
});

test("IMAGINE SELL backoff still records valuations, PnL/excursions, high water, memory observations and TP without executing", async () => {
  const h = monitoringHarness();
  try {
    const fixture = completedFixture(h.engine.memory, {
      close: false,
      mode: "paper",
      observations: [],
    });
    h.db.savePosition({
      ...fixture.position,
      symbol: "IMAGINE",
      decimals: 6,
      attention: backoff(),
      highWaterLamports: "1000000000",
    });
    h.db.savePosition({ ...h.p, attention: backoff() });
    let attempts = 0;
    h.engine.executor.execute = async () => {
      attempts++;
      throw Error("Unexpected SELL during backoff");
    };
    let saved = await h.observe(-40);
    assert.equal(saved.monitoring?.status, "ACTIVE");
    assert.equal(saved.attention?.protectiveExit, "BACKOFF");
    saved = await h.observe(60);
    assert.ok(saved.mfePercent! >= 59.9);
    assert.ok(saved.maePercent! <= -39.9);
    assert.ok(BigInt(saved.highWaterLamports) > BigInt(saved.costLamports));
    assert.ok(saved.pendingExits?.some((x) => x.kind === "STRATEGIC"));
    assert.equal(attempts, 0);
    assert.deepEqual(saved.takenProfits, []);
    assert.ok(
      Number(
        h.db.db
          .prepare(
            "SELECT count(*) n FROM trade_observations WHERE sample_id=? AND phase='OPEN'",
          )
          .get(fixture.position.id)!.n,
      ) > 0,
    );
    const events = h.db
      .recent("events", 100)
      .filter((r) => r.payload.type === "TP_DETECTED");
    await h.observe(60);
    assert.equal(
      h.db.recent("events", 100).filter((r) => r.payload.type === "TP_DETECTED")
        .length,
      events.length,
    );
  } finally {
    h.db.close();
  }
});

test("unsigned Jev failure retains quantity; a new HOLD supersedes the unsigned strategic exit without replay", async () => {
  const h = monitoringHarness();
  const execute = h.engine.executor.execute.bind(h.engine.executor);
  try {
    h.engine.executor.provider.simulate = async () => {
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "SIMULATED_BALANCE_MISMATCH",
      });
    };
    // Force a typed unsigned provider failure while retaining the real paper claim/release path.
    h.engine.executor.execute = async (intent) => {
      const e = h.db.claim(intent);
      e.state = "FAILED";
      e.error = "TOKEN_SAFETY_FAILED";
      h.db.execution(e);
      const p = h.db
        .positions("paper")
        .find((p) => p.id === intent.positionId)!;
      p.state = "OPEN";
      h.db.savePosition(p);
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "SIMULATED_BALANCE_MISMATCH",
      });
    };
    let saved = await h.observe(30);
    assert.ok(saved.pendingExits?.some((x) => x.kind === "STRATEGIC"));
    assert.equal(saved.state, "OPEN");
    assert.equal(
      h.db.executions().find((e) => e.intent.side === "SELL")?.signature,
      undefined,
    );
    assert.deepEqual(saved.takenProfits, []);
    saved = await h.observe(20);
    assert.equal(saved.pendingExits?.length, 0);
    assert.equal(
      h.db.executions().filter((e) => e.intent.side === "SELL").length,
      1,
    );
    const restarted = new Engine(h.db, { gmgn: h.local.gmgn });
    saved.attention!.nextCheckAt = Date.now() - 1;
    delete saved.lastQuoteAt;
    h.db.savePosition(saved);
    await restarted.monitor();
    await restarted.settleExitWork();
    saved = h.db.positions("paper").find((p) => p.id === h.p.id)!;
    assert.deepEqual(saved.takenProfits, []);
    assert.equal(saved.quantity, "1000000");
    assert.equal(saved.pendingExits?.length, 0);
    assert.equal(
      h.db.executions().filter((e) => e.intent.side === "SELL").length,
      1,
    );
  } finally {
    h.engine.executor.execute = execute;
    h.db.close();
  }
});

test("fresh security/liquidity supersedes pending TP; existing pending TP has deterministic priority over trailing", () => {
  const p = position();
  const result = detectExits(p, 1300000n, s, {});
  assert.equal(result.selected?.takeProfitIndex, 0);
  assert.equal(
    detectExits(p, 1200000n, s, { critical: true }).selected?.kind,
    "PROTECTIVE",
  );
  const q = { ...position(), initialLiquidity: 100000 };
  detectExits(q, 1300000n, s, {});
  assert.match(
    detectExits(q, 1200000n, s, { liquidity: 100 }).selected!.reason,
    /liquidity/,
  );
  const t = { ...position(), highWaterLamports: "1600000" };
  detectExits(t, 1300000n, s, {});
  assert.equal(detectExits(t, 1200000n, s, {}).selected?.kind, "TAKE_PROFIT");
});

test("ten positions including backoff, degraded data and signed UNKNOWN still receive market observations and persist independent TP", async () => {
  const h = monitoringHarness();
  try {
    h.db.savePosition({ ...h.p, attention: backoff() });
    for (let n = 1; n < 10; n++)
      h.db.savePosition({
        ...h.p,
        id: `ten-${n}`,
        mint: Keypair.generate().publicKey.toBase58(),
        ...(n === 1 ? { attention: backoff() } : {}),
      });
    const owned = h.db.positions("paper")[5]!;
    const pending = h.db.claim(
      h.engine.executor.sellIntent(owned, 1000000n, "Take profit", s),
    );
    pending.state = "UNKNOWN";
    pending.signature = "fixture-unknown";
    h.db.execution(pending);
    h.engine.executor.reconcile = async () => {};
    h.setPrice(0.18);
    await h.engine.monitor();
    await h.engine.settleExitWork();
    assert.equal(h.db.recent("position_market", 100).length, 10);
    assert.equal(
      h.db
        .positions("paper")
        .filter((p) => p.state === "OPEN" && p.pendingExits?.length).length,
      9,
    );
    assert.equal(
      h.db.executions().filter((e) => e.intent.side === "SELL").length,
      1,
    ); // detection continues, wallet mutations are frozen.
    assert.equal(
      h.db
        .positions("paper")
        .filter((p) => p.state === "OPEN")
        .every((p) => p.lastQuoteAt && p.monitoring?.status === "ACTIVE"),
      true,
    );
  } finally {
    h.db.close();
  }
});

function receipt(
  signature: string,
  mint: string,
  beforeSol: number,
  afterSol: number,
  beforeTokens: string,
  afterTokens: string,
  slot: number,
): VersionedTransactionResponse {
  return {
    slot,
    transaction: {
      signatures: [signature],
      message: new MessageV0({
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        staticAccountKeys: [
          new PublicKey(WALLET),
          Keypair.generate().publicKey,
        ],
        recentBlockhash: SOL,
        compiledInstructions: [],
        addressTableLookups: [],
      }),
    },
    meta: {
      err: null,
      fee: 5,
      preBalances: [beforeSol, 0],
      postBalances: [afterSol, 0],
      preTokenBalances: [
        {
          accountIndex: 1,
          owner: WALLET,
          mint,
          uiTokenAmount: { amount: beforeTokens, decimals: 6, uiAmount: null },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner: WALLET,
          mint,
          uiTokenAmount: { amount: afterTokens, decimals: 6, uiAmount: null },
        },
      ],
    },
  } as VersionedTransactionResponse;
}
function reconciliationHarness() {
  const old = { mode: env.TRADING_MODE, wallet: env.WALLET_PUBLIC_KEY };
  env.TRADING_MODE = "live";
  env.WALLET_PUBLIC_KEY = WALLET;
  const db = new Store(":memory:"),
    rpc = new Solana(),
    gmgn = provider().gmgn;
  const engine = new Engine(db, { rpc, gmgn });
  const receipts = new Map<string, VersionedTransactionResponse>(),
    balances = new Map<string, bigint>();
  let sol = 1000n;
  rpc.receipt = async (signature) => receipts.get(signature) ?? null;
  rpc.balance = async () => sol;
  rpc.tokenBalance = async (_w, m) => balances.get(m) ?? 0n;
  const add = (id: string, mint: string, manual = false, full = false) => {
    const p: Position = {
      ...position(),
      id,
      mint,
      quantity: "1000",
      originalQuantity: "1000",
      costLamports: "1000",
      remainingCostLamports: "1000",
      highWaterLamports: "1000",
      entryAt: Date.now() - 21600000,
    };
    db.savePosition(p);
    let manualRequestId: string | undefined;
    if (manual) {
      manualRequestId = randomUUID();
      db.saveManual({
        id: manualRequestId,
        positionId: p.id,
        mode: "live",
        sellBps: full ? 10000 : 5000,
        createdAt: Date.now(),
        state: "REQUESTED",
      });
    }
    const e = db.claim({
      ...engine.executor.sellIntent(
        p,
        full ? 1000n : 500n,
        manual ? "Manual emergency exit" : "Take profit",
        s,
        manual ? undefined : 0,
      ),
      manualRequestId,
    });
    return e;
  };
  return {
    db,
    rpc,
    engine,
    receipts,
    balances,
    add,
    setSol: (n: bigint) => {
      sol = n;
    },
    close() {
      db.close();
      env.TRADING_MODE = old.mode;
      env.WALLET_PUBLIC_KEY = old.wallet;
    },
  };
}

test("transaction-local receipt plus known subsequent B reconciles earlier A; repeated recovery applies each fill once", async () => {
  const h = reconciliationHarness();
  try {
    const mintB = Keypair.generate().publicKey.toBase58();
    const a = h.add("A", MINT),
      b = h.add("B", mintB);
    a.signature = "signature-A";
    a.state = "UNKNOWN";
    a.before = { sol: "1000", tokens: "1000" };
    a.submittedAt = Date.now() - 2000;
    h.db.execution(a);
    b.signature = "signature-B";
    b.state = "UNKNOWN";
    b.before = { sol: "1100", tokens: "1000" };
    b.submittedAt = Date.now() - 1000;
    h.db.execution(b);
    h.setSol(1200n);
    h.balances.set(MINT, 500n);
    h.balances.set(mintB, 500n);
    h.receipts.set(
      "signature-B",
      receipt("signature-B", mintB, 1100, 1200, "1000", "500", 20),
    );
    await h.engine.executor.reconcile(b, s);
    assert.equal(b.state, "CONFIRMED");
    h.receipts.set(
      "signature-A",
      receipt("signature-A", MINT, 1000, 1100, "1000", "500", 10),
    );
    await Promise.all([
      h.engine.executor.reconcile(a, s),
      h.engine.executor.reconcile(structuredClone(a), s),
    ]);
    assert.equal(
      h.db.positions("live").find((p) => p.id === "A")?.quantity,
      "500",
    );
    assert.equal(
      h.db.positions("live").find((p) => p.id === "B")?.quantity,
      "500",
    );
    for (let n = 0; n < 3; n++) await h.engine.executor.recover(s);
    assert.equal(
      Number(
        h.db.db.prepare("SELECT count(*) n FROM execution_fills").get()!.n,
      ),
      2,
    );
    assert.equal(
      h.db.positions("live").find((p) => p.id === "A")?.realizedLamports,
      "-400",
    );
  } finally {
    h.close();
  }
});

for (const full of [false, true])
  test(`manual ${full ? "full" : "50%"} UNKNOWN recovery consumes request once, including Engine restart`, async () => {
    const h = reconciliationHarness();
    try {
      const e = h.add("manual", MINT, true, full);
      assert.equal(h.db.manualRequests()[0]?.amount, full ? "1000" : "500");
      e.signature = "manual-signature";
      e.before = { sol: "1000", tokens: "1000" };
      e.state = "UNKNOWN";
      h.db.execution(e);
      await h.engine.executor.recover(s);
      assert.equal(h.db.pending().length, 1);
      h.receipts.set(
        e.signature,
        receipt(e.signature, MINT, 1000, 1100, "1000", full ? "0" : "500", 10),
      );
      h.setSol(1100n);
      h.balances.set(MINT, full ? 0n : 500n);
      const restarted = new Engine(h.db, { rpc: h.rpc, gmgn: provider().gmgn });
      await restarted.executor.recover(s);
      assert.equal(h.db.manualRequests()[0]?.state, "CONFIRMED");
      assert.equal(h.db.manualRequests()[0]?.executionId, e.id);
      assert.equal(h.db.positions("live")[0]?.quantity, full ? "0" : "500");
      let sells = 0;
      restarted.executor.execute = async () => {
        sells++;
        throw Error("Duplicate manual request");
      };
      // Keep the residual valuation at cost, so an unrelated automatic TP is not introduced by this fixture.
      const local = provider(async (args) => {
        if (args[0] === "token" && args[1] === "info") {
          const mint = args[args.indexOf("--address") + 1]!;
          const data = info(mint);
          return mint === SOL
            ? data
            : { ...data, price: { ...data.price, price: "0.1" } };
        }
      });
      const finalEngine = new Engine(h.db, { rpc: h.rpc, gmgn: local.gmgn });
      finalEngine.executor.execute = restarted.executor.execute;
      await finalEngine.monitor();
      await finalEngine.executor.recover(s);
      assert.equal(sells, 0);
      assert.equal(h.db.executions().length, 1);
    } finally {
      h.close();
    }
  });

test("unexplained SOL changes, receipt baseline mismatch and duplicate signatures fail closed", async () => {
  const h = reconciliationHarness();
  try {
    const e = h.add("unsafe", MINT);
    e.signature = "unsafe-signature";
    e.before = { sol: "1000", tokens: "1000" };
    e.state = "UNKNOWN";
    h.db.execution(e);
    h.receipts.set(
      e.signature,
      receipt(e.signature, MINT, 1000, 1100, "1000", "500", 10),
    );
    h.setSol(1200n);
    h.balances.set(MINT, 500n);
    await h.engine.executor.reconcile(e, s);
    assert.equal(e.state, "UNKNOWN");
    assert.equal(h.db.positions("live")[0]?.quantity, "1000");
    assert.equal(h.db.get("haltScope"), "TRANSACTION");
    assert.throws(
      () =>
        h.db.claim({
          ...e.intent,
          id: randomUUID(),
          key: randomUUID(),
          positionId: "another",
          mint: Keypair.generate().publicKey.toBase58(),
        }),
      /Unresolved/,
    );
    h.receipts.set(
      e.signature,
      receipt(e.signature, MINT, 999, 1100, "1000", "500", 10),
    );
    h.setSol(1100n);
    await h.engine.executor.reconcile(e, s);
    assert.equal(e.state, "UNKNOWN");
    assert.equal(e.error, "TRANSACTION_LOCAL_BALANCE_EVIDENCE_MISMATCH");
  } finally {
    h.close();
  }
});
