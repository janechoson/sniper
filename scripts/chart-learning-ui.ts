import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { env } from "../src/config.js";
import { startServer } from "../src/server.js";
import { provider, candidate, MINT, info } from "../tests/fixtures.js";
import { candles } from "../tests/one-shot-fixtures.js";
import { normalizeMarket } from "../src/gmgn.js";
import { parseMarketHistory } from "../src/market-history.js";
import {
  fakeKronos,
  fixtureRpc,
  fixtureQuotes,
} from "../tests/kronos-fixtures.js";

if (env.LIVE_TRADING_ACK || env.WALLET_PUBLIC_KEY)
  throw Error("FIXTURE_PRELOAD_REQUIRED");
const dir = mkdtempSync(join(tmpdir(), "chart-learning-ui-"));
const saved = { ...env };
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  Object.assign(env, {
    TRADING_MODE: "demo",
    SCANNER_ENABLED: false,
    NEW_ENTRIES_ENABLED: false,
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    PORT: 46000 + Math.floor(Math.random() * 1000),
  });
  app = await startServer({
    providers: {
      gmgn: provider().gmgn,
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      kronos: fakeKronos(),
    },
  });
  const base = "http://127.0.0.1:" + env.PORT;
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) =>
    new URL(r.request().url()).origin === base ? r.continue() : r.abort(),
  );
  await page.goto(base + "/chart-learning");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.equal(await page.locator("#learningOverview .learning-stat").count(), 7);
  assert.match(await page.locator("#learningChart").innerText(), /Chưa có nến sự kiện/);
  const baseHistory = parseMarketHistory(candles(60), candidate()),
    last = baseHistory.candles.at(-1)!,
    rug = {
      ...last,
      low: last.open * 0.6,
      close: last.open * 0.75,
    },
    h = { ...baseHistory, candles: [...baseHistory.candles.slice(0, -1), rug] };
  app.engine.chartLearning.charts.ingest(MINT, h);
  const d = await app.engine.chartLearning.decide(
    candidate(),
    h,
    normalizeMarket(info()),
    "demo",
  );
  await page.reload();
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  await page.waitForSelector("#learningChart svg");
  assert.ok(await page.locator("#learningEventList .learning-event-item").count() >= 1);
  assert.match(await page.locator("#learningChartTitle").innerText(), /RUG_30/);
  assert.equal(await page.locator("#learningChart svg line[stroke-dasharray='5 5']").count(), 1);
  await page.locator('#learningEventFilters button[data-filter="RUG_30"]').click();
  assert.equal(await page.locator("#learningEventList .learning-event-item").count(), 1);
  await page.locator('#learningEventFilters button[data-filter="ANALYZED"]').click();
  assert.equal(await page.locator("#learningEventList .learning-event-item").count(), 0);
  await page.locator('#learningEventFilters button[data-filter="ALL"]').click();
  await page.locator("#learningEventSearch").fill("not-a-token");
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#learningEventList .learning-event-item").count(), 0);
  await page.locator("#learningEventSearch").fill("");
  await page.waitForTimeout(250);
  const viewports: [number, number][] = [
    [1920, 1080],
    [1440, 900],
    [768, 1024],
    [390, 844],
  ];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `page overflow at ${width}`);
    await page.screenshot({ path: join(dir, `learning-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Decisions", exact: true }).click();
  await page.locator("#learningRows button").first().click();
  await page.waitForSelector("#learningDetail svg");
  assert.match(
    await page.locator("#learningDetail").innerText(),
    new RegExp(d.id),
  );
  assert.equal(
    (await page.locator("#learningDetail svg rect").count()) > 0,
    true,
  );
  await page.locator('a[href="/positions"]').click();
  await page.waitForSelector('#routeOutlet[data-route="/positions"]');
  await page.locator('a[href="/chart-learning"]').click();
  await page.waitForSelector('#routeOutlet[data-route="/chart-learning"]');
  assert.equal(
    await page.locator("#learningOverview strong").first().innerText(),
    String(app.engine.chartLearning.charts.events(100).filter((event) => event.kind !== "CONTROL").length),
  );
  assert.deepEqual(errors, []);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "Chart Learning browser fixture: shared KPIs, RUG_30 event selection/filter/search, evidence-backed candle chart, 4 responsive sizes, persisted decision, route cleanup PASS. Mint fixture " +
      MINT,
  );
} finally {
  await browser?.close();
  await app?.stop();
  Object.assign(env, saved);
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("chart-learning-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
