import assert from "node:assert/strict";
import { test } from "node:test";
import { CandidateLifecycle } from "../src/candidate-lifecycle.js";
import { settingsSchema } from "../src/config.js";
import { CandidateRejected } from "../src/domain.js";
import { cheapGuard, RiskEngine } from "../src/risk.js";
import { Store } from "../src/store.js";
import { candidate, MINT, settings, snapshot } from "./fixtures.js";
import { mockExecutionCase, setup } from "./one-shot-fixtures.js";

const OTHER = "So11111111111111111111111111111111111111112";

test("blacklist defaults empty, validates addresses and removes duplicates without changing case", () => {
  assert.deepEqual(settingsSchema.parse({}).tokenBlacklist, []);
  assert.deepEqual(
    settingsSchema.parse({ tokenBlacklist: [` ${MINT} `, OTHER, MINT] })
      .tokenBlacklist,
    [MINT, OTHER],
  );
  for (const value of [["bad-address"], ["z".repeat(44)], "[]", [""]])
    assert.equal(
      settingsSchema.safeParse({ tokenBlacklist: value }).success,
      false,
    );
});

test("blacklisted queued tokens are skipped without consuming queue slots and removal allows a later appearance", () => {
  const store = new Store(":memory:");
  let current = { ...settings, candidateQueueSize: 1 };
  try {
    const lifecycle = new CandidateLifecycle(store, () => current);
    store.discover(candidate());
    assert.deepEqual(lifecycle.refill(store.tokens()), [MINT]);
    current = { ...current, tokenBlacklist: [MINT] };
    store.discover({ ...candidate(), mint: OTHER });
    assert.deepEqual(lifecycle.refill(store.tokens()), [OTHER]);
    assert.equal(lifecycle.get(MINT), undefined);
    assert.equal(
      Number(
        store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM trending_appearances WHERE mint=? AND consumed=0",
          )
          .get(MINT)?.n,
      ),
      0,
    );
    current = { ...current, tokenBlacklist: [] };
    lifecycle.setState(OTHER, "ANALYZING");
    lifecycle.finish(OTHER);
    store.discover(candidate());
    assert.deepEqual(lifecycle.refill(store.tokens()), [MINT]);
  } finally {
    store.close();
  }
});

test("direct analysis skips blacklist before any provider call and saved removal takes effect", async () => {
  const { engine, store, p, calls } = setup();
  try {
    engine.updateSettings({ ...engine.settings, tokenBlacklist: [MINT] });
    assert.deepEqual(
      store.get<{ tokenBlacklist: string[] }>("strategyV2")?.tokenBlacklist,
      [MINT],
    );
    await engine.analyze(MINT);
    assert.equal(p.calls.length, 0);
    assert.equal(calls(), 0);
    assert.equal(store.executions().length, 0);
    engine.updateSettings({ ...engine.settings, tokenBlacklist: [] });
    await engine.analyze(MINT);
    assert.ok(p.calls.length > 0);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("adding blacklist during analysis rejects before the next stage and before executing", async () => {
  const { engine, store } = setup();
  const original = engine.gmgn.info.bind(engine.gmgn);
  engine.gmgn.info = async (...args) => {
    const info = await original(...args);
    engine.updateSettings({ ...engine.settings, tokenBlacklist: [MINT] });
    return info;
  };
  try {
    await assert.rejects(
      engine.analyze(MINT),
      (error: unknown) =>
        error instanceof CandidateRejected &&
        error.details.reason === "TOKEN_BLACKLISTED",
    );
    assert.equal(store.executions().length, 0);
  } finally {
    await engine.stop();
    store.close();
  }
});

test("blacklist rejects both entry strategies in cheap and final risk checks", () => {
  const blocked = { ...settings, tokenBlacklist: [MINT] };
  assert.equal(
    cheapGuard(candidate(), snapshot().market, blocked).reason,
    "TOKEN_BLACKLISTED",
  );
  for (const strategy of ["STANDARD", "KRONOS"] as const) {
    const result = new RiskEngine().evaluate(
      { ...snapshot(), strategy },
      blocked,
      {
        balance: 1000000000n,
        pending: 0n,
        positions: 0,
        duplicate: false,
        entriesEnabled: true,
      },
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "TOKEN_BLACKLISTED");
  }
});

test("executor reads the latest blacklist immediately before signing", async () => {
  const fixture = mockExecutionCase();
  const execute = fixture.execution.execute;
  fixture.execution.execute = async (...args) => {
    fixture.e.updateSettings({ ...fixture.e.settings, tokenBlacklist: [MINT] });
    return execute(...args);
  };
  try {
    await assert.rejects(
      fixture.e.analyze(MINT),
      (error: unknown) =>
        error instanceof CandidateRejected &&
        error.details.reason === "TOKEN_BLACKLISTED",
    );
    assert.equal(fixture.stats().signed, 0);
    assert.equal(
      fixture.store.executions().some((execution) => execution.signature),
      false,
    );
  } finally {
    await fixture.close();
  }
});
