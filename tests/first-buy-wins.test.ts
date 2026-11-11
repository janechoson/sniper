import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resetStrategyData } from "../scripts/reset-strategy-data.js";
import { CandidateAttempts } from "../src/candidate-attempt.js";
import type { BuyOwnershipClaim, Intent, Strategy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { MINT, provider } from "./fixtures.js";
import { fakeKronos } from "./kronos-fixtures.js";
import { recentCandidate } from "./one-shot-fixtures.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const authority = {
  revision: 0,
  path: "TRENDING" as const,
  policy: "TRENDING_ONE_SHOT_V1" as const,
};
function claimInput(strategy: Strategy, attemptId: string = randomUUID()) {
  return {
    mode: "demo" as const,
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
    const jobs = (["KRONOS", "KRONOS"] as const).map((strategy) => {
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

for (const owner of ["KRONOS"] as const)
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
            const p = store.positions("demo")[0]!;
            p.state = "OPEN";
            p.quantity = p.originalQuantity = "100";
            store.savePosition(p);
          }
        }
        store.close();
        store = new Store(temp.path);
        engine = new Engine(store, {
          gmgn: provider().gmgn,
          kronos: fakeKronos(),
        });
        assert.equal(store.buyOwnership(MINT, "demo")!.strategy, owner);
        assert.equal(
          store.attempt(pendingAttempt.attemptId)!.result,
          state === "OPEN"
            ? "BOUGHT"
            : state === "CLAIMED"
              ? "REJECTED"
              : "RECONCILING",
        );
        assert.equal(store.entryBlocked(MINT, "demo"), true);
        const other = store.claimMintForBuy(claimInput("KRONOS"), authority);
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
    const input = claimInput("KRONOS"),
      first = store.claimMintForBuy(input, authority);
    assert.ok(first.claimed);
    store.finishBuyOwnership(MINT, "demo", input.attemptId);
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
    const result = store.claimMintForBuy(claimInput("KRONOS"), authority);
    assert.ok(result.claimed);
    const first = store.claim(intent(result.claim));
    first.state = "FAILED";
    store.execution(first);
    const p = store.positions("demo")[0]!;
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
      assert.throws(() => store.claim(bad), /BUY_OWNERSHIP|KRONOS_ONLY/);
    assert.equal(store.executions().length, 0);
    assert.equal(store.positions().length, 0);
    assert.throws(
      () =>
        resetStrategyData(store.db, {
          backupVerified: true,
          backupPath: "FIXTURE_ONLY",
        }),
      /RESET_ABORT_ACTIVE_BUY_OWNERSHIP|RESET_ABORT_UNMAPPED_TABLE/,
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
    const p = store.positions("demo")[0]!;
    p.state = "CLOSED";
    p.quantity = "0";
    p.originalQuantity = "100";
    store.savePosition(p);
    assert.equal(store.buyOwnership(MINT, "demo"), undefined);
    assert.equal(
      store.buyOwnership(MINT, "demo", c.claim.attemptId)!.strategy,
      "KRONOS",
    );
    const next = store.claimMintForBuy(claimInput("KRONOS"), authority);
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
