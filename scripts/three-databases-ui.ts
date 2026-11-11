import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { env } from "../src/config.js";
import { startServer } from "../src/server.js";
import { position, provider, candidate } from "../tests/fixtures.js";
import {
  fixtureRpc,
  fixtureQuotes,
  fakeKronos,
} from "../tests/kronos-fixtures.js";
import { candles } from "../tests/one-shot-fixtures.js";
import { parseMarketHistory } from "../src/market-history.js";
if (env.LIVE_TRADING_ACK || env.WALLET_PUBLIC_KEY)
  throw Error("FIXTURE_PRELOAD_REQUIRED");
const dir = mkdtempSync(join(tmpdir(), "three-db-ui-")),
  saved = { ...env };
let app: Awaited<ReturnType<typeof startServer>> | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  Object.assign(env, {
    TRADING_MODE: "demo",
    SCANNER_ENABLED: false,
    NEW_ENTRIES_ENABLED: false,
    DATABASE_PATH: join(dir, "legacy.sqlite"),
    PORT: 47000 + Math.floor(Math.random() * 1000),
  });
  app = await startServer({
    verifyLive: async () => {},
    providers: {
      gmgn: provider().gmgn,
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      kronos: fakeKronos(),
    },
  });
  const learner = app.learning,
    base = "http://127.0.0.1:" + env.PORT;
  for (const [mode, symbol] of [
    ["demo", "DEMO_ONLY"],
    ["live", "LIVE_ONLY"],
  ] as const)
    app.registry
      .forMode(mode)
      .savePosition({
        ...position(),
        mode,
        symbol,
        strategy: "KRONOS",
        quantity: "0",
        state: "CLOSED",
        closedAt: Date.now(),
      });
  learner.charts.ingest(
    candidate().mint,
    parseMarketHistory(candles(60), candidate()),
  );
  const candleCount = learner.charts.overview("demo").candleCount;
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) =>
    new URL(r.request().url()).origin === base ? r.continue() : r.abort(),
  );
  await page.goto(base + "/history");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.match(await page.locator("#historyRows").innerText(), /DEMO_ONLY/);
  assert.doesNotMatch(
    await page.locator("#historyRows").innerText(),
    /LIVE_ONLY/,
  );
  page.once("dialog", (d) => d.accept());
  await page.locator("#selectLive").click();
  await page.waitForFunction(
    () =>
      document.getElementById("selectLive")?.getAttribute("aria-pressed") ===
      "true",
  );
  await page.waitForFunction(() =>
    document.getElementById("historyRows")?.textContent?.includes("LIVE_ONLY"),
  );
  assert.doesNotMatch(
    await page.locator("#historyRows").innerText(),
    /DEMO_ONLY/,
  );
  await page.goto(base + "/chart-learning");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.match(await page.locator("#learningStatus").innerText(), /SHARED/);
  const snapshot = await (await fetch(base + "/api/chart-learning")).json();
  assert.equal(snapshot.overview.candleCount, candleCount);
  await page.locator("#selectDemo").click();
  await page.waitForFunction(
    () =>
      document.getElementById("selectDemo")?.getAttribute("aria-pressed") ===
      "true",
  );
  assert.equal(app.learning, learner);
  assert.equal(app.engine.chartLearning, learner);
  const after = await (await fetch(base + "/api/chart-learning")).json();
  assert.equal(after.overview.candleCount, candleCount);
  assert.deepEqual(after.rules, snapshot.rules);
  await page.goto(base + "/history");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.match(await page.locator("#historyRows").innerText(), /DEMO_ONLY/);
  assert.deepEqual(errors, []);
  assert.equal(app.registry.live.executions().length, 0);
  assert.equal(app.registry.demo.executions().length, 0);
  console.log(
    "Three-database browser E2E PASS: both successful fixture switches, isolated history, invariant shared learning, one learner, zero submissions.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  Object.assign(env, saved);
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("three-db-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
