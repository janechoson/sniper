import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  ACCOUNT_HOUR_MS,
  AccountBalanceHistory,
  accountPositionValue,
} from "../src/account-balance-history.js";
import type { Position } from "../src/domain.js";

const T = Date.parse("2026-11-03T21:44:54+07:00");
const holding = (extra: Partial<Position> = {}) =>
  ({
    id: "held",
    state: "OPEN",
    quantity: "10",
    lastValueLamports: "200000000",
    lastQuoteAt: T,
    valuationQuantity: "10",
    ...extra,
  }) as Position;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "account-history-test-")),
    path = join(dir, "history.json");
  const cleanup = () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(dir.includes("account-history-test-"));
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  };
  return { dir, path, cleanup };
}

test("account SOL uses all managed holdings' current values, not principal, and excludes dismissed/history", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    holding({ id: String(i), costLamports: "9999999999" }),
  );
  rows.push(
    holding({ dismissal: { reason: "USER_MANUAL" } as never }),
    holding({ state: "CLOSED" }),
    holding({ state: "FAILED" }),
  );
  assert.deepEqual(accountPositionValue(rows, T), {
    positionLamports: "2400000000",
    positionCount: 12,
  });
  assert.deepEqual(accountPositionValue([], T), {
    positionLamports: "0",
    positionCount: 0,
  });
});

test("unknown/stale/pending/mismatched holdings never become zero or a complete account value", () => {
  for (const change of [
    { lastValueLamports: undefined },
    { lastValueLamports: "-1" },
    { lastQuoteAt: T - 60001 },
    { lastQuoteAt: T + 1 },
    { state: "PENDING_EXIT" },
    { quantity: "0" },
    { valuationQuantity: "9" },
    { valuationStatus: "ESTIMATED_AFTER_FILL" },
  ] as Partial<Position>[])
    assert.equal(
      accountPositionValue([holding(change)], T).positionLamports,
      null,
    );
  assert.equal(
    accountPositionValue([holding({ lastValueLamports: "0" })], T)
      .positionLamports,
    "0",
  );
});

test("baseline persists through reopen, hourly slots dedupe, 12 clock-aligned columns and scope isolation", async () => {
  const f = fixture();
  let now = T,
    wallet = "800000000";
  const observe = async () => ({
    at: now,
    walletLamports: wallet,
    positionLamports: "200000000",
    totalLamports: (BigInt(wallet) + 200000000n).toString(),
    positionCount: 1,
  });
  let h = new AccountBalanceHistory(
    f.path,
    "wallet-A",
    "paper",
    observe,
    () => now,
  );
  try {
    await h.start();
    const baseline = h.view().baseline;
    assert.equal(baseline?.totalLamports, "1000000000");
    await assert.rejects(
      new AccountBalanceHistory(f.path, "wallet-A", "paper", observe).start(),
      /ALREADY_RUNNING/,
    );
    await h.stop();
    now = Math.ceil(T / ACCOUNT_HOUR_MS) * ACCOUNT_HOUR_MS + 250;
    wallet = "900000000";
    h = new AccountBalanceHistory(
      f.path,
      "wallet-A",
      "paper",
      observe,
      () => now,
    );
    await h.start();
    const slot = Math.floor(now / ACCOUNT_HOUR_MS) * ACCOUNT_HOUR_MS;
    await h.capture(slot);
    await h.capture(slot);
    const view = h.view();
    assert.deepEqual(view.baseline, baseline);
    assert.equal(view.points.length, 2);
    assert.equal(view.points.at(-1)?.scheduledAt, slot);
    assert.equal(view.points.at(-1)?.at, now);
    assert.equal(view.columns, 12);
    assert.equal(view.endAt - view.startAt, 86400000);
    assert.equal(
      new Date(view.startAt + 7 * ACCOUNT_HOUR_MS).getUTCHours() % 2,
      0,
    );
    assert.ok(T >= view.startAt && T <= view.endAt);
    await h.stop();
    await assert.rejects(
      new AccountBalanceHistory(
        f.path,
        "different-wallet",
        "paper",
        observe,
      ).start(),
      /DIFFERENT_WALLET/,
    );
    assert.equal(existsSync(f.path + ".lock"), false);
    assert.deepEqual(
      JSON.parse(readFileSync(f.path, "utf8")).baseline,
      baseline,
    );
  } finally {
    await h.stop();
    f.cleanup();
  }
});

test("hourly scheduling continues without a browser and stop releases its lock", async (t) => {
  const f = fixture();
  let now = T,
    calls = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = new AccountBalanceHistory(
    f.path,
    "wallet",
    "paper",
    async () => {
      calls++;
      return {
        at: now,
        walletLamports: "500000000",
        positionLamports: "0",
        totalLamports: "500000000",
        positionCount: 0,
      };
    },
    () => now,
  );
  try {
    await h.start();
    const slot = (Math.floor(T / ACCOUNT_HOUR_MS) + 1) * ACCOUNT_HOUR_MS;
    now = slot - 1;
    t.mock.timers.tick(slot - T - 1);
    await setImmediate();
    assert.equal(calls, 1);
    now = slot;
    t.mock.timers.tick(1);
    await h.stop();
    assert.equal(calls, 2);
    assert.equal(h.view().points.at(-1)?.scheduledAt, slot);
    assert.equal(existsSync(f.path + ".lock"), false);
  } finally {
    await h.stop();
    t.mock.timers.reset();
    f.cleanup();
  }
});

test("outage and late clock slots preserve a gap, not a zero or fabricated historical point", async () => {
  const f = fixture();
  let now = T,
    fail = false;
  const h = new AccountBalanceHistory(
    f.path,
    "wallet",
    "paper",
    async () => {
      if (fail) throw Error("RPC unavailable");
      return {
        at: now,
        walletLamports: "100",
        positionLamports: "0",
        totalLamports: "100",
        positionCount: 0,
      };
    },
    () => now,
  );
  try {
    await h.start();
    fail = true;
    now = (Math.floor(T / ACCOUNT_HOUR_MS) + 1) * ACCOUNT_HOUR_MS;
    await h.capture(now);
    assert.equal(h.view().points.at(-1)?.totalLamports, null);
    assert.equal(h.view().baseline?.totalLamports, "100");
    fail = false;
    now += ACCOUNT_HOUR_MS + 61000;
    await h.capture(Math.floor(now / ACCOUNT_HOUR_MS) * ACCOUNT_HOUR_MS);
    assert.equal(h.view().points.at(-1)?.totalLamports, null);
    assert.equal(
      h.view().points.filter((p) => p.totalLamports !== null).length,
      1,
    );
  } finally {
    await h.stop();
    f.cleanup();
  }
});
