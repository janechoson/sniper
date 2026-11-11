/** Read-only browser fixture for /thongke; no production DB/credentials/provider traffic. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { env } from "../src/config.js";
import { provider } from "../tests/fixtures.js";
const dir = mkdtempSync(join(tmpdir(), "statistics-dashboard-ui-"));
let app: Awaited<ReturnType<typeof startServer>> | undefined, browser;
try {
  Object.assign(env, {
    TRADING_MODE: "paper",
    LIVE_TRADING_ACK: false,
    NEW_ENTRIES_ENABLED: false,
    SCANNER_ENABLED: false,
    WALLET_PUBLIC_KEY: "",
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    PORT: 43000 + Math.floor(Math.random() * 4000),
  });
  const g = provider();
  app = await startServer({ providers: { gmgn: g.gmgn } });
  await app.engine.stop();
  const base = "http://127.0.0.1:" + env.PORT;
  const actual = await (
      await fetch(base + "/api/statistics?strategy=ALL")
    ).json(),
    bare = await (await fetch(base + "/api/statistics?strategy=KRONOS")).json();
  assert.equal(actual.discovered, 0);
  assert.equal(actual.winRate, null);
  assert.equal("strategyAccounting" in bare, false);
  assert.equal("closed" in bare, true);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors: string[] = [],
    requests: string[] = [],
    methods: string[] = [];
  let aborts = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/statistics")) aborts++;
  });
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith("/api/")) {
      requests.push(p);
      methods.push(r.method());
    }
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const now = await page.evaluate(() => Date.now());
  let fxAt = now;
  await page.route("**/api/ui/shell", async (r) => {
    const response = await r.fetch();
    const body = await response.json();
    body.solPriceUsd = "100";
    body.solPriceUpdatedAt = fxAt;
    await r.fulfill({ response, json: body });
  });
  const original: any = {
    discovered: 2321,
    analyzed: 100,
    rugRejected: 0,
    kronosCalls: 974,
    kronosBuy: 530,
    kronosWait: 444,
    riskAllow: 0,
    riskReject: 7762,
    bought: 38,
    open: 3,
    closed: 33,
    strategy: "ALL",
    strategyAccounting: {
      closed: 33,
      wins: 14,
      losses: 12,
      grossPnlLamports: "15000000000",
      feesPaidLamports: "579230",
      identifiedFeesLamports: "579230",
      feesComplete: true,
      netPnlLamports: "14999420770",
    },
    realizedLamports: "12500000000",
    unrealizedLamports: "-640000000",
    pnlBasis: "GROSS_EXCLUDES_FEES",
    winRate: 14 / 33,
  };
  let data = structuredClone(original),
    fail = false,
    initial = true,
    holdAll = false;
  const releases: Array<() => void> = [];
  await page.route("**/api/statistics?*", async (r) => {
    const strategy = new URL(r.request().url()).searchParams.get("strategy"),
      snapshot =
        strategy === "ALL"
          ? structuredClone(data)
          : {
              closed: 33,
              wins: 14,
              losses: 12,
              grossPnlLamports: "-61083226",
              feesPaidLamports: "415024",
              identifiedFeesLamports: "415024",
              feesComplete: true,
              netPnlLamports: "-61498250",
            };
    if (initial || (holdAll && strategy === "ALL")) {
      initial = false;
      holdAll = false;
      await new Promise<void>((done) => releases.push(done));
    }
    try {
      await r.fulfill(
        fail
          ? { status: 503, json: { error: "FIXTURE_STATS_UNAVAILABLE" } }
          : { json: snapshot },
      );
    } catch {
      /* Deliberately aborted route fixture. */
    }
  });
  await page.goto(base + "/thongke", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stats-skeleton");
  assert.equal(await page.locator(".stats-skeleton").count(), 10);
  assert.equal(await page.locator("#terminalStatistics pre").count(), 0);
  releases.shift()?.();
  await page.waitForSelector('#terminalStatistics[data-state="ready"]');
  await page.evaluate(() => {
    (window as any).__statisticsPageMarker = "same-document";
  });
  const kpi = (name: string) =>
    page.locator('.stats-kpi[data-metric="' + name + '"] .stats-kpi-value');
  assert.equal(await page.locator(".stats-kpi").count(), 4);
  assert.equal(await page.locator(".stats-analytics > .stats-card").count(), 6);
  assert.equal(await kpi("detected").innerText(), "2,321");
  assert.equal(await kpi("bought").innerText(), "38");
  assert.equal(await kpi("open").innerText(), "3");
  assert.equal(await kpi("closed").innerText(), "33");
  assert.match(await page.locator("#statsPerformance").innerText(), /42.4%/);
  assert.equal(
    await page
      .locator("#statsPerformance [role=progressbar]")
      .getAttribute("aria-valuenow"),
    String((14 / 33) * 100),
  );
  const amounts = await page.locator("#statsPnl .stats-money").allInnerTexts();
  assert.deepEqual(amounts, [
    "+$1,250.00\n+12.5 SOL",
    "-$64.00\n-0.64 SOL",
    "$0.06\n0.00057923 SOL",
    "+$1,499.94\n+14.99942077 SOL",
  ]);
  assert.equal(
    await page
      .locator("#statsPnl .stats-money")
      .nth(1)
      .getAttribute("data-tone"),
    "negative",
  );
  assert.match(
    await page.locator("#statsAccounting").innerText(),
    /0.00057923 SOL/,
  );
  assert.match(await page.locator("#statsAccounting").innerText(), /Complete/);
  assert.match(
    await page.locator("#statsAccounting").innerText(),
    /Gross excludes fees/,
  );
  assert.match(await page.locator("#statsKronos").innerText(), /54.4%/);
  assert.match(await page.locator("#statsRisk").innerText(), /7,762/);
  assert.match(await page.locator("#statsRisk").innerText(), /0.0%/);
  assert.equal(await page.locator(".stats-comparison-empty").count(), 1);
  assert.equal(
    await page.locator("#statsComparison tbody td").count(),
    1,
    "No fabricated comparison figures",
  );
  assert.doesNotMatch(
    await page.locator("#terminalStatistics").innerText(),
    /strategyAccounting|realizedLamports|GROSS_EXCLUDES_FEES|\{"closed"/,
  );
  // Match the reference layout without fake history sparklines.
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1080 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "overflow at " + width,
    );
    const layout = await page
      .locator(".stats-kpis")
      .evaluate(
        (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
      );
    assert.equal(layout, width === 1440 ? 4 : width === 1024 ? 2 : 1);
    const analytics = await page
      .locator(".stats-analytics")
      .evaluate(
        (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
      );
    assert.equal(analytics, width === 1440 ? 3 : width === 1024 ? 2 : 1);
    if (width === 1440) {
      const cards = await page
        .locator(".stats-analytics > .stats-card")
        .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().height));
      assert.ok(cards.slice(0, 3).every((v) => Math.abs(v - cards[0]!) < 2));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  // Unknown net/gross remains unknown while actual zero values remain visible.
  data.realizedLamports = null;
  data.strategyAccounting.grossPnlLamports = null;
  data.strategyAccounting.netPnlLamports = null;
  data.winRate = null;
  data.riskAllow = 0;
  data.riskReject = 0;
  data.kronosCalls = 0;
  data.kronosBuy = 0;
  data.kronosWait = 0;
  data.bought = 0;
  data.strategyAccounting.feesComplete = false;
  data.strategyAccounting.feesPaidLamports = null;
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () =>
      document.querySelector("[data-metric=bought] .stats-kpi-value")
        ?.textContent === "0",
  );
  assert.equal(
    await page.locator("#statsPnl .stats-money").last().innerText(),
    "—\n—",
  );
  assert.match(
    await page.locator("#statsAccounting").innerText(),
    /Incomplete/,
  );
  assert.equal(
    await page.locator("#statsPerformance [role=progressbar]").count(),
    0,
  );
  assert.equal(await page.locator("#statsRisk [role=progressbar]").count(), 0);
  assert.equal(
    await page.locator("#statsKronos .stats-distribution").count(),
    0,
  );
  assert.doesNotMatch(
    await page.locator("#terminalStatistics").innerText(),
    /NaN|Infinity/,
  );
  // Stale/current FX comes only from existing shell and does not erase SOL.
  fxAt = (await page.evaluate(() => Date.now())) - 60000;
  await page.clock.runFor(5100);
  await page.waitForFunction(() =>
    document.querySelector("#statisticsFx")?.textContent?.includes("đã cũ"),
  );
  assert.equal(
    await page.locator("#statsPnl .stats-money").nth(1).innerText(),
    "—\n-0.64 SOL",
  );
  fxAt = await page.evaluate(() => Date.now());
  data = structuredClone(original);
  await page.clock.runFor(5100);
  await page.waitForFunction(() =>
    document
      .querySelector("#statsPnl .stats-money")
      ?.textContent?.includes("$1,250.00"),
  );
  // Bare accounting filter never inherits stale ALL metrics.
  await page.locator("#statisticsStrategy").selectOption("KRONOS");
  await page.waitForFunction(() =>
    document
      .querySelector("#statisticsFeedback")
      ?.textContent?.includes("KRONOS"),
  );
  assert.equal(new URL(page.url()).searchParams.get("strategy"), "KRONOS");
  assert.equal(await kpi("detected").innerText(), "—");
  assert.equal(await kpi("bought").innerText(), "—");
  assert.equal(await kpi("open").innerText(), "—");
  assert.equal(await kpi("closed").innerText(), "33");
  assert.match(await page.locator("#statsPerformance").innerText(), /53.8%/);
  assert.match(
    await page.locator("#statsPerformance").innerText(),
    /đã phân loại/,
  );
  assert.equal(
    await page.locator("#statsPnl .stats-money").first().innerText(),
    "—\n—",
  );
  assert.match(
    await page.locator("#statsPnl .stats-money").last().innerText(),
    /-0.06149825 SOL/,
  );
  // New filter wins even when an old request returns late.
  holdAll = true;
  await page.locator("#statisticsStrategy").selectOption("ALL");
  await page.waitForSelector(".stats-skeleton");
  await page.locator("#statisticsStrategy").selectOption("KRONOS");
  await page.waitForFunction(() =>
    document
      .querySelector("#statisticsFeedback")
      ?.textContent?.includes("KRONOS"),
  );
  releases.shift()?.();
  await page.waitForTimeout(50);
  assert.equal(await kpi("detected").innerText(), "—");
  assert.match(await page.locator("#statisticsFeedback").innerText(), /KRONOS/);
  // Retry uses only the Statistics dependency and retains the same document.
  fail = true;
  await page.locator("#statisticsStrategy").selectOption("ALL");
  await page.waitForSelector("#statisticsError:not([hidden])");
  assert.equal(await page.locator("#terminalStatistics").isVisible(), false);
  const beforeRetry = requests.length;
  fail = false;
  await page.locator("#statisticsRetry").click();
  await page.waitForSelector(
    '#terminalStatistics[data-state="ready"]:not([hidden])',
  );
  assert.deepEqual(
    [...new Set(requests.slice(beforeRetry))],
    ["/api/statistics"],
  );
  assert.equal(
    await page.evaluate(() => (window as any).__statisticsPageMarker),
    "same-document",
  );
  assert.deepEqual(
    [...new Set(requests)].sort(),
    ["/api/statistics", "/api/positions/count", "/api/ui/shell"].sort(),
  );
  // Navigation aborts the pending read and stops polling this hidden page.
  await page.locator("#statisticsStrategy").selectOption("KRONOS");
  await page.waitForFunction(() =>
    document
      .querySelector("#statisticsFeedback")
      ?.textContent?.includes("KRONOS"),
  );
  holdAll = true;
  await page.locator("#statisticsStrategy").selectOption("ALL");
  await page.waitForSelector(".stats-skeleton");
  await page.locator('a[data-route][href="/history"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/history"]',
  );
  releases.shift()?.();
  await page.waitForTimeout(50);
  const reads = requests.filter((p) => p === "/api/statistics").length;
  await page.clock.runFor(16000);
  await page.waitForTimeout(100);
  assert.equal(requests.filter((p) => p === "/api/statistics").length, reads);
  assert.equal(await page.locator("#terminalStatistics").count(), 0);
  assert.ok(aborts >= 1);
  if (process.env.STATISTICS_PREVIEW === "true") {
    data = structuredClone(original);
    fxAt = await page.evaluate(() => Date.now());
    await page.locator('a[data-route][href="/thongke"]').click();
    await page.waitForSelector('#terminalStatistics[data-state="ready"]');
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.screenshot({ path: join(dir, "desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.screenshot({ path: join(dir, "mobile.png"), fullPage: true });
    console.log("PREVIEW_DIR " + dir);
    await new Promise((done) => setTimeout(done, 45000));
  }
  assert.deepEqual(errors, []);
  assert.ok(methods.every((m) => m === "GET"));
  assert.equal(g.calls.length, 0);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "PASS: actual endpoint shape, four KPIs/six cards, truthful accounting scopes/null/zero/rates, USD/SOL/current FX, filtered accounting/no fabricated comparison, skeleton/error/retry, responsive 1440/1024/390, same document, abort/hidden polling/API isolation, zero JS errors/provider calls/trading mutations.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("statistics-dashboard-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
