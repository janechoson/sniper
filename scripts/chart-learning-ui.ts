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
  const caseId = "gallery-fixture-case", charts = app.engine.chartLearning.charts,
    entryAt = h.candles.at(-30)!.at, closedAt = Date.now() - 5 * 60000;
  charts.db.prepare("INSERT INTO chart_learning_cases(position_id,mint,mode,account_id,buy_confirmed_at,learning_started_at,entry_price_usd,entry_quantity,status,entry_snapshot_id,exit_snapshot_id,realized_pnl_lamports,realized_pnl_pct,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,1,'100','CLOSED',NULL,NULL,'-10',-14.67,?,?,?)")
    .run(caseId, MINT, "demo", charts.account("demo"), entryAt, entryAt, closedAt, closedAt, JSON.stringify({positionId:caseId,mint:MINT,mode:"demo",closedAt,simulated:true}));
  charts.db.prepare("INSERT INTO chart_case_collection(case_id,status,data_quality,updated_at,payload) VALUES(?,'INCOMPLETE','INCOMPLETE',?,'{}')").run(caseId, closedAt);
  await page.reload();
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  await page.waitForFunction(() => document.querySelector("#galleryStatus")?.textContent !== "Đang tải giao dịch…");
  assert.equal(await page.locator(".experience-card").count(), 1, await page.locator("#galleryStatus").innerText());
  assert.match(await page.locator(".experience-card").innerText(), /-14.67%/);
  assert.match((await page.locator("#chartDiagnostics").textContent()) ?? "", /Thiếu dữ liệu:\s*1/);
  await page.locator(".experience-card").click();
  await page.waitForSelector("#experienceDetail .experience-detail-chart svg");
  assert.match(await page.locator("#experienceDetail").innerText(), /BUY Analysis/);
  assert.match(await page.locator("#experienceDetail").innerText(), /chưa lưu review riêng/);
  await page.locator('#experienceDetail .replay-tabs button').nth(1).click();
  await page.locator('#experienceDetail .replay-tabs button').nth(2).click();
  await page.locator("#experienceClose").click();
  await page.locator('#galleryDays').selectOption("7");
  assert.equal(await page.locator(".experience-card").count(), 1);
  const viewports: [number, number][] = [
    [1920, 1080],
    [1440, 900],
    [768, 1024],
    [390, 844],
  ];
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `page overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "Chart Learning browser fixture: actual-candle gallery, incomplete-case visibility, diagnostics, modal replay tabs, no LIVE execution, 4 responsive sizes PASS. Mint fixture " +
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
