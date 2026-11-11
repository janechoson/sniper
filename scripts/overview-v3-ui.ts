import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { chromium } from "@playwright/test";
import { env } from "../src/config.js";
import { startServer } from "../src/server.js";
import { candidate, provider, position } from "../tests/fixtures.js";
import {
  fundFixtureHolding,
  fixtureRpc,
  fixtureQuotes,
  fakeKronos,
} from "../tests/kronos-fixtures.js";

if (env.LIVE_TRADING_ACK || env.WALLET_PUBLIC_KEY)
  throw Error("FIXTURE_PRELOAD_REQUIRED");
const dir = mkdtempSync(join(tmpdir(), "rug-overview-v3-")),
  saved = { ...env };
let app: Awaited<ReturnType<typeof startServer>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  Object.assign(env, {
    TRADING_MODE: "demo",
    SCANNER_ENABLED: false,
    NEW_ENTRIES_ENABLED: false,
    DATABASE_PATH: join(dir, "legacy.sqlite"),
    PORT: 48000 + Math.floor(Math.random() * 1000),
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
      viewport: { width: 1440, height: 900 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error" && !e.text().includes("409 (Conflict)"))
      errors.push(e.text());
  });
  let result = "RUNNING",
    decision = "WAIT",
    execution = "NOT_EXECUTED",
    missingAccount = false,
    overviewReads = 0,
    blockedSwitches = 0,
    showPosition = false;
  const token = {
    ...candidate(),
    symbol: "GabeHorn",
    source: "gmgn:trending",
    createdAt: Date.now() - 3600000,
  };
  const known = (value: number) => ({ state: "KNOWN", value });
  await page.route("**/*", async (r) => {
    const url = new URL(r.request().url());
    if (url.origin !== base) return r.abort();
    if (url.pathname === "/api/mode" && r.request().method() === "POST") {
      blockedSwitches++;
      return r.fulfill({
        status: 409,
        json: { error: "FIXTURE_LIVE_READINESS_FAILED" },
      });
    }
    if (url.pathname === "/api/account-balance" && missingAccount)
      return r.fulfill({
        json: {
          mode: "DEMO",
          equitySol: null,
          realizedPnlSol: null,
          unrealizedPnlSol: null,
        },
      });
    if (url.pathname === "/api/overview") {
      overviewReads++;
      return r.fulfill({
        json: {
          attempt: {
            attemptId: "fixture-attempt",
            mint: token.mint,
            symbol: token.symbol,
            source: "GMGN_TRENDING",
            result,
            stage: "KRONOS",
            stages: Object.fromEntries(
              [
                "CHEAP_FILTER",
                "SECURITY",
                "COMPATIBILITY",
                "HISTORY",
                "CAPITAL_FLOW",
                "COMMON_RISK",
                "CODEX_GUARD",
              ].map((s) => [s, "PASS"]),
            ),
            summaries: {
              token,
              ownershipClaim:
                decision === "BUY" ? { strategy: "KRONOS" } : undefined,
              market: {
                price: known(0.00006913),
                marketCap: known(64600),
                liquidity: known(18000),
                volume: known(128800),
                buys: known(1500),
                sells: known(1043),
                windows: { "1m": { startPrice: known(0.000068) } },
              },
              metrics: { holders: 302 },
              codexGuard: {
                action: "PASS",
                reason: "Fixture: no validated history",
              },
              kronos: { action: decision },
              strategies: {
                KRONOS: {
                  decision,
                  execution,
                  reason: "Fixture decision evidence",
                  stages: {
                    KRONOS: "PASS",
                    RISK: decision === "WAIT" ? "SKIPPED" : "PASS",
                  },
                },
              },
            },
            logs: [],
          },
          token,
          positions: showPosition ? app!.engine.overviewStatus().positions : [],
          positionTotal: showPosition ? 1 : 0,
          market: [],
          queue: [],
          scanner: { running: true },
          batch: {
            total: 100,
            completed: 71,
            processing: 1,
            waiting: 28,
            fetchedAt: Date.now() - 208000,
            state: "PROCESSING",
          },
        },
      });
    }
    return r.continue();
  });
  await page.goto(base);
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  await page.waitForFunction(
    () => document.getElementById("kpiEquity")?.textContent === "100.00 SOL",
  );
  assert.equal(await page.locator(".overview-kpi").count(), 5);
  assert.equal(
    await page.locator("#accountChart,#tokenCarousel,.action-log").count(),
    0,
  );
  assert.equal(await page.locator("#kpiScanner").innerText(), "71 / 100");
  assert.match(
    await page.locator("#trendingBatchProgress").innerText(),
    /Còn lại: 28/,
  );
  assert.equal(
    await page.locator('.terminal-stage[data-stage="KRONOS"] b').innerText(),
    "WAIT",
  );
  assert.equal(
    await page.locator('.terminal-stage[data-stage="BUY"] b').innerText(),
    "WAIT",
  );
  assert.equal(await page.locator(".overview-positions th").count(), 14);
  const initialStage = await page
    .locator('.terminal-stage[data-stage="CHEAP_FILTER"]')
    .elementHandle();
  await page.waitForTimeout(1250);
  assert.equal(
    await initialStage!.evaluate((el) => el.isConnected),
    true,
    "unchanged stage nodes stay mounted",
  );
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [768, 1024],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: join(dir, `overview-${width}.png`),
      fullPage: true,
    });
    const geometry = await page.evaluate(() => {
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        token: document
          .querySelector(".current-token")!
          .getBoundingClientRect()
          .toJSON(),
        kronos: document
          .querySelector(".kronos-evaluation")!
          .getBoundingClientRect()
          .toJSON(),
        positions: document
          .querySelector(".overview-positions")!
          .getBoundingClientRect()
          .toJSON(),
        scanner: document
          .querySelector(".scanner-bar")!
          .getBoundingClientRect()
          .toJSON(),
        kpis: [...document.querySelectorAll(".overview-kpi")].map(
          (el) => el.getBoundingClientRect().top,
        ),
      };
    });
    assert.equal(geometry.overflow, false, "no page overflow at " + width);
    assert.ok(geometry.positions.top >= geometry.kronos.bottom - 1);
    if (width >= 1440) {
      assert.equal(new Set(geometry.kpis).size, 1);
      assert.equal(geometry.token.top, geometry.kronos.top);
      assert.ok(geometry.scanner.height <= 60);
    }
    if (width === 390) assert.ok(geometry.kronos.top >= geometry.token.bottom);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  decision = "BUY";
  execution = "RECONCILING";
  result = "RECONCILING";
  await page.waitForFunction(
    () =>
      document.querySelector('.terminal-stage[data-stage="BUY"] b')
        ?.textContent === "CHECKING",
  );
  execution = "CONFIRMED";
  result = "BOUGHT";
  await page.waitForFunction(
    () =>
      document.querySelector('.terminal-stage[data-stage="BUY"] b')
        ?.textContent === "BUY",
  );
  fundFixtureHolding(app.engine.store, {
    ...position(),
    mode: "demo",
    strategy: "KRONOS",
    symbol: "POSITION_FIXTURE",
  });
  showPosition = true;
  await page.waitForFunction(() =>
    document
      .getElementById("terminalPositionRows")
      ?.textContent?.includes("POSITION_FIXTURE"),
  );
  assert.equal(await page.locator("#kpiPositions").innerText(), "1");
  assert.equal(await page.locator(".overview-positions th").count(), 14);
  assert.equal(
    await page.locator("#terminalPositionRows [data-sell-percent]").count(),
    2,
  );
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#selectLive").click();
  assert.equal(blockedSwitches, 0);
  page.once("dialog", (d) => d.accept());
  await page.locator("#selectLive").click();
  await page.waitForFunction(() =>
    document
      .getElementById("modeState")
      ?.textContent?.includes("FIXTURE_LIVE_READINESS_FAILED"),
  );
  assert.equal(
    await page.locator("#selectDemo").getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(blockedSwitches, 1);
  missingAccount = true;
  await page.waitForFunction(
    () => document.getElementById("kpiEquity")?.textContent === "N/A",
  );
  for (const route of [
    "/logs",
    "/chart-learning",
    "/positions",
    "/history",
    "/",
  ]) {
    await page.goto(base + route);
    await page.waitForSelector('#routeOutlet[data-state="ready"]');
  }
  const before = overviewReads;
  await page.waitForTimeout(2200);
  assert.ok(
    overviewReads - before <= 3,
    "one overview poller after navigation",
  );
  assert.deepEqual(errors, []);
  assert.equal(app.registry.live.executions().length, 0);
  console.log(
    "Overview V3 PASS: 4 responsive sizes, 5 KPIs, no overflow, stable stages, confirmed BUY only, missing financial N/A, LIVE cancel/failure, routes, one poller, zero LIVE submissions.",
  );
  if (process.env.KEEP_UI_PREVIEW === "1")
    console.log("TEMP_VISUAL_PREVIEW=" + dir);
} finally {
  await browser?.close();
  await app?.stop();
  Object.assign(env, saved);
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("rug-overview-v3-"));
  if (process.env.KEEP_UI_PREVIEW !== "1")
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
}
