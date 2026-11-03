import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { settingsSchema } from "../src/config.js";
import { size } from "../src/risk.js";
import { Store } from "../src/store.js";
import { KRONOS } from "../src/kronos-domain.js";
import type { KronosDecisionStrategy } from "../src/kronos-strategy.js";
import { mockExecutionCase } from "./one-shot-fixtures.js";
import { MINT, settings, jev } from "./fixtures.js";

test("buy percentage accepts two decimal places within 0.01–100 and defaults to 1", () => {
  assert.equal(settingsSchema.parse({}).positionSizePercent, 1);
  for (const percent of [0.01, 0.1, 0.29, 1, 2.5, 10, 99.99, 100])
    assert.equal(
      settingsSchema.parse({ positionSizePercent: percent })
        .positionSizePercent,
      percent,
    );
  for (const value of [0, -1, 100.01, NaN, Infinity, 0.001, 1.234, "2.5", null])
    assert.throws(() => settingsSchema.parse({ positionSizePercent: value }));
});

test("integer sizing applies configured percent after reserve and pending, with no floating balance loss", () => {
  assert.equal(size(1000000000n, 20000000n, 100000000n, 2.5).amount, 22000000n);
  assert.equal(
    size(1000000000n, 20000000n, 100000000n, 100).amount,
    880000000n,
  );
  assert.equal(
    size(12345678901234567890123n, 23n, 100n, 0.29).amount,
    (12345678901234567890000n * 29n) / 10000n,
  );
  assert.equal(size(299n, 0n, 0n, 1).amount, 2n);
  assert.equal(size(1n, 2n, 0n, 100).amount, 0n);
  assert.equal(size(1n, 0n, 0n, 0.01).amount, 0n);
  for (const bad of [0, 100.01, NaN, Infinity, 1.234])
    assert.throws(() => size(100000n, 0n, 0n, bad));
});

function kronos(): KronosDecisionStrategy {
  return {
    async evaluateEntry() {
      const at = Date.now();
      return {
        strategy: "KRONOS",
        decisionId: randomUUID(),
        decisionAt: at,
        action: "BUY",
        reason: "FIXTURE_BUY",
        evidence: {
          model: KRONOS.model.id,
          revision: KRONOS.model.revision,
          tokenizerRevision: KRONOS.tokenizer.revision,
          inputFrom: at - 3600000,
          inputTo: at,
          candleCount: 60,
          horizon: 5,
          samples: 3,
          terminalPrices: [1.01, 1.02, 1.03],
          terminalRangePct: [1, 3],
          lastObservedClose: 1,
        },
      };
    },
    async evaluatePosition() {
      throw Error("NOT_USED");
    },
    stop() {},
    status() {
      return {};
    },
  };
}

for (const strategy of ["STANDARD", "KRONOS"] as const)
  test(`${strategy} winner uses 2.5% consistently in status, approved intent and fake execution`, async (t) => {
    const f = mockExecutionCase(
      undefined,
      strategy === "KRONOS" ? { historyMinutes: 60, kronos: kronos() } : {},
    );
    const realSign = t.mock.method(
      VersionedTransaction.prototype,
      "sign",
      () => {
        throw Error("REAL_SIGN_FORBIDDEN");
      },
    );
    try {
      if (strategy === "KRONOS")
        f.e.jev.decide = async () => ({ ...jev(), action: "SKIP" });
      f.e.updateSettings({ ...f.e.settings, positionSizePercent: 2.5 });
      assert.equal((await f.e.status()).nextBuyLamports, "24500000");
      await f.e.analyze(MINT);
      await f.e.settleEntryEvaluations();
      const execution = f.store.executions()[0];
      assert.ok(execution);
      assert.equal(execution.intent.strategy, strategy);
      assert.equal(execution.intent.amount, "24500000");
      assert.equal(execution.intent.positionSizePercent, 2.5);
      assert.equal(execution.state, "CONFIRMED");
      assert.equal(f.stats().signed, 1);
      assert.equal(realSign.mock.callCount(), 0);
      assert.equal(
        f.store.get<typeof settings>("strategyV2")?.positionSizePercent,
        2.5,
      );
      assert.throws(() =>
        f.e.updateSettings({ ...f.e.settings, positionSizePercent: 0 }),
      );
      assert.equal(f.e.settings.positionSizePercent, 2.5);
    } finally {
      await f.close();
    }
  });

for (const boundary of ["QUOTE", "IMMEDIATE_PRE_SIGN"] as const)
  test(`percentage changed at ${boundary} blocks unsigned old-size intent`, async () => {
    const f = mockExecutionCase();
    try {
      if (boundary === "QUOTE") {
        const original = f.e.executor.provider.quoteBuy.bind(
          f.e.executor.provider,
        );
        f.e.executor.provider.quoteBuy = async (...args) => {
          f.e.updateSettings({ ...f.e.settings, positionSizePercent: 2.5 });
          return original(...args);
        };
      } else {
        const original = f.e.executor.provider.execute.bind(
          f.e.executor.provider,
        );
        f.e.executor.provider.execute = async (...args) => {
          f.e.updateSettings({ ...f.e.settings, positionSizePercent: 2.5 });
          return original(...args);
        };
      }
      await assert.rejects(f.e.analyze(MINT));
      await f.e.settleEntryEvaluations();
      assert.equal(f.stats().signed, 0);
      assert.equal(
        f.store.positions("live").filter((p) => p.state === "OPEN").length,
        0,
      );
      assert.match(
        f.store.executions()[0]?.error ?? "",
        /TEMPORARY_RISK_CHANGE/,
      );
      assert.equal(
        f.e.attempts.current?.reasonCode,
        "POSITION_SIZE_SETTING_CHANGED",
      );
    } finally {
      await f.close();
    }
  });

test("larger configured percent still cannot bypass fresh Security", async () => {
  const f = mockExecutionCase("SECURITY");
  try {
    f.e.updateSettings({ ...f.e.settings, positionSizePercent: 50 });
    await assert.rejects(f.e.analyze(MINT));
    await f.e.settleEntryEvaluations();
    assert.equal(f.stats().signed, 0);
    assert.equal(
      f.store.positions("live").filter((p) => p.state === "OPEN").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("saved 10 percent survives Store reopen and old migration 5 does not reset it", () => {
  const dir = mkdtempSync(join(tmpdir(), "buy-size-reopen-"));
  const path = join(dir, "fixture.sqlite");
  let store: Store | undefined;
  try {
    store = new Store(path);
    store.set("strategyV2", { ...settings, positionSizePercent: 10 });
    store.close();
    store = undefined;
    store = new Store(path);
    const saved = store.get<typeof settings>("strategyV2");
    assert.equal(saved?.positionSizePercent, 10);
    assert.equal(settingsSchema.parse(saved).positionSizePercent, 10);
  } finally {
    store?.close();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.includes("buy-size-reopen-"));
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
