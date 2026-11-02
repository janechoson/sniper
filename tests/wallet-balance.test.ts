import { test } from "node:test";
import assert from "node:assert/strict";
import { WalletBalance } from "../src/wallet-balance.js";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test("header balance reads are single-flight/cached and retain exact integer lamports", async () => {
  let now = 1000,
    calls = 0,
    resolve!: (value: bigint) => void;
  const b = new WalletBalance(
    () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    () => now,
  );
  for (let i = 0; i < 20; i++) assert.equal(b.view().lamports, null);
  await flush();
  assert.equal(calls, 1);
  resolve(9007199254740993n);
  await flush();
  assert.equal(b.view().lamports, "9007199254740993");
  assert.equal(b.view().stale, false);
  now += 14000;
  b.view();
  await flush();
  assert.equal(calls, 1);
  now += 1000;
  b.view();
  await flush();
  assert.equal(calls, 2);
  resolve(0n);
  await flush();
  assert.equal(b.view().lamports, "0");
});
test("missing/failed/stale balances never become a fabricated current zero", async () => {
  assert.equal(new WalletBalance().view().lamports, null);
  let now = 1000,
    fail = false;
  const b = new WalletBalance(
    async () => {
      if (fail) throw Error("secret endpoint text");
      return 123456789n;
    },
    () => now,
  );
  b.view();
  await flush();
  fail = true;
  now += 16000;
  b.view();
  await flush();
  assert.equal(b.view().lamports, "123456789");
  assert.equal(b.view().state, "UNAVAILABLE");
  now += 46000;
  assert.equal(b.view().stale, true);
  await flush();
  assert(!JSON.stringify(b.view()).includes("secret"));
  const bad = new WalletBalance(async () => -1n);
  bad.view();
  await flush();
  assert.equal(bad.view().lamports, null);
  assert.equal(bad.view().stale, true);
});
