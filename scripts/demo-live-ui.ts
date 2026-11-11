import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { env } from "../src/config.js";
import { startServer } from "../src/server.js";
import { position, provider } from "../tests/fixtures.js";
import {
  fundFixtureHolding,
  fakeKronos,
  fixtureQuotes,
  fixtureRpc,
} from "../tests/kronos-fixtures.js";

// Run with test-env.mjs: credentials and external HTTP are denied before imports.
if (env.LIVE_TRADING_ACK || env.WALLET_PUBLIC_KEY)
  throw Error("FIXTURE_ENV_REQUIRED");
const dir = mkdtempSync(join(tmpdir(), "rug-killer-mode-ui-"));
const saved = { ...env };
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  Object.assign(env, {
    TRADING_MODE: "demo",
    SCANNER_ENABLED: false,
    NEW_ENTRIES_ENABLED: false,
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    PORT: 42000 + Math.floor(Math.random() * 5000),
  });
  app = await startServer({
    providers: {
      gmgn: provider().gmgn,
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      kronos: fakeKronos(),
    },
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  const base = "http://127.0.0.1:" + env.PORT;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) =>
    new URL(r.request().url()).origin === base ? r.continue() : r.abort(),
  );
  await page.goto(base);
  await page.waitForFunction(
    () =>
      document.getElementById("accountModeTitle")?.textContent ===
      "KRONOS · DEMO",
  );
  await page.waitForFunction(() =>
    document.getElementById("accountMetrics")?.textContent?.includes("100 SOL"),
  );
  assert.equal(await page.locator('[data-strategy="STANDARD"]').count(), 0);
  assert.equal(await page.locator('a[href="/memory"]').count(), 0);
  assert.equal(
    await page.locator('a[href="/watchlist"],a[href="/deferred"]').count(),
    0,
  );
  assert.equal(await page.locator("#resetDemo").isDisabled(), true);
  assert.equal((await page.locator("#accountChart circle").count()) > 0, true);
  const held = {
    ...position(),
    mode: "demo" as const,
    strategy: "KRONOS" as const,
  };
  fundFixtureHolding(app.engine.store, held);
  await page.goto(base + "/positions");
  await page.waitForSelector(".position-card");
  assert.match(
    (await page.locator(".position-strategy").allTextContents()).join(" "),
    /KRONOS/,
  );
  assert.doesNotMatch(
    (await page.locator(".position-strategy").allTextContents()).join(" "),
    /THAM KHẢO TP|BÁM ĐUÔI|JEV/i,
  );
  const second = await browser.newPage();
  second.on("pageerror", (e) => errors.push(e.message));
  await second.route("**/*", (r) =>
    new URL(r.request().url()).origin === base ? r.continue() : r.abort(),
  );
  await second.goto(base + "/positions");
  await second.waitForSelector(".position-card");
  const initial = app.engine.store.demoAccountId();
  const count = app.engine.store.db
    .prepare("SELECT count(*) n FROM executions")
    .get()!.n;
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#selectLive").click();
  assert.equal((await (await fetch(base + "/api/mode")).json()).mode, "DEMO");
  page.once("dialog", (d) => d.accept());
  await page.locator("#selectLive").click();
  await page.waitForFunction(() =>
    document
      .getElementById("modeState")
      ?.textContent?.includes("NORMAL_LIVE_REQUIRES"),
  );
  assert.equal((await (await fetch(base + "/api/mode")).json()).active, false);
  await second.waitForFunction(
    () =>
      document.getElementById("accountModeTitle")?.textContent ===
      "KRONOS · LIVE",
  );
  await second.waitForFunction(
    () => document.querySelectorAll(".position-card").length === 0,
  );
  await page.locator("#selectDemo").click();
  await page.waitForFunction(
    () =>
      document.getElementById("modeState")?.textContent === "Session đang chạy",
  );
  assert.equal(app.engine.store.demoAccountId(), initial);
  await second.waitForFunction(
    () =>
      document.getElementById("accountModeTitle")?.textContent ===
      "KRONOS · DEMO",
  );
  await second.waitForSelector(".position-card");
  await page.locator("#stopMode").click();
  await page.waitForFunction(
    () =>
      document.getElementById("modeState")?.textContent === "Session đã dừng",
  );
  page.once("dialog", (d) => d.accept());
  await page.locator("#resetDemo").click();
  await page.waitForFunction(
    () => !document.getElementById("selectDemo")?.hasAttribute("disabled"),
  );
  assert.notEqual(app.engine.store.demoAccountId(), initial);
  await second.waitForFunction(
    () => document.querySelectorAll(".position-card").length === 0,
  );
  assert.equal(app.engine.store.positions("demo").length, 0);
  assert.equal(
    app.engine.store.db
      .prepare("SELECT count(*) n FROM positions WHERE id=?")
      .get(held.id)!.n,
    1,
  );
  assert.equal(
    app.engine.store.db.prepare("SELECT count(*) n FROM executions").get()!.n,
    count,
  );
  for (const route of [
    "/positions",
    "/history",
    "/logs",
    "/settings",
    "/thongke",
  ]) {
    await page.goto(base + route);
    await page.waitForSelector("#routeOutlet > *");
  }
  assert.deepEqual(errors, []);
  console.log(
    "DEMO/LIVE browser checks passed: funding, chart, retired UI, confirmation, blocked LIVE, restart, reset, second-tab isolation, routes. No external HTTP or trade.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  Object.assign(env, saved);
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(resolve(dir).includes("rug-killer-mode-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
