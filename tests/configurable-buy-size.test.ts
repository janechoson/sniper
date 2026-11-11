import { VersionedTransaction } from "@solana/web3.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { settingsSchema } from "../src/config.js";
import { KRONOS } from "../src/kronos-domain.js";
import type { KronosDecisionStrategy } from "../src/kronos-strategy.js";
import {
  fixedSolLamports,
  positionSizeMatches,
} from "../src/position-sizing.js";
import { size } from "../src/risk.js";
import { Store } from "../src/store.js";
import { MINT, settings } from "./fixtures.js";
import { mockExecutionCase } from "./one-shot-fixtures.js";

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

test("sizing mode preserves percent defaults and validates exact positive SOL settings", () => {
  const defaults = settingsSchema.parse({});
  assert.equal(defaults.positionSizeMode, "PERCENT");
  assert.equal(defaults.positionSizeSol, 0.2);
  for (const sol of [0.000000001, 0.2, 0.29, 1.123456789]) {
    assert.equal(
      settingsSchema.parse({ positionSizeMode: "SOL", positionSizeSol: sol })
        .positionSizeSol,
      sol,
    );
  }
  for (const value of [
    0,
    -1,
    NaN,
    Infinity,
    0.0000000001,
    1.1234567891,
    1e10,
    "0.2",
    null,
  ])
    assert.throws(() => settingsSchema.parse({ positionSizeSol: value }));
  for (const mode of ["FIXED", "%", "sol", null])
    assert.throws(() => settingsSchema.parse({ positionSizeMode: mode }));
  assert.equal(fixedSolLamports(0.2), 200000000n);
  assert.equal(fixedSolLamports(0.29), 290000000n);
  assert.equal(fixedSolLamports(1.123456789), 1123456789n);
});

test("fixed sizing uses the exact SOL amount, respects reservations and never shrinks to available funds", () => {
  const fixed = {
    positionSizeMode: "SOL" as const,
    positionSizeSol: 0.2,
    positionSizePercent: 50,
  };
  assert.deepEqual(size(1000000000n, 20000000n, 100000000n, fixed), {
    available: 880000000n,
    amount: 200000000n,
  });
  assert.equal(size(20000000000n, 20000000n, 0n, fixed).amount, 200000000n);
  assert.equal(
    size(320000000n, 20000000n, 100000000n, fixed).amount,
    200000000n,
  );
  assert.equal(size(319999999n, 20000000n, 100000000n, fixed).amount, 0n);
  assert.equal(size(0n, 20000000n, 0n, fixed).amount, 0n);
  assert.equal(
    size(1n, 0n, 0n, { ...fixed, positionSizeSol: 1e-9 }).amount,
    1n,
  );
  assert.equal(
    size(1000000000n, 20000000n, 0n, {
      ...fixed,
      positionSizeMode: "PERCENT",
      positionSizePercent: 2.5,
    }).amount,
    24500000n,
  );
});

test("intent sizing binding checks mode and the active value while preserving inactive settings", () => {
  const fixed = {
    positionSizeMode: "SOL" as const,
    positionSizeSol: 0.2,
    positionSizePercent: 1,
  };
  assert.equal(
    positionSizeMatches(fixed, { ...fixed, positionSizePercent: 2.5 }),
    true,
  );
  assert.equal(
    positionSizeMatches(fixed, { ...fixed, positionSizeSol: 0.25 }),
    false,
  );
  assert.equal(
    positionSizeMatches(fixed, { ...fixed, positionSizeMode: "PERCENT" }),
    false,
  );
  assert.equal(positionSizeMatches({ positionSizePercent: 1 }, {}), true);
  assert.equal(positionSizeMatches({}, fixed), false);
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

for (const strategy of ["KRONOS"] as const)
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

for (const strategy of ["KRONOS"] as const)
  test(`${strategy} fixed 0.2 SOL reaches approved intent, atomic claim, preview and fake execution`, async (t) => {
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
      f.e.updateSettings({
        ...f.e.settings,
        positionSizeMode: "SOL",
        positionSizeSol: 0.2,
      });
      assert.equal((await f.e.status()).nextBuyLamports, "200000000");
      await f.e.analyze(MINT);
      await f.e.settleEntryEvaluations();
      const execution = f.store.executions()[0]!;
      assert.equal(execution.intent.strategy, strategy);
      assert.equal(execution.intent.positionSizeMode, "SOL");
      assert.equal(execution.intent.positionSizeSol, 0.2);
      assert.equal(execution.intent.amount, "200000000");
      assert.equal(execution.state, "CONFIRMED");
      assert.equal(f.stats().signed, 1);
      assert.equal(realSign.mock.callCount(), 0);
    } finally {
      await f.close();
    }
  });

for (const boundary of ["QUOTE", "IMMEDIATE_PRE_SIGN"] as const)
  for (const change of ["MODE", "SOL_AMOUNT"] as const)
    test(`fixed sizing ${change} changed at ${boundary} blocks the unsigned intent`, async () => {
      const f = mockExecutionCase();
      try {
        f.e.updateSettings({
          ...f.e.settings,
          positionSizeMode: "SOL",
          positionSizeSol: 0.2,
        });
        const update = () =>
          f.e.updateSettings({
            ...f.e.settings,
            ...(change === "MODE"
              ? { positionSizeMode: "PERCENT" }
              : { positionSizeSol: 0.25 }),
          });
        if (boundary === "QUOTE") {
          const original = f.execution.quoteBuy.bind(f.execution);
          f.execution.quoteBuy = async (...args) => {
            update();
            return original(...args);
          };
        } else {
          const original = f.execution.execute.bind(f.execution);
          f.execution.execute = async (...args) => {
            update();
            return original(...args);
          };
        }
        await assert.rejects(f.e.analyze(MINT));
        await f.e.settleEntryEvaluations();
        assert.equal(f.stats().signed, 0);
        assert.equal(
          f.e.attempts.current?.reasonCode,
          "POSITION_SIZE_SETTING_CHANGED",
        );
        assert.equal(
          f.store.positions("live").filter((p) => p.state === "OPEN").length,
          0,
        );
      } finally {
        await f.close();
      }
    });

test("switching percent to SOL while quote is pending revokes the percentage intent", async () => {
  const f = mockExecutionCase();
  try {
    const original = f.execution.quoteBuy.bind(f.execution);
    f.execution.quoteBuy = async (...args) => {
      f.e.updateSettings({ ...f.e.settings, positionSizeMode: "SOL" });
      return original(...args);
    };
    await assert.rejects(f.e.analyze(MINT));
    await f.e.settleEntryEvaluations();
    assert.equal(f.stats().signed, 0);
    assert.equal(
      f.e.attempts.current?.reasonCode,
      "POSITION_SIZE_SETTING_CHANGED",
    );
  } finally {
    await f.close();
  }
});

test("SQL atomic claim rejects tampered fixed-size metadata even when the amount fits capital", async () => {
  const f = mockExecutionCase();
  try {
    f.e.updateSettings({
      ...f.e.settings,
      positionSizeMode: "SOL",
      positionSizeSol: 0.2,
    });
    const original = f.store.claim.bind(f.store);
    f.store.claim = (intent, capital) =>
      original({ ...intent, positionSizeSol: 0.25 }, capital);
    await assert.rejects(f.e.analyze(MINT));
    await f.e.settleEntryEvaluations();
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.attempts.current?.reasonCode, "EXACT_SIZE_CHANGED");
    assert.equal(f.store.executions().length, 0);
  } finally {
    await f.close();
  }
});

test("Executor wallet reread rejects an unaffordable fixed amount before quote", async () => {
  const f = mockExecutionCase();
  try {
    f.e.updateSettings({
      ...f.e.settings,
      positionSizeMode: "SOL",
      positionSizeSol: 0.2,
    });
    let reads = 0;
    f.execution.getWalletBalance = async () =>
      ++reads === 1 ? 1000000000n : 210000000n;
    await assert.rejects(f.e.analyze(MINT));
    await f.e.settleEntryEvaluations();
    assert.equal(f.stats().signed, 0);
    assert.equal(f.e.attempts.current?.reasonCode, "EXACT_SIZE_CHANGED");
    assert.equal(f.order.includes("BUY_QUOTE"), false);
  } finally {
    await f.close();
  }
});

for (const failure of [
  "CAPITAL",
  "SECURITY",
  "COMPATIBILITY",
  "OWNERSHIP",
  "EXIT",
  "SIMULATE",
] as const)
  test(`fixed SOL cannot bypass ${failure}`, async () => {
    const f = mockExecutionCase(failure);
    try {
      f.e.updateSettings({
        ...f.e.settings,
        positionSizeMode: "SOL",
        positionSizeSol: 0.2,
      });
      await assert.rejects(f.e.analyze(MINT));
      await f.e.settleEntryEvaluations();
      assert.equal(f.stats().signed, 0);
      assert.equal(
        f.store.positions("live").filter((p) => p.state === "OPEN").length,
        failure === "OWNERSHIP" ? 1 : 0,
      );
    } finally {
      await f.close();
    }
  });

for (const boundary of ["QUOTE", "IMMEDIATE_PRE_SIGN"] as const)
  test(`percentage changed at ${boundary} blocks unsigned old-size intent`, async () => {
    const f = mockExecutionCase();
    try {
      if (boundary === "QUOTE") {
        const original = f.execution.quoteBuy.bind(f.execution);
        f.execution.quoteBuy = async (...args) => {
          f.e.updateSettings({ ...f.e.settings, positionSizePercent: 2.5 });
          return original(...args);
        };
      } else {
        const original = f.execution.execute.bind(f.execution);
        f.execution.execute = async (...args) => {
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

test("fixed mode, SOL amount and inactive percentage survive Store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "buy-size-reopen-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "fixture.sqlite");
    store = new Store(path);
    store.set("strategyV2", {
      ...settings,
      positionSizeMode: "SOL",
      positionSizeSol: 0.2,
      positionSizePercent: 2.5,
    });
    store.close();
    store = new Store(path);
    const saved = settingsSchema.parse(store.get("strategyV2"));
    assert.equal(saved.positionSizeMode, "SOL");
    assert.equal(saved.positionSizeSol, 0.2);
    assert.equal(saved.positionSizePercent, 2.5);
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
