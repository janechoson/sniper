import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { VersionedTransaction } from "@solana/web3.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { CandidateAttempts } from "../src/candidate-attempt.js";
import type { Strategy, Intent, BuyOwnershipClaim } from "../src/domain.js";
import type {
  KronosDecision,
  KronosDecisionStrategy,
} from "../src/kronos-strategy.js";
import { KRONOS } from "../src/kronos-domain.js";
import { resetStrategyData } from "../scripts/reset-strategy-data.js";
import { jev, MINT, provider, settings, quote } from "./fixtures.js";
import { mockExecutionCase, recentCandidate } from "./one-shot-fixtures.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function kronosDecision(action: "BUY" | "WAIT"): KronosDecision {
  const at = Date.now(),
    end = Math.floor(at / 60000) * 60000;
  return {
    strategy: "KRONOS",
    decisionId: randomUUID(),
    decisionAt: at,
    action,
    reason: "FIXTURE_" + action,
    evidence: {
      model: KRONOS.model.id,
      revision: KRONOS.model.revision,
      tokenizerRevision: KRONOS.tokenizer.revision,
      inputFrom: end - 3600000,
      inputTo: end,
      candleCount: 60,
      horizon: 5,
      samples: 3,
      terminalPrices: [1.01, 1.02, 1.03],
      terminalRangePct: [1, 3],
      lastObservedClose: 1,
    },
  };
}
function raceFixture(failure?: Parameters<typeof mockExecutionCase>[0]) {
  const standard = deferred<"BUY" | "SKIP">(),
    kronos = deferred<"BUY" | "WAIT">();
  const standardStarted = deferred<void>(),
    kronosStarted = deferred<void>();
  const model: KronosDecisionStrategy = {
    evaluateEntry: async () => {
      kronosStarted.resolve();
      return kronosDecision(await kronos.promise);
    },
    evaluatePosition: async () => {
      throw Error("POSITION_INFERENCE_NOT_USED");
    },
    stop() {
      kronos.resolve("WAIT");
      standard.resolve("SKIP");
    },
    status() {
      return {};
    },
  };
  const f = mockExecutionCase(failure, { kronos: model, historyMinutes: 60 });
  f.e.jev.decide = async (input) => {
    standardStarted.resolve();
    return { ...jev(input), action: await standard.promise };
  };
  const started = Promise.all([standardStarted.promise, kronosStarted.promise]);
  return { ...f, standard, kronos, started };
}
function evaluations(f: ReturnType<typeof raceFixture>) {
  return f.e.attempts.current!.summaries.strategies as Record<
    Strategy,
    { decision: string; execution: string; owner?: Strategy }
  >;
}
function checkSingleWinner(f: ReturnType<typeof raceFixture>, owner: Strategy) {
  const claim = f.store.buyOwnership(
    MINT,
    "live",
    f.e.attempts.current!.attemptId,
  )!;
  assert.equal(claim.strategy, owner);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM buy_ownership_claims").get()!.n,
    1,
  );
  assert.equal(f.store.executions().length, 1);
  assert.equal(f.store.positions("live").length, 1);
  assert.equal(f.store.executions()[0]!.intent.strategy, owner);
  assert.equal(f.store.executions()[0]!.intent.ownershipClaimId, claim.id);
  assert.equal(f.store.positions("live")[0]!.ownershipClaimId, claim.id);
}

for (const owner of ["STANDARD", "KRONOS"] as const)
  test(`${owner} first valid BUY executes immediately without waiting for peer`, async (t) => {
    const f = raceFixture(),
      sign = t.mock.method(VersionedTransaction.prototype, "sign", () => {
        throw Error("REAL_SIGN_FORBIDDEN");
      });
    try {
      const work = f.e.analyze(MINT);
      await f.started;
      if (owner === "STANDARD") f.standard.resolve("BUY");
      else f.kronos.resolve("BUY");
      await work;
      assert.equal(
        f.stats().signed,
        1,
        "Fake executor completed while peer is still unresolved",
      );
      checkSingleWinner(f, owner);
      const loser = owner === "STANDARD" ? "KRONOS" : "STANDARD";
      assert.equal(evaluations(f)[loser].decision, "CHECKING");
      if (owner === "STANDARD") f.kronos.resolve("BUY");
      else f.standard.resolve("BUY");
      await f.e.settleEntryEvaluations();
      assert.equal(evaluations(f)[owner].decision, "BUY");
      assert.equal(evaluations(f)[loser].decision, "BUY");
      assert.equal(
        evaluations(f)[loser].execution,
        "BLOCKED_OWNER_ALREADY_CLAIMED",
      );
      assert.equal(evaluations(f)[loser].owner, owner);
      assert.equal(f.store.count("strategy_evaluations"), 2);
      assert.equal(sign.mock.callCount(), 0);
      assert.equal(f.g.calls.filter((a) => a[1] === "kline").length, 1);
      assert.equal(
        f.g.calls.filter((a) => a[1] === "info" && a.includes(MINT)).length,
        2,
        "Initial + winner final only",
      );
      assert.equal(
        f.g.calls.filter((a) => a[1] === "security" && a.includes(MINT)).length,
        2,
        "No duplicate common/final Security for peer",
      );
    } finally {
      await f.close();
    }
  });

test("same-turn BUY completions produce one owner, one denied claim and one execution without asserting winner", async () => {
  const f = raceFixture();
  try {
    const work = f.e.analyze(MINT);
    await f.started;
    f.standard.resolve("BUY");
    f.kronos.resolve("BUY");
    await work;
    await f.e.settleEntryEvaluations();
    const owner = f.store.buyOwnership(MINT, "live")!.strategy;
    checkSingleWinner(f, owner);
    const values = Object.values(evaluations(f));
    assert.equal(
      values.filter((x) => x.execution === "BLOCKED_OWNER_ALREADY_CLAIMED")
        .length,
      1,
    );
    assert.equal(values.filter((x) => x.decision === "BUY").length, 2);
    assert.equal(f.stats().signed, 1);
  } finally {
    await f.close();
  }
});

for (const invalid of ["STANDARD_HIGH_RISK", "KRONOS_STALE"] as const)
  test(`first model BUY ${invalid} cannot claim; the other valid BUY wins`, async () => {
    const f = raceFixture(),
      qualified = deferred<void>();
    const evaluate = f.e.risk.evaluate.bind(f.e.risk);
    f.e.risk.evaluate = (...args) => {
      const result = evaluate(...args);
      if (
        args[4] === "QUALIFICATION" &&
        args[0].strategy ===
          (invalid === "STANDARD_HIGH_RISK" ? "STANDARD" : "KRONOS")
      )
        qualified.resolve();
      return result;
    };
    if (invalid === "STANDARD_HIGH_RISK") {
      const decide = f.e.jev.decide.bind(f.e.jev);
      f.e.jev.decide = async (...args) => ({
        ...(await decide(...args)),
        risk: "HIGH",
      });
    } else {
      const decide = f.e.kronos.evaluateEntry.bind(f.e.kronos);
      f.e.kronos.evaluateEntry = async (input) => ({
        ...(await decide(input)),
        decisionAt: Date.now() - 600000,
      });
    }
    try {
      const work = f.e.analyze(MINT);
      await f.started;
      if (invalid === "STANDARD_HIGH_RISK") f.standard.resolve("BUY");
      else f.kronos.resolve("BUY");
      await qualified.promise;
      assert.equal(f.store.buyOwnership(MINT, "live"), undefined);
      assert.equal(f.store.executions().length, 0);
      if (invalid === "STANDARD_HIGH_RISK") f.kronos.resolve("BUY");
      else f.standard.resolve("BUY");
      await work;
      await f.e.settleEntryEvaluations();
      checkSingleWinner(
        f,
        invalid === "STANDARD_HIGH_RISK" ? "KRONOS" : "STANDARD",
      );
    } finally {
      await f.close();
    }
  });

for (const failure of ["SECURITY", "EXIT", "SIMULATE", "UNKNOWN"] as const)
  test(`winning claim ${failure} does not transfer to late peer BUY`, async () => {
    const f = raceFixture(failure);
    try {
      const work = f.e.analyze(MINT);
      const rejected = assert.rejects(work);
      await f.started;
      f.standard.resolve("BUY");
      await rejected;
      f.kronos.resolve("BUY");
      await f.e.settleEntryEvaluations();
      const claim = f.store.buyOwnership(
        MINT,
        "live",
        f.e.attempts.current!.attemptId,
      )!;
      assert.equal(claim.strategy, "STANDARD");
      assert.equal(evaluations(f).KRONOS.decision, "BUY");
      assert.equal(
        evaluations(f).KRONOS.execution,
        "BLOCKED_OWNER_ALREADY_CLAIMED",
      );
      assert.equal(
        f.store.db.prepare("SELECT count(*) n FROM buy_ownership_claims").get()!
          .n,
        1,
      );
      assert.ok(f.store.executions().length <= 1);
      assert.ok(f.store.positions("live").length <= 1);
      if (failure === "UNKNOWN") {
        assert.equal(claim.active, true);
        assert.equal(f.stats().signed, 1);
        assert.equal(f.store.pending().length, 1);
      } else {
        assert.equal(claim.active, false);
        assert.equal(f.stats().signed, 0);
      }
    } finally {
      await f.close();
    }
  });

for (const owner of ["STANDARD", "KRONOS"] as const)
  test(`${owner} claim is durable before actual sizing/quote/simulation`, async () => {
    const f = raceFixture();
    const approve = f.e.risk.approve.bind(f.e.risk),
      quote = f.e.executor.provider.quoteBuy.bind(f.e.executor.provider);
    let sizeChecked = false,
      quoteChecked = false;
    f.e.risk.approve = (...args) => {
      assert.equal(f.store.buyOwnership(MINT, "live")!.strategy, owner);
      assert.equal(f.store.executions().length, 0);
      sizeChecked = true;
      return approve(...args);
    };
    f.e.executor.provider.quoteBuy = async (...args) => {
      assert.equal(f.store.buyOwnership(MINT, "live")!.strategy, owner);
      quoteChecked = true;
      return quote(...args);
    };
    try {
      const work = f.e.analyze(MINT);
      await f.started;
      if (owner === "STANDARD") f.standard.resolve("BUY");
      else f.kronos.resolve("BUY");
      await work;
      assert.equal(sizeChecked, true);
      assert.equal(quoteChecked, true);
    } finally {
      await f.close();
    }
  });

test("WAIT/reject are independent strategy decisions and do not reserve ownership", async () => {
  const f = raceFixture();
  try {
    const work = f.e.analyze(MINT),
      rejected = assert.rejects(work);
    await f.started;
    f.standard.resolve("SKIP");
    f.kronos.resolve("WAIT");
    await rejected;
    await f.e.settleEntryEvaluations();
    assert.equal(evaluations(f).STANDARD.decision, "REJECT");
    assert.equal(evaluations(f).KRONOS.decision, "WAIT");
    assert.equal(f.store.buyOwnership(MINT, "live"), undefined);
    assert.equal(f.store.executions().length, 0);
  } finally {
    await f.close();
  }
});

test("a branch error does not prevent the other branch from claiming a valid BUY", async () => {
  const f = raceFixture();
  try {
    const work = f.e.analyze(MINT);
    await f.started;
    f.standard.reject(Error("FIXTURE_JEV_UNAVAILABLE"));
    f.kronos.resolve("BUY");
    await work;
    await f.e.settleEntryEvaluations();
    checkSingleWinner(f, "KRONOS");
    assert.equal(evaluations(f).STANDARD.decision, "REJECT");
  } finally {
    await f.close();
  }
});

const authority = {
  revision: 0,
  path: "TRENDING" as const,
  policy: "TRENDING_ONE_SHOT_V1" as const,
};
function claimInput(strategy: Strategy, attemptId: string = randomUUID()) {
  return {
    mode: "paper" as const,
    mint: MINT,
    strategy,
    attemptId,
    decisionId: randomUUID(),
    decisionAt: Date.now(),
  };
}
function intent(claim: BuyOwnershipClaim): Intent {
  return {
    id: randomUUID(),
    key: randomUUID(),
    mode: claim.mode,
    mint: claim.mint,
    strategy: claim.strategy,
    decisionSource: claim.strategy === "KRONOS" ? "KRONOS" : "JEV",
    decisionId: claim.decisionId,
    decisionAt: claim.decisionAt,
    attemptId: claim.attemptId,
    ownershipClaimId: claim.id,
    provider: "JUPITER",
    side: "BUY",
    positionId: randomUUID(),
    amount: "100",
    snapshotHash: "fixture",
    createdAt: Date.now(),
    expiresAt: Date.now() + 45000,
    reason: "fixture",
    entryAuthority: authority,
  };
}
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "first-buy-wins-"));
  return {
    dir,
    path: join(dir, "fixture.sqlite"),
    cleanup() {
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
      assert.ok(basename(dir).startsWith("first-buy-wins-"));
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}

test("two independent worker threads race the actual Store transaction: exactly one SQL winner", async () => {
  const temp = temporaryDirectory(),
    store = new Store(temp.path);
  store.set("newEntriesEnabled", true);
  store.close();
  const attemptId = randomUUID(),
    workers: Worker[] = [];
  try {
    const jobs = (["STANDARD", "KRONOS"] as const).map((strategy) => {
      const ready = deferred<void>(),
        result = deferred<any>();
      void result.promise.catch(() => {});
      const worker = new Worker(
        new URL("./buy-claim-worker.ts", import.meta.url),
        {
          execArgv: [
            "--import",
            "tsx",
            "--import",
            pathToFileURL(resolve("scripts/test-env.mjs")).href,
          ],
          workerData: {
            path: temp.path,
            input: claimInput(strategy, attemptId),
            authority,
          },
        },
      );
      workers.push(worker);
      const exited = new Promise<void>((resolve, reject) =>
        worker.once("exit", (code) =>
          code === 0 ? resolve() : reject(Error("Claim worker exit " + code)),
        ),
      );
      void exited.catch(() => {});
      worker.on("message", (m) => {
        if (m.ready) ready.resolve();
        else if (m.error) result.reject(Error(m.error));
        else result.resolve(m.result);
      });
      worker.on("error", (e) => {
        ready.reject(e);
        result.reject(e);
      });
      return { worker, ready: ready.promise, result: result.promise, exited };
    });
    await Promise.all(jobs.map((j) => j.ready));
    for (const job of jobs) job.worker.postMessage("CLAIM");
    const outcomes = await Promise.all(jobs.map((j) => j.result));
    await Promise.all(jobs.map((j) => j.exited));
    assert.equal(outcomes.filter((x) => x.claimed).length, 1);
    assert.equal(outcomes.filter((x) => !x.claimed).length, 1);
    const reopened = new Store(temp.path);
    try {
      assert.equal(
        reopened.db
          .prepare("SELECT count(*) n FROM buy_ownership_claims")
          .get()!.n,
        1,
      );
      assert.equal(reopened.executions().length, 0);
      assert.equal(reopened.positions().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    temp.cleanup();
  }
});

for (const owner of ["STANDARD", "KRONOS"] as const)
  for (const state of ["CLAIMED", "SUBMITTED", "UNKNOWN", "OPEN"] as const)
    test(`restart preserves ${owner} ${state} owner and blocks another attempt`, async () => {
      const temp = temporaryDirectory();
      let store = new Store(temp.path),
        engine: Engine | undefined;
      try {
        store.set("newEntriesEnabled", true);
        const attemptSink = new CandidateAttempts(store);
        const pendingAttempt = attemptSink.begin(recentCandidate());
        const input = claimInput(owner, pendingAttempt.attemptId);
        const result = store.claimMintForBuy(input, authority);
        assert.equal(result.claimed, true);
        if (!result.claimed) throw Error("No fixture claim");
        const c = result.claim;
        if (state !== "CLAIMED") {
          const i = intent(c);
          attemptSink.summary("intentId", i.id);
          const e = store.claim(i);
          e.state = state === "OPEN" ? "CONFIRMED" : state;
          e.signature = "FAKE_DURABLE_SIGNATURE";
          store.execution(e);
          if (state === "OPEN") {
            const p = store.positions("paper")[0]!;
            p.state = "OPEN";
            p.quantity = p.originalQuantity = "100";
            store.savePosition(p);
          }
        }
        store.close();
        store = new Store(temp.path);
        engine = new Engine(store, { gmgn: provider().gmgn });
        assert.equal(store.buyOwnership(MINT, "paper")!.strategy, owner);
        assert.equal(
          store.attempt(pendingAttempt.attemptId)!.result,
          state === "OPEN"
            ? "BOUGHT"
            : state === "CLAIMED"
              ? "REJECTED"
              : "RECONCILING",
        );
        assert.equal(store.entryBlocked(MINT, "paper"), true);
        const other = store.claimMintForBuy(
          claimInput(owner === "STANDARD" ? "KRONOS" : "STANDARD"),
          authority,
        );
        assert.equal(other.claimed, false);
        if (!other.claimed) assert.equal(other.reason, "OWNED_BY_" + owner);
      } finally {
        await engine?.stop();
        store.close();
        temp.cleanup();
      }
    });

test("unsigned failure seals this attempt; a later fresh attempt may claim only after safe completion", () => {
  const store = new Store(":memory:");
  try {
    const input = claimInput("STANDARD"),
      first = store.claimMintForBuy(input, authority);
    assert.ok(first.claimed);
    store.finishBuyOwnership(MINT, "paper", input.attemptId);
    const same = store.claimMintForBuy(
      { ...input, strategy: "KRONOS", decisionId: randomUUID() },
      authority,
    );
    assert.equal(same.claimed, false);
    const fresh = store.claimMintForBuy(claimInput("KRONOS"), authority);
    assert.equal(fresh.claimed, true);
  } finally {
    store.close();
  }
});

test("the winner cannot create a second BUY execution under the same claim after unsigned failure", () => {
  const store = new Store(":memory:");
  try {
    const result = store.claimMintForBuy(claimInput("STANDARD"), authority);
    assert.ok(result.claimed);
    const first = store.claim(intent(result.claim));
    first.state = "FAILED";
    store.execution(first);
    const p = store.positions("paper")[0]!;
    p.state = "FAILED";
    store.savePosition(p);
    assert.throws(
      () => store.claim(intent(result.claim)),
      /BUY_CLAIM_EXECUTION_ALREADY_CREATED/,
    );
    assert.equal(store.executions().length, 1);
    assert.equal(store.positions().length, 1);
  } finally {
    store.close();
  }
});

test("owned BUY intent cannot forge strategy/claim/decision binding; orphan ownership blocks destructive reset", () => {
  const store = new Store(":memory:");
  try {
    const claimed = store.claimMintForBuy(claimInput("KRONOS"), authority);
    assert.ok(claimed.claimed);
    const i = intent(claimed.claim);
    for (const bad of [
      { ...i, strategy: "STANDARD" as const },
      { ...i, decisionId: "wrong" },
      { ...i, ownershipClaimId: "wrong" },
      { ...i, ownershipClaimId: undefined },
    ])
      assert.throws(() => store.claim(bad), /BUY_OWNERSHIP/);
    assert.equal(store.executions().length, 0);
    assert.equal(store.positions().length, 0);
    assert.throws(
      () =>
        resetStrategyData(store.db, {
          backupVerified: true,
          backupPath: "FIXTURE_ONLY",
        }),
      /RESET_ABORT_ACTIVE_BUY_OWNERSHIP/,
    );
  } finally {
    store.close();
  }
});

test("completed Position releases the mint for a fresh attempt while keeping the original owner immutable", () => {
  const store = new Store(":memory:");
  try {
    const c = store.claimMintForBuy(claimInput("KRONOS"), authority);
    assert.ok(c.claimed);
    const e = store.claim(intent(c.claim));
    e.state = "CONFIRMED";
    store.execution(e);
    const p = store.positions("paper")[0]!;
    p.state = "CLOSED";
    p.quantity = "0";
    p.originalQuantity = "100";
    store.savePosition(p);
    assert.equal(store.buyOwnership(MINT, "paper"), undefined);
    assert.equal(
      store.buyOwnership(MINT, "paper", c.claim.attemptId)!.strategy,
      "KRONOS",
    );
    const next = store.claimMintForBuy(claimInput("STANDARD"), authority);
    assert.equal(next.claimed, true);
    assert.throws(
      () => store.savePosition({ ...p, strategy: "STANDARD" }),
      /OWNER_IMMUTABLE/,
    );
  } finally {
    store.close();
  }
});

test("late research updates remain bound to the old attempt rather than overwriting the next candidate", () => {
  const store = new Store(":memory:"),
    attempts = new CandidateAttempts(store);
  try {
    const first = attempts.begin(recentCandidate());
    attempts.end("REJECTED");
    const next = attempts.begin({ ...recentCandidate(), symbol: "NEXT" });
    attempts.strategy(first.attemptId, "KRONOS", {
      decision: "BUY",
      execution: "BLOCKED_OWNER_ALREADY_CLAIMED",
      owner: "STANDARD",
    });
    assert.equal(attempts.current!.attemptId, next.attemptId);
    assert.equal(attempts.current!.summaries.strategies, undefined);
    assert.equal(
      (store.attempt(first.attemptId)!.summaries.strategies as any).KRONOS
        .decision,
      "BUY",
    );
  } finally {
    store.close();
  }
});

test("legacy strategy settings migrate to the one concurrent FIRST_BUY_WINS policy", async () => {
  const store = new Store(":memory:");
  store.set("strategyV2", { ...settings, entryStrategy: "KRONOS" });
  const engine = new Engine(store, { gmgn: provider().gmgn });
  try {
    assert.equal(engine.settings.entryStrategy, "FIRST_BUY_WINS");
    engine.updateSettings({ ...engine.settings, entryStrategy: "STANDARD" });
    assert.equal(engine.settings.entryStrategy, "FIRST_BUY_WINS");
  } finally {
    await engine.stop();
    store.close();
  }
});

test("unsigned execution timeout releases real ownership without halting or granting the peer another execution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = raceFixture(),
    entered = deferred<void>(),
    gate = deferred<ReturnType<typeof quote>>();
  f.e.executor.provider.quoteBuy = async () => {
    entered.resolve();
    return gate.promise;
  };
  let reachedQuote = false,
    settled = false;
  entered.promise.then(() => {
    reachedQuote = true;
  });
  f.standard.resolve("BUY");
  const work = f.e.analyze(MINT).catch((e) => e);
  void work.then(() => {
    settled = true;
  });
  try {
    for (let step = 0; step < 1000 && !reachedQuote && !settled; step++) {
      for (let micro = 0; micro < 50; micro++) await Promise.resolve();
      t.mock.timers.tick(50);
    }
    assert.equal(
      reachedQuote,
      true,
      "fake provider pipeline reached quote before timeout",
    );
    t.mock.timers.tick(60000);
    assert.equal((await work).code, "EXECUTION_UNSIGNED_TIMEOUT");
    const row = f.store.executions()[0]!,
      claim = f.store.buyOwnership(MINT, "live", row.intent.attemptId!)!;
    assert.equal(claim.active, false);
    assert.equal(claim.resolution, "FAILED_UNSIGNED");
    assert.equal(f.store.pending().length, 0);
    assert.equal(f.store.reserved("live"), 0n);
    assert.equal(f.store.get("haltReason"), undefined);
    assert.equal(f.e.executor.isBusy, false);
    f.kronos.resolve("WAIT");
    await f.e.settleEntryEvaluations();
    gate.resolve(quote("BUY", BigInt(row.intent.amount)));
    for (let n = 0; n < 50; n++) await Promise.resolve();
    assert.equal(f.store.executions().length, 1);
    assert.equal(f.store.executions()[0]!.state, "FAILED");
    assert.equal(f.stats().signed, 0);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM trade_outcomes").get()!.n,
      0,
    );
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
