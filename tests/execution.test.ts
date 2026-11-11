import { Keypair } from "@solana/web3.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { env } from "../src/config.js";
import {
  CONTROLLED_BUY_CAP,
  ControlledSession,
} from "../src/controlled-session.js";
import { Blocked, CandidateRejected } from "../src/domain.js";
import { UNSIGNED_EXECUTION_TIMEOUT_MS } from "../src/execution-deadline.js";
import {
  base58,
  localWallet,
  validateQuote,
  type ExecutionQuote,
  type SolanaExecutionProvider,
} from "../src/execution-provider.js";
import { Executor } from "../src/executor.js";
import { SOL } from "../src/gmgn.js";
import { RiskEngine } from "../src/risk.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import {
  MINT,
  WALLET,
  provider,
  quote,
  settings,
  snapshot,
} from "./fixtures.js";
import { bindFixtureClaim } from "./kronos-fixtures.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let n = 0; n < 80; n++) await Promise.resolve();
};
function harness() {
  const old = {
    mode: env.TRADING_MODE,
    ack: env.LIVE_TRADING_ACK,
    wallet: env.WALLET_PUBLIC_KEY,
  };
  env.TRADING_MODE = "live";
  env.LIVE_TRADING_ACK = true;
  env.WALLET_PUBLIC_KEY = WALLET;
  const store = new Store(":memory:"),
    rpc = new Solana(),
    gmgn = provider();
  let sol = 1_000_000_000n,
    tokens = 0n,
    broadcasts = 0,
    timeout = false,
    missing = false,
    last: ExecutionQuote;
  const execution: SolanaExecutionProvider = {
    health: { state: "READY", at: Date.now() },
    getWalletBalance: async () => sol,
    quoteBuy: async (_mint, n) => quote("BUY", n),
    quoteSell: async (_mint, n, _bps, routeOnly) =>
      quote("SELL", n, WALLET, routeOnly),
    simulate: async () => {},
    async execute(q, before) {
      last = q;
      before("fixture-signature-" + ++broadcasts);
      assert.equal(
        store.pending()[0]?.signature,
        "fixture-signature-" + broadcasts,
      );
      if (timeout) throw new Blocked("JUPITER_TIMEOUT");
      sol += q.side === "BUY" ? -BigInt(q.amount) - 5000n : 2_000_000n;
      tokens += q.side === "BUY" ? 1_000_000n : -BigInt(q.amount);
      return "fixture-signature-" + broadcasts;
    },
    confirm: async () => (missing ? "UNKNOWN" : "CONFIRMED"),
  };
  rpc.connection.getParsedAccountInfo = async () =>
    ({
      value: { data: { parsed: { type: "mint", info: { decimals: 6 } } } },
    }) as never;
  rpc.balance = async () => sol;
  rpc.tokenBalance = async () => tokens;
  rpc.receipt = async (signature) =>
    missing || timeout
      ? null
      : ({
          slot: 123,
          meta: { err: null, fee: 5000 },
          transaction: { signatures: [signature] },
        } as never);
  rpc.deltas = () => {
    const before = store
      .executions()
      .findLast(
        (e) => e.signature === "fixture-signature-" + broadcasts,
      )!.before!;
    const deltaSol =
      last.side === "BUY" ? -BigInt(last.amount) - 5000n : 2_000_000n;
    const deltaTokens = last.side === "BUY" ? 1_000_000n : -BigInt(last.amount);
    return {
      sol: deltaSol,
      tokens: deltaTokens,
      beforeSol: BigInt(before.sol),
      afterSol: BigInt(before.sol) + deltaSol,
      beforeTokens: BigInt(before.tokens),
      afterTokens: BigInt(before.tokens) + deltaTokens,
    };
  };
  const executor = new Executor(store, gmgn.gmgn, rpc, execution),
    snap = snapshot(),
    intent = bindFixtureClaim(
      store,
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
  store.record("snapshots", MINT, snap);
  const sellIntent = executor.sellIntent.bind(executor);
  executor.sellIntent = (p, amount, reason, s, index) => {
    for (const old of store.activeManual(p.mode)) {
      old.state = "CANCELLED";
      store.saveManual(old);
    }
    const id = randomUUID();
    store.saveManual({
      id,
      positionId: p.id,
      mode: p.mode,
      sellBps: Number((amount * 10000n) / BigInt(p.quantity)),
      baseQuantity: p.quantity,
      amount: String(amount),
      createdAt: Date.now(),
      state: "REQUESTED",
    });
    return {
      ...sellIntent(p, amount, reason, s, index),
      manualRequestId: id,
      exitAuthority: "MANUAL",
    };
  };
  return {
    store,
    executor,
    intent,
    gmgn,
    execution,
    broadcasts: () => broadcasts,
    missing: () => {
      missing = true;
    },
    timeout: () => {
      timeout = true;
    },
    receive: (solAmount = 0n, tokenAmount = 0n) => {
      sol += solAmount;
      tokens += tokenAmount;
    },
    close() {
      env.TRADING_MODE = old.mode;
      env.LIVE_TRADING_ACK = old.ack;
      env.WALLET_PUBLIC_KEY = old.wallet;
      store.close();
    },
  };
}
for (const reason of ["NO_ROUTE", "THIN", "CHANGED_BUY"] as const)
  test(`pre-BUY exit gate ${reason} prevents signature persistence and any broadcast`, async () => {
    const h = harness();
    try {
      if (reason === "NO_ROUTE")
        h.execution.quoteSell = async () => {
          throw new CandidateRejected("NO_SELL_ROUTE");
        };
      if (reason === "THIN")
        h.execution.quoteSell = async (_m, n, _b, r) => {
          const q = quote("SELL", n, WALLET, r);
          q.order.outAmount = "823";
          q.order.otherAmountThreshold = "815";
          return q;
        };
      if (reason === "CHANGED_BUY")
        h.execution.simulate = async (q) => {
          q.at -= 21000;
        };
      await assert.rejects(
        () => h.executor.execute(h.intent, settings, "0", async () => {}),
        new RegExp(
          reason === "NO_ROUTE"
            ? "NO_PREBUY_EXIT_ROUTE"
            : reason === "THIN"
              ? "EXIT_LIQUIDITY_TOO_THIN"
              : "EXIT_FEASIBILITY_STALE",
        ),
      );
      assert.equal(h.broadcasts(), 0);
      assert.equal(h.store.executions()[0]?.signature, undefined);
      assert.equal(h.store.executions()[0]?.state, "FAILED");
      assert.equal(
        Number(
          h.store.db.prepare("SELECT count(*) n FROM execution_fills").get()!.n,
        ),
        0,
      );
    } finally {
      h.close();
    }
  });
test("quote guards reject wrong wallet, mint, direction, amount, slippage, stale or mismatched route", () => {
  const valid = quote("BUY", 500_000n),
    expected = {
      mint: MINT,
      side: "BUY" as const,
      amount: 500_000n,
      wallet: WALLET,
      slippageBps: 100,
    };
  validateQuote(valid, expected);
  for (const mutate of [
    (q: ExecutionQuote) => (q.wallet = SOL),
    (q: ExecutionQuote) => (q.order.outputMint = SOL),
    (q: ExecutionQuote) => (q.side = "SELL"),
    (q: ExecutionQuote) => (q.order.inAmount = "5000000"),
    (q: ExecutionQuote) => (q.order.slippageBps = 101),
    (q: ExecutionQuote) => (q.at -= 21000),
    (q: ExecutionQuote) => (q.order.routePlan[0]!.swapInfo.outputMint = SOL),
    (q: ExecutionQuote) => (q.order.otherAmountThreshold = "1"),
  ]) {
    const q = structuredClone(valid);
    mutate(q);
    assert.throws(() => validateQuote(q, expected));
  }
});
test("unsigned SELL simulation diagnostics persist without another broadcast or closing the position", async () => {
  const h = harness();
  try {
    await h.executor.execute(h.intent, settings, "0", async () => {});
    const position = h.store.positions("live")[0]!;
    const details = {
      simulationError: { InstructionError: [2, { Custom: 6001 }] },
      logs: ["fixture program failure"],
    };
    h.execution.simulate = async () => {
      throw new CandidateRejected("TOKEN_SIMULATION_FAILED", details);
    };
    const sell = h.executor.sellIntent(
      position,
      BigInt(position.quantity),
      "Manual emergency exit",
      settings,
    );
    await assert.rejects(
      () => h.executor.execute(sell, settings, "0"),
      /TOKEN_SIMULATION_FAILED/,
    );
    const failed = h.store.executions().find((e) => e.intent.side === "SELL")!;
    assert.equal(failed.state, "FAILED");
    assert.equal(failed.signature, undefined);
    assert.deepEqual(failed.errorDetails, details);
    assert.equal(
      h.store.recent("execution_errors", 1)[0]?.payload.positionId,
      position.id,
    );
    assert.equal(h.broadcasts(), 1);
    assert.equal(h.store.positions("live")[0]!.state, "OPEN");
    assert.equal(h.store.pending().length, 0);
  } finally {
    h.close();
  }
});
test("live ACK blocks before claim and broadcast", async () => {
  const h = harness();
  try {
    env.LIVE_TRADING_ACK = false;
    await assert.rejects(
      () => h.executor.execute(h.intent, settings, "0", async () => {}),
      /ACK/,
    );
    assert.equal(h.broadcasts(), 0);
  } finally {
    h.close();
  }
});
test("confirmed receipt plus actual balances opens position, duplicate claim blocks, SELL closes", async () => {
  const h = harness();
  try {
    const buy = await h.executor.execute(
      h.intent,
      settings,
      "0",
      async () => {},
    );
    assert.equal(buy.state, "CONFIRMED");
    assert.equal(buy.evidence?.tokenDelta, "1000000");
    const p = h.store.positions()[0]!;
    assert.equal(p.state, "OPEN");
    assert.equal(p.costLamports, "9805000");
    await assert.rejects(
      () => h.executor.execute(h.intent, settings, "0", async () => {}),
      /Duplicate|BUY_CLAIM_EXECUTION_ALREADY_CREATED/,
    );
    const sell = h.executor.sellIntent(
      p,
      BigInt(p.quantity),
      "Manual exit",
      settings,
    );
    await h.executor.execute(sell, settings, "0");
    assert.equal(h.store.positions()[0]!.state, "CLOSED");
    assert.equal(h.store.positions()[0]!.sellSignature, "fixture-signature-2");
    assert.equal(h.gmgn.calls.length, 0);
  } finally {
    h.close();
  }
});
for (const timing of ["before-buy", "before-sign", "after-submit"] as const)
  test(`incoming tokens ${timing} never enter the bot BUY/SELL quantity`, async () => {
    const h = harness();
    try {
      if (timing === "before-buy") h.receive(0n, 250n);
      if (timing === "before-sign") {
        const simulate = h.execution.simulate;
        h.execution.simulate = async (...args) => {
          await simulate(...args);
          h.receive(1n, 250n);
        };
      }
      if (timing === "after-submit") {
        const execute = h.execution.execute;
        h.execution.execute = async (...args) => {
          const signature = await execute(...args);
          h.receive(1n, 250n);
          return signature;
        };
      }
      const buy = await h.executor.execute(
        h.intent,
        settings,
        "0",
        async () => {},
      );
      assert.equal(buy.state, "CONFIRMED");
      const p = h.store.positions()[0]!;
      assert.equal(p.quantity, "1000000");
      assert.equal(p.originalQuantity, "1000000");
      assert.equal(h.store.positions().length, 1);
      const sell = h.executor.sellIntent(
        p,
        BigInt(p.quantity),
        "Close only bot-owned tokens",
        settings,
      );
      await h.executor.execute(sell, settings, "0");
      assert.equal(h.store.positions()[0]?.quantity, "0");
      assert.equal(h.store.positions()[0]?.state, "CLOSED");
      assert.equal(h.store.executions()[1]?.evidence?.tokenDelta, "-1000000");
      assert.equal(h.broadcasts(), 2);
      assert.equal(h.store.pending().length, 0);
    } finally {
      h.close();
    }
  });
test("signature alone never opens; pending recovery never broadcasts a second BUY", async () => {
  const h = harness();
  try {
    h.missing();
    const e = await h.executor.execute(h.intent, settings, "0", async () => {});
    assert.equal(e.state, "UNKNOWN");
    assert.equal(h.store.positions()[0]!.state, "PENDING_ENTRY");
    await h.executor.recover(settings);
    assert.equal(h.broadcasts(), 1);
    assert.equal(h.store.entriesEnabled(), true);
  } finally {
    h.close();
  }
});

test("repeated unsigned SELL simulation failures preserve one position/sample, pending TP and no fabricated LOSS", async () => {
  const h = harness();
  try {
    await h.executor.execute(h.intent, settings, "0", async () => {});
    const p = h.store.positions("live")[0]!;
    p.pendingExits = [
      {
        id: "tp1-opportunity",
        kind: "TAKE_PROFIT",
        reason: "Take profit",
        sellBps: 5000,
        takeProfitIndex: 0,
        triggeredAt: Date.now(),
      },
    ];
    h.store.savePosition(p);
    h.execution.simulate = async () => {
      throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
        reason: "SIMULATED_BALANCE_MISMATCH",
      });
    };
    for (let n = 0; n < 3; n++) {
      const current = h.store.positions("live")[0]!;
      const intent = {
        ...h.executor.sellIntent(current, 500000n, "Take profit", settings, 0),
        exitOpportunityId: "tp1-opportunity",
      };
      await assert.rejects(
        () => h.executor.execute(intent, settings, "0"),
        CandidateRejected,
      );
    }
    const saved = h.store.positions("live")[0]!;
    assert.equal(saved.quantity, "1000000");
    assert.equal(saved.state, "OPEN");
    assert.deepEqual(saved.takenProfits, []);
    assert.equal(saved.pendingExits?.[0]?.id, "tp1-opportunity");
    assert.equal(h.broadcasts(), 1);
    assert.equal(
      Number(
        h.store.db.prepare("SELECT count(*) n FROM execution_fills").get()!.n,
      ),
      1,
    );
    assert.equal(
      Number(
        h.store.db.prepare("SELECT count(*) n FROM trade_outcomes").get()!.n,
      ),
      0,
    );
    assert.equal(
      h.store
        .executions()
        .filter(
          (e) =>
            e.intent.side === "SELL" && e.state === "FAILED" && !e.signature,
        ).length,
      3,
    );
  } finally {
    h.close();
  }
});
test("HTTP failure after durable signature stays UNKNOWN and is never replayed", async () => {
  const h = harness();
  try {
    h.timeout();
    await assert.rejects(() =>
      h.executor.execute(h.intent, settings, "0", async () => {}),
    );
    assert.equal(h.store.pending()[0]!.state, "UNKNOWN");
    await h.executor.recover(settings);
    assert.equal(h.broadcasts(), 1);
  } finally {
    h.close();
  }
});
test("local signer requires exact configured wallet and accepts a backend JSON/base58 secret", () => {
  const old = {
      key: env.SOLANA_PRIVATE_KEY,
      path: env.SOLANA_KEYPAIR_PATH,
      wallet: env.WALLET_PUBLIC_KEY,
    },
    kp = Keypair.generate();
  try {
    env.SOLANA_KEYPAIR_PATH = "";
    env.SOLANA_PRIVATE_KEY = "";
    assert.throws(localWallet, /MISSING_SOLANA/);
    env.SOLANA_PRIVATE_KEY = JSON.stringify([...kp.secretKey]);
    env.WALLET_PUBLIC_KEY = WALLET;
    assert.throws(localWallet, /WALLET_MISMATCH/);
    env.WALLET_PUBLIC_KEY = kp.publicKey.toBase58();
    assert.equal(localWallet().publicKey.toBase58(), env.WALLET_PUBLIC_KEY);
    env.SOLANA_PRIVATE_KEY = base58(kp.secretKey);
    assert.equal(localWallet().publicKey.toBase58(), env.WALLET_PUBLIC_KEY);
  } finally {
    env.SOLANA_PRIVATE_KEY = old.key;
    env.SOLANA_KEYPAIR_PATH = old.path;
    env.WALLET_PUBLIC_KEY = old.wallet;
  }
});
test("controlled run enforces hard cap, consumes one BUY durably and completes only after reconciled SELL plus memory", async () => {
  const h = harness();
  try {
    const control = ControlledSession.create(h.store),
      executor = new Executor(
        h.store,
        h.executor.gmgn,
        h.executor.rpc,
        h.execution,
        undefined,
        control,
      );
    const strategy = { ...settings, feeReserveLamports: "600000000" },
      intent = { ...h.intent, amount: "4000000" };
    assert.equal(CONTROLLED_BUY_CAP, 5000000n);
    assert.throws(
      () => control.validate({ ...intent, amount: "5000001" }),
      /CONTROLLED_PRINCIPAL_CAP/,
    );
    await executor.execute(intent, strategy, "0", async () => {});
    assert.equal(control.read().status, "OPEN");
    assert.equal(h.store.entriesEnabled(), false);
    const restored = new ControlledSession(h.store, control.id);
    assert.equal(restored.read().buySignature, "fixture-signature-1");
    await assert.rejects(
      () =>
        executor.execute(
          { ...intent, id: "another-buy" },
          strategy,
          "0",
          async () => {},
        ),
      /CONTROLLED_BUY_ALREADY_CONSUMED/,
    );
    assert.equal(h.broadcasts(), 1);
    const p = h.store.positions("live")[0]!;
    await executor.execute(
      h.executor.sellIntent(
        p,
        BigInt(p.quantity),
        "Manual controlled fixture exit",
        strategy,
      ),
      strategy,
      "0",
    );
    assert.equal(control.read().status, "COMPLETE");
    assert.equal(h.store.positions("live")[0]!.state, "CLOSED");
    assert.equal(
      h.store.db.prepare("SELECT count(*) n FROM trade_outcomes").get()!.n,
      0,
    );
    assert.equal(h.broadcasts(), 2);
  } finally {
    h.close();
  }
});

for (const stall of ["quote", "probe", "simulate", "pre-sign"] as const)
  test(
    "unsigned 60s watchdog releases " + stall + " and rejects late work",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const h = harness(),
        entered = deferred<void>(),
        gate = deferred<ExecutionQuote | void>();
      let signs = 0,
        probes = 0;
      const hang = async () => {
        entered.resolve();
        return gate.promise;
      };
      const originalBuy = h.execution.quoteBuy;
      if (stall === "quote")
        h.execution.quoteBuy = async () => (await hang()) as ExecutionQuote;
      if (stall === "probe")
        h.execution.quoteSell = async () => {
          probes++;
          return (await hang()) as ExecutionQuote;
        };
      if (stall === "simulate")
        h.execution.simulate = async () => {
          await hang();
        };
      if (stall === "pre-sign")
        h.execution.execute = async (_q, persist, beforeSign) => {
          await hang();
          beforeSign?.();
          signs++;
          persist("late-fake-signature");
          return "late-fake-signature";
        };
      const outcome = h.executor
        .execute(h.intent, settings, "0", async () => {})
        .catch((e) => e);
      try {
        await entered.promise;
        t.mock.timers.tick(UNSIGNED_EXECUTION_TIMEOUT_MS - 1);
        await flush();
        assert.equal(h.store.pending().length, 1);
        assert.equal(h.executor.isBusy, true);
        t.mock.timers.tick(1);
        const error = await outcome;
        assert.equal(error.code, "EXECUTION_UNSIGNED_TIMEOUT");
        assert.equal(h.store.pending().length, 0);
        assert.equal(h.store.reserved("live"), 0n);
        assert.equal(h.executor.isBusy, false);
        assert.equal(h.store.get("haltReason"), undefined);
        const failed = h.store.executions()[0]!;
        assert.equal(failed.state, "FAILED");
        assert.equal(failed.signature, undefined);
        assert.equal(h.store.positions("live")[0]!.state, "FAILED");
        assert.equal(
          h.store.db.prepare("SELECT count(*) n FROM trade_outcomes").get()!.n,
          0,
        );
        gate.resolve(
          stall === "quote"
            ? quote("BUY", BigInt(h.intent.amount))
            : stall === "probe"
              ? quote("SELL", 200000n, WALLET, true)
              : undefined,
        );
        await flush();
        assert.equal(h.store.executions()[0]!.state, "FAILED");
        assert.equal(signs, 0);
        assert.equal(h.broadcasts(), 0);
        if (stall === "probe")
          assert.equal(
            probes,
            1,
            "expired exit probes do not issue remaining requests",
          );
        if (stall === "quote") {
          h.execution.quoteBuy = originalBuy;
          const fresh = bindFixtureClaim(h.store, {
            ...h.intent,
            id: randomUUID(),
            positionId: randomUUID(),
            key: "fresh-after-timeout",
            attemptId: randomUUID(),
            ownershipClaimId: undefined,
            decisionId: randomUUID(),
            decisionAt: Date.now(),
            createdAt: Date.now(),
            expiresAt: Date.now() + settings.maxSnapshotAgeMs,
          });
          assert.equal(
            (await h.executor.execute(fresh, settings, "0", async () => {}))
              .state,
            "CONFIRMED",
          );
          assert.equal(
            h.broadcasts(),
            1,
            "next fresh attempt can execute without the old mutex",
          );
        }
      } finally {
        t.mock.timers.reset();
        h.close();
      }
    },
  );

test("60s unsigned SELL timeout preserves holding and allows later management", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness();
  try {
    await h.executor.execute(h.intent, settings, "0", async () => {});
    const p = h.store.positions("live")[0]!,
      before = {
        quantity: p.quantity,
        cost: p.remainingCostLamports,
        realized: p.realizedLamports,
      };
    const entered = deferred<void>(),
      gate = deferred<ExecutionQuote>();
    h.execution.quoteSell = async () => {
      entered.resolve();
      return gate.promise;
    };
    const work = h.executor
      .execute(
        h.executor.sellIntent(p, BigInt(p.quantity), "manual", settings),
        settings,
        "0",
      )
      .catch((e) => e);
    await entered.promise;
    t.mock.timers.tick(60000);
    assert.equal((await work).code, "EXECUTION_UNSIGNED_TIMEOUT");
    const after = h.store.positions("live")[0]!;
    assert.equal(after.state, "OPEN");
    assert.deepEqual(
      {
        quantity: after.quantity,
        cost: after.remainingCostLamports,
        realized: after.realizedLamports,
      },
      before,
    );
    assert.equal(h.executor.isBusy, false);
    assert.equal(h.store.pending().length, 0);
    assert.equal(h.broadcasts(), 1);
    gate.resolve(quote("SELL", BigInt(p.quantity)));
    await flush();
    assert.equal(h.broadcasts(), 1);
  } finally {
    t.mock.timers.reset();
    h.close();
  }
});

test("signed pending survives 60s and follows UNKNOWN reconciliation policy", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const h = harness(),
    entered = deferred<void>(),
    gate = deferred<string>();
  h.execution.execute = async (_q, persist, check) => {
    check?.();
    persist("signed-fixture-no-network");
    entered.resolve();
    return gate.promise;
  };
  const work = h.executor
    .execute(h.intent, settings, "0", async () => {})
    .catch((e) => e);
  try {
    await entered.promise;
    t.mock.timers.tick(65000);
    await flush();
    assert.equal(h.store.pending()[0]!.signature, "signed-fixture-no-network");
    assert.notEqual(h.store.pending()[0]!.state, "FAILED");
    gate.reject(new Blocked("JUPITER_TIMEOUT"));
    await work;
    assert.equal(h.store.pending()[0]!.state, "UNKNOWN");
    assert.equal(
      h.store.get<{ scope: string }>("lastFailure")?.scope,
      "TRANSACTION",
    );
    assert.equal(h.store.entriesEnabled(), true);
  } finally {
    t.mock.timers.reset();
    h.close();
  }
});

test("recovery never discards a CREATED row carrying a signature", async (t) => {
  const h = harness();
  try {
    const e = h.store.claim(h.intent, {
      balance: 1000000000n,
      reserve: BigInt(settings.feeReserveLamports),
    });
    e.signature = "signed-fixture-no-network";
    h.store.execution(e);
    const reconcile = t.mock.method(h.executor, "reconcile", async () => {});
    await h.executor.recover(settings);
    assert.equal(reconcile.mock.callCount(), 1);
    assert.equal(h.store.pending()[0]!.signature, e.signature);
    assert.notEqual(h.store.pending()[0]!.state, "FAILED");
  } finally {
    h.close();
  }
});
