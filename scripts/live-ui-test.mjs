import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startKronos } from "../dist/server.js";
import { runtimeConfig, ROOT } from "../dist/config.js";
const dir = mkdtempSync(join(ROOT, "data", "test-live-ui-"));
const app = await startKronos(
  runtimeConfig({
    KRONOS_PORT: "8798",
    KRONOS_DATABASE_PATH: join(dir, "fixture.sqlite"),
    KRONOS_RUNTIME: join(dir, "runtime"),
    KRONOS_LOG_DIR: join(dir, "logs"),
  }),
  { timer: false },
);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [],
  requests = [];
const now = Date.now();
const fill = {
  at: now,
  quantityAtomic: "1012345",
  tradingLamports: "9800000",
  networkFeeLamports: "10000",
  priceSol: "0.009680513465",
  priceUsd: "0.9680513465",
  signature: "A".repeat(88),
};
const current = {
  id: "live-fixture",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "LIVEFIX",
  mode: "LIVE",
  status: "OPEN",
  gates: {},
  evaluation: {
    stages: {
      CHEAP_FILTER: "PASS",
      SECURITY: "PASS",
      COMPATIBILITY: "PASS",
      HISTORY: "PASS",
      CAPITAL_FLOW: "PASS",
      KRONOS: "PASS",
      EXECUTION: "PASS",
    },
  },
  entry: { value: 0.968, observedAt: now, source: "RECONCILED_USD" },
  current: { value: 1.1, observedAt: now, source: "GMGN_TOKEN_INFO" },
  latest: { action: "PAPER_BUY", at: now },
  execution: { id: "fake", side: "BUY", state: "RECONCILED" },
  live: {
    entry: fill,
    state: "OPEN",
    quantity: "1012345",
    grossPnlLamports: null,
    feesLamports: "10000",
    netPnlLamports: null,
    feesPrincipalPct: 0.102,
    marketPnlPct: 13.6,
    mfePct: 13.6,
    maePct: 0,
  },
};
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    requests.push({ path: url.pathname, method: req.method() });
    if (
      url.hostname !== "127.0.0.1" ||
      url.port !== "8798" ||
      req.method() !== "GET"
    )
      return route.abort();
    if (url.pathname === "/api/overview")
      return route.fulfill({
        json: {
          tradingMode: "LIVE",
          paperOnly: false,
          enabled: false,
          active: false,
          queueDepth: 0,
          queue: [],
          current,
          candidate: { mint: current.mint },
          positions: { rows: [current], hasMore: false },
          logs: [],
          inference: {},
          providers: {},
          recordsCount: 1,
        },
      });
    if (
      url.pathname === "/api/statistics" &&
      url.searchParams.get("mode") === "LIVE"
    )
      return route.fulfill({
        json: {
          mode: "LIVE",
          buys: 1,
          open: 1,
          closed: 0,
          wins: 0,
          losses: 0,
          winRate: null,
          netRealizedLamports: null,
        },
      });
    if (["/api/history", "/api/positions"].includes(url.pathname))
      return route.fulfill({
        json: {
          rows: url.searchParams.get("mode") === "PAPER" ? [] : [current],
          hasMore: false,
          nextCursor: null,
        },
      });
    return route.continue();
  });
  await page.goto("http://127.0.0.1:8798/");
  await page.waitForFunction(
    () => document.getElementById("mode").textContent === "LIVE",
  );
  assert.equal(
    await page.locator("#terminalStages .terminal-stage").count(),
    7,
  );
  assert.equal(await page.locator('[data-stage="EXECUTION"]').count(), 1);
  assert.equal(await page.locator('[data-stage="PAPER_DECISION"]').count(), 0);
  assert.match(
    await page.locator("#terminalVerdict").textContent(),
    /BUY RECONCILED/,
  );
  assert.match(
    await page.locator("#terminalPositionRows").textContent(),
    /LIVE.*0.968.*1012345/s,
  );
  assert.equal(
    await page.locator('a[href^="https://solscan.io/tx/"]').count(),
    1,
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.waitForTimeout(80);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    mkdirSync("docs/previews", { recursive: true });
    await page.screenshot({
      path: `docs/previews/controlled-live-ui-${width}.png`,
      fullPage: true,
    });
  }
  await page.locator('[data-view="history"]').click();
  await page.locator("#historyMode").selectOption("PAPER");
  await page.waitForFunction(() =>
    document
      .getElementById("historyEmpty")
      .textContent.includes("Chưa có dữ liệu"),
  );
  await page.locator("#historyMode").selectOption("LIVE");
  await page.waitForFunction(() =>
    document.getElementById("historyTable").textContent.includes("LIVEFIX"),
  );
  await page.locator('[data-view="statistics"]').click();
  await page.locator("#statisticsMode").selectOption("LIVE");
  await page.waitForFunction(() =>
    document
      .getElementById("statCards")
      .textContent.includes("Net Realized PnL"),
  );
  assert(
    !(await page
      .locator("#statCards")
      .textContent()
      .then((t) => t.includes("Paper Buys"))),
  );
  assert.equal(
    await page
      .locator("#statCards .kronos-stat")
      .filter({ hasText: "Net Realized PnL" })
      .locator("strong")
      .textContent(),
    "—",
  );
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector("#positionSizePercent");
  assert.equal(await page.locator("#positionSizePercent").inputValue(), "1");
  assert.equal(
    await page.locator("#positionSizePercent").evaluate((e) => e.readOnly),
    true,
  );
  assert.match(
    await page.locator("#configuration").textContent(),
    /SOL khả dụng sau dự phòng/,
  );
  await page.screenshot({
    path: "docs/previews/kronos-fixed-one-percent-settings.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert(requests.every((r) => r.method === "GET"));
  writeFileSync(
    "evidence/fixed-one-percent-ui.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        fixtureOnly: true,
        realSignatures: 0,
        realSubmissions: 0,
        errors,
        requests,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: LIVE mode, seven stages, actual entry, quantity, explorer, UNKNOWN PnL, mode filters and responsive Overview; zero execution.",
  );
} finally {
  await app.stop();
  await browser.close();
}
