import { chromium } from "@playwright/test";
import {
  mkdtempSync,
  copyFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import assert from "node:assert/strict";

// Application restart verification uses a copy of the clean active DB. Fixtures
// are written only into this temporary copy, never the production dataset.
const directory = mkdtempSync(join(tmpdir(), "bot-clean-history-"));
const source = resolve("data/bot.sqlite");
for (const suffix of ["", "-wal", "-shm"])
  if (existsSync(source + suffix))
    copyFileSync(source + suffix, join(directory, "bot.sqlite" + suffix));
const port = 43000 + Math.floor(Math.random() * 15000),
  base = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  TRADING_MODE: "paper",
  LIVE_TRADING_ACK: "false",
  NEW_ENTRIES_ENABLED: "false",
  SCANNER_ENABLED: "false",
  WALLET_PUBLIC_KEY: "",
  GMGN_API_KEY: "",
  GMGN_PRIVATE_KEY: "",
  TYPESAFE_API_KEY: "",
  JUPITER_API_KEY: "",
  PORT: String(port),
  DATABASE_PATH: join(directory, "bot.sqlite"),
});
const { startServer } = await import("../dist/server.js");
const app = await startServer();
await app.engine.stop();
let browser;
const errors = [];
const get = async (route) => {
  const r = await fetch(base + route);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  return r.json();
};
try {
  assert.deepEqual(await get("/api/history"), []);
  assert.deepEqual(await get("/api/positions"), []);
  assert.equal((await get("/api/learning")).completedTrades, 0);
  assert.equal(app.engine.structure.list().length, 0);
  assert.equal(app.engine.candidates.list().length, 0);
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("mode").textContent === "MÔ PHỎNG",
  );
  await page.evaluate(async () => {
    stream.close();
    await refreshTables();
  });
  await page.locator('[data-view="history"]').click();
  assert.equal(await page.locator("#historyRows .history-record").count(), 0);
  assert.equal(await page.locator("#historyEmpty").isVisible(), true);
  const now = Date.now(),
    seed = (id, entryAt, state = "CLOSED") => ({
      id,
      mint: "So11111111111111111111111111111111111111112",
      symbol: id,
      provider: "JUPITER",
      mode: "paper",
      state,
      entryAt,
      quantity: state === "CLOSED" ? "0" : "500",
      originalQuantity: "1000",
      costLamports: "1000000",
      remainingCostLamports: state === "CLOSED" ? "0" : "500000",
      realizedLamports: "0",
      highWaterLamports: "1000000",
      takenProfits: [],
      decimals: 9,
    });
  const db = app.engine.store,
    a = seed("A", now - 20000),
    b = seed("B", now - 10000),
    c = seed("C", now);
  const draw = async () => {
    await page.evaluate(() => refreshTables());
  };
  const ids = async () =>
    page.locator("#historyRows .history-record b").allTextContents();
  // Read row identity through summary text: DOM fixtures are not pre-sorted.
  const names = async () =>
    page.locator("#historyRows .history-token").allTextContents();
  db.savePosition(a);
  await draw();
  assert.deepEqual(await names(), ["A"]);
  db.savePosition(b);
  await draw();
  assert.deepEqual(await names(), ["B", "A"]);
  db.savePosition(c);
  await draw();
  assert.deepEqual(await names(), ["C", "B", "A"]);
  db.savePosition({ ...a, lastQuoteAt: now + 90000, lastValueLamports: "123" });
  await draw();
  assert.deepEqual(await names(), ["C", "B", "A"]);
  db.savePosition({
    ...a,
    state: "OPEN",
    quantity: "500",
    remainingCostLamports: "500000",
    realizedLamports: "100",
  });
  await draw();
  assert.deepEqual(await names(), ["C", "B"]);
  assert.deepEqual(
    (await get("/api/history?state=OPEN&limit=1")).map((p) => p.id),
    ["A"],
  );
  db.savePosition({ ...a, lastQuoteAt: now + 99999, realizedLamports: "200" });
  await draw();
  assert.deepEqual(await names(), ["C", "B", "A"]);
  db.savePosition({ ...b, id: "B-tie", symbol: "B-tie" });
  await draw();
  assert.deepEqual(await names(), ["C", "B-tie", "B", "A"]);
  assert.deepEqual(
    (await get("/api/history?limit=2&offset=1")).map((p) => p.id),
    ["B-tie", "B"],
  );
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("mode").textContent === "MÔ PHỎNG",
  );
  await page.evaluate(async () => {
    stream.close();
    await refreshTables();
  });
  assert.deepEqual(await names(), ["C", "B-tie", "B", "A"]);
  await page.screenshot({
    path: "data/clean-reset-history-ui.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const report = {
    at: new Date().toISOString(),
    sourceDbCopied: true,
    initialPositions: 0,
    initialHistory: 0,
    initialMemoryTrades: 0,
    initialWatches: 0,
    initialCandidates: 0,
    newClosedSequence: ["A", "B,A", "C,B,A"],
    tieOrder: await names(),
    openingTimestamp: "entryAt",
    tieBreak: "id DESC",
    paginationBeforeLimit: true,
    filters: true,
    observationsDoNotReorder: true,
    partialFullSellDoNotReorder: true,
    reload: true,
    cacheControl: "no-store",
    browserErrors: errors,
    signatures: 0,
    submissions: 0,
    liveEnabled: false,
  };
  writeFileSync(
    "data/clean-reset-history-ui.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await app.stop();
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith("bot-clean-history-")
  )
    throw Error("Unsafe fixture cleanup");
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
