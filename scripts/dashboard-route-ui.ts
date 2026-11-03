/** Isolated route/request lifecycle verification. No production clients, credentials or retained artifacts. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { Engine } from "../src/engine.js";
import { TradingMemory } from "../src/trading-memory.js";
import { env } from "../src/config.js";
import { provider, position } from "../tests/fixtures.js";

const dir = mkdtempSync(join(tmpdir(), "dashboard-routes-ui-"));
const heavy = { status: 0, statistics: 0, memory: 0 };
const status = Engine.prototype.status,
  statistics = Engine.prototype.analytics,
  memory = TradingMemory.prototype.report;
Engine.prototype.status = async function () {
  heavy.status++;
  return status.call(this);
};
Engine.prototype.analytics = function (...args) {
  heavy.statistics++;
  return statistics.apply(this, args);
};
TradingMemory.prototype.report = function (...args) {
  heavy.memory++;
  return memory.apply(this, args);
};
let app: Awaited<ReturnType<typeof startServer>> | undefined, browser;
const matrix: Record<string, string[]> = {};
const counts: Record<string, Record<string, number>> = {};
try {
  Object.assign(env, {
    TRADING_MODE: "paper",
    LIVE_TRADING_ACK: false,
    NEW_ENTRIES_ENABLED: false,
    SCANNER_ENABLED: false,
    WALLET_PUBLIC_KEY: "",
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    PORT: 42000 + Math.floor(Math.random() * 5000),
  });
  const g = provider();
  app = await startServer({
    providers: { gmgn: g.gmgn },
  });
  await app.engine.stop();
  const base = "http://127.0.0.1:" + env.PORT;
  app.engine.store.savePosition({
    ...position(),
    mode: "paper",
    symbol: "ROUTE_OPEN",
  });
  const secondPosition = {
    ...position(),
    id: "second-route-open",
    mode: "paper" as const,
    symbol: "SECOND_OPEN",
  };
  app.engine.store.savePosition(secondPosition);
  app.engine.store.savePosition({
    ...position(),
    id: "unsigned-pending-route",
    mode: "paper",
    state: "PENDING_ENTRY",
    quantity: "0",
  });
  app.engine.store.savePosition({
    ...position(),
    id: "closed-route",
    mint: "closed-route-mint",
    mode: "paper",
    symbol: "ROUTE_CLOSED",
    state: "CLOSED",
    quantity: "0",
  });
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const errors: string[] = [];
  const global = "/api/ui/shell";
  const globals = [global, "/api/positions/count"];
  const pages: Record<string, string> = {
    "/": "/api/overview",
    "/positions": "/api/positions",
    "/history": "/api/history",
    "/memory": "/api/learning",
    "/settings": "/api/settings",
    "/logs": "/api/logs",
    "/thongke": "/api/statistics",
    "/watchlist": "/api/watchlist",
    "/deferred": "/api/deferred",
  };
  for (const [route, endpoint] of Object.entries(pages)) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.clock.install();
    const calls: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/api/")) calls.push(path);
    });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(base + route);
    await page.waitForSelector('#routeOutlet[data-state="ready"]', {
      timeout: 15000,
    });
    await page.waitForFunction(
      () => document.getElementById("positionsBadge")?.textContent === "2",
    );
    assert.equal(await page.locator("#routeOutlet > .view").count(), 1);
    assert.equal(new URL(page.url()).pathname, route);
    assert.equal(
      await page
        .locator('a[data-route][aria-current="page"]')
        .getAttribute("href"),
      route,
    );
    assert.equal(
      calls.filter((p) => p === endpoint).length,
      1,
      route + " has one initial page request",
    );
    await page.clock.runFor(16000);
    await page.waitForTimeout(50);
    assert.ok(
      globals.every((p) => calls.includes(p)) && calls.includes(endpoint),
      route + " required dependencies",
    );
    assert.deepEqual(
      [...new Set(calls)].sort(),
      [...globals, endpoint].sort(),
      route + " cannot request any unrelated page API",
    );
    matrix[route] = [...new Set(calls)].sort();
    counts[route] = Object.fromEntries(
      matrix[route].map((path) => [
        path,
        calls.filter((p) => p === path).length,
      ]),
    );
    if (route === "/") {
      assert.equal(heavy.status, 0);
      assert.equal(heavy.statistics, 0);
      assert.equal(heavy.memory, 0);
      assert.equal(await page.locator(".strategy-card").count(), 2);
      assert.equal(
        await page.locator('.strategy-card [data-stage="BUY"]').count(),
        2,
      );
    }
    await page.close();
  }
  assert.equal(heavy.status, 0, "New routes never use full legacy status");
  const page = await browser.newPage();
  await page.clock.install();
  page.on("pageerror", (e) => errors.push(e.message));
  let requests: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/api/")) requests.push(path);
  });
  const ready = async (path: string) => {
    await page.waitForFunction(
      (path) =>
        location.pathname === path &&
        document.getElementById("routeOutlet")?.dataset.state === "ready" &&
        document.getElementById("routeOutlet")?.dataset.route === path,
      path,
      { timeout: 15000 },
    );
  };
  await page.goto(base);
  await ready("/");
  for (const path of ["/history", "/positions", "/thongke", "/"]) {
    await page.locator('a[data-route][href="' + path + '"]').click();
    await ready(path);
    requests = [];
    await page.clock.runFor(16000);
    await page.waitForTimeout(50);
    assert.ok(
      requests.every((p) => globals.includes(p) || p === pages[path]),
      "Leaving a route stops its old polls: " + path,
    );
  }
  await page.locator('a[href="/history"]').click();
  await ready("/history");
  await page.locator('a[href="/positions"]').click();
  await ready("/positions");
  await page.goBack();
  await ready("/history");
  await page.goForward();
  await ready("/positions");
  for (const path of ["/history", "/positions", "/settings"]) {
    await page.goto(base + path);
    await ready(path);
    await page.reload();
    await ready(path);
  }
  // Badge stays current on Settings, without loading the full Positions page.
  app.engine.store.savePosition({
    ...secondPosition,
    state: "CLOSED",
    quantity: "0",
  });
  requests = [];
  await page.clock.runFor(6000);
  await page.waitForFunction(
    () => document.getElementById("positionsBadge")?.textContent === "1",
  );
  assert.ok(requests.every((p) => globals.includes(p)));
  assert.equal(requests.includes("/api/positions"), false);
  // A pending History fetch must be cancelled/ignored after leaving the page.
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    begun = new Promise<void>((r) => (started = r));
  await page.route("**/api/history*", async (route) => {
    started();
    await gate;
    await route
      .fulfill({ json: [{ symbol: "LATE_HISTORY_RESPONSE" }] })
      .catch(() => {});
  });
  await page.locator('a[href="/history"]').click();
  await begun;
  const cancelled = page.waitForEvent("requestfailed", {
    predicate: (r) => new URL(r.url()).pathname === "/api/history",
    timeout: 10000,
  });
  await page.locator('a[href="/positions"]').click();
  await ready("/positions");
  await cancelled;
  release();
  await page.waitForTimeout(50);
  requests = [];
  await page.clock.runFor(16000);
  await page.waitForTimeout(50);
  assert.equal(requests.includes("/api/history"), false);
  assert.doesNotMatch(
    await page.locator("#routeOutlet").innerText(),
    /LATE_HISTORY_RESPONSE/,
  );
  await page.unroute("**/api/history*");
  await page.goto(base);
  await ready("/");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await page.locator(".strategy-card").count(), 2);
  }
  await page.close();
  const local = await browser.newPage();
  local.on("pageerror", (e) => errors.push(e.message));
  await local.goto("http://localhost:" + env.PORT + "/history");
  await local.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.equal(new URL(local.url()).pathname, "/history");
  await local.close();
  // Old running backends have no count endpoint: reuse visible page data until reload.
  const compat = await browser.newPage();
  await compat.clock.install();
  const compatCalls: string[] = [];
  compat.on("request", (r) => compatCalls.push(new URL(r.url()).pathname));
  compat.on("pageerror", (e) => errors.push(e.message));
  await compat.route("**/api/ui/shell", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.capabilities.positionBadgeCount = false;
    data.positionSummary = { count: 3, attention: 2 };
    await route.fulfill({ response, json: data });
  });
  await compat.goto(base + "/positions");
  await compat.waitForSelector('#routeOutlet[data-state="ready"]');
  await compat.waitForFunction(
    () => document.getElementById("positionsBadge")?.textContent === "1",
  );
  await compat.clock.runFor(6000);
  assert.equal(await compat.locator("#positionsBadge").innerText(), "1");
  assert.equal(compatCalls.includes("/api/positions/count"), false);
  await compat.close();
  for (const path of [
    "/",
    "/positions",
    "/history",
    "/memory",
    "/settings",
    "/logs",
    "/thongke",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /html/);
  }
  for (const path of [
    "/overview",
    "/api/not-a-route",
    "/api/history/not-a-route",
    "/not-a-dashboard-route",
  ]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /routeOutlet/);
  }
  const small = await (await fetch(base + global)).json();
  for (const key of [
    "analytics",
    "learning",
    "settings",
    "overview",
    "flow",
    "trades",
    "positionSummary",
  ])
    assert.equal(key in small, false, key + " is not global");
  assert.deepEqual(errors, []);
  assert.equal(g.calls.length, 0);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      routeApiMatrix: matrix,
      requestCountsAfter16s: counts,
      global: globals,
      legacyStatusCalls: heavy.status,
      consoleErrors: errors.length,
      realExecutions: 0,
    }),
  );
} finally {
  await browser?.close();
  await app?.stop();
  Engine.prototype.status = status;
  Engine.prototype.analytics = statistics;
  TradingMemory.prototype.report = memory;
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("dashboard-routes-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
