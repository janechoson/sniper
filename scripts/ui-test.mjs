import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startKronos } from "../dist/server.js";
import { runtimeConfig, ROOT } from "../dist/config.js";
import { paperFill, markPrice } from "../dist/kronos-domain.js";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
mkdirSync(join(ROOT, "data"), { recursive: true });
mkdirSync("docs/previews", { recursive: true });
const dir = mkdtempSync(join(ROOT, "data", "test-overview-"));
let release;
const at = Date.now(),
  tail = Math.floor(at / 60000) * 60000;
const candles = Array.from({ length: 40 }, (_, i) => ({
  at: tail - (40 - i) * 60000,
  open: 1,
  high: 1.02,
  low: 0.98,
  close: 1,
}));
const market = {
  discover: async () => [],
  prepare: async (c, stage) => {
    for (const n of [
      "CHEAP_FILTER",
      "SECURITY",
      "COMPATIBILITY",
      "HISTORY",
      "CAPITAL_FLOW",
    ])
      await stage(n, async () => ({ fixture: true }));
    return {
      candles,
      evidence: {
        candles,
        availableHistory: 2400000,
        historyCoverage: 2 / 3,
        tokenAge: 3600000,
      },
    };
  },
  history: async () => ({ candles, evidence: { candles } }),
  price: async () => ({
    value: 1,
    observedAt: Date.now(),
    source: "GMGN_TOKEN_INFO",
  }),
};
const inference = {
  forecast: () =>
    new Promise((r) => {
      release = r;
    }),
  stop() {},
  status: () => ({ active: true, loaded: true }),
};
const cfg = runtimeConfig({
  KRONOS_PORT: String(49000 + Math.floor(Math.random() * 500)),
  KRONOS_DATABASE_PATH: join(dir, "ui.sqlite"),
  KRONOS_RUNTIME: join(dir, "runtime"),
  KRONOS_LOG_DIR: join(dir, "logs"),
});
const app = await startKronos(cfg, { market, inference, timer: false });
let pending;
try {
  const geometry = async (page) =>
    page.evaluate(() =>
      Object.fromEntries(
        [
          "aside",
          ".token-scanner",
          ".current-token",
          ".current-evaluation",
          "#terminalResult",
          ".action-log",
          ".overview-positions",
        ].map((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return [s, { x: r.x, y: r.y, width: r.width, height: r.height }];
        }),
      ),
    );
  const reference = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  await reference.route("**/*", (r) => {
    const u = new URL(r.request().url());
    return r.request().method() === "GET" &&
      u.hostname === "127.0.0.1" &&
      u.port === "3000"
      ? r.continue()
      : r.abort();
  });
  await reference.goto("http://127.0.0.1:3000/");
  await reference.waitForSelector(".central-token");
  await reference.screenshot({
    path: "docs/previews/bot-b-overview-reference.png",
    fullPage: true,
  });
  const referenceGeometry = await geometry(reference);
  await reference.close();
  app.store.db.exec("BEGIN");
  for (let i = 0; i < 5000; i++) {
    const t = app.store.add;
    const p = {
      id: "history" + i,
      mint: "history" + i,
      appearance: "history" + i,
      source: "GMGN_TRENDING",
      createdAt: at,
      updatedAt: at,
      status: "CLOSED",
      gates: {},
      nextAt: at,
      decisionCount: 0,
      entry: { value: 1, observedAt: at - 60000, source: "GMGN_TOKEN_INFO" },
      exit: { value: 1, observedAt: at, source: "GMGN_TOKEN_INFO" },
      pnlPct: 0,
      checkedAt: at,
    };
    app.store.db
      .prepare("INSERT INTO lab_trials VALUES(?,?,?,?)")
      .run(p.id, p.mint, p.appearance, JSON.stringify(p));
  }
  app.store.db.exec("COMMIT");
  for (let i = 0; i < 5; i++) {
    const t = app.store.add({
      mint: "open" + i,
      symbol: "OPEN" + i,
      appearance: "open" + i,
      discoveredAt: at,
    });
    paperFill(
      t,
      {
        at: at - 60000,
        inputAt: at - 60000,
        action: "PAPER_BUY",
        reason: "fixture",
      },
      { value: 1, observedAt: at - 60000, source: "GMGN_TOKEN_INFO" },
      at - 60000,
    );
    markPrice(
      t,
      { value: 1.1, observedAt: Date.now(), source: "GMGN_TOKEN_INFO" },
      Date.now(),
    );
    t.nextAt = Date.now() + 600000;
    app.store.save(t);
  }
  for (let i = 0; i < 8; i++)
    app.store.add({
      mint: "token" + i,
      symbol: "TOKEN" + i,
      appearance: "token" + i,
      discoveredAt: at,
    });
  const t = app.store.page({ activeOnly: true, limit: 1 }).rows[0];
  app.lab.setEnabled(true);
  pending = app.lab.tick();
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1050 },
    }),
    errors = [],
    responses = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (r) => {
    const u = new URL(r.request().url());
    return u.hostname === "127.0.0.1" && u.port === String(cfg.port)
      ? r.continue()
      : r.abort();
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/")) responses.push(new URL(r.url()).pathname);
  });
  const start = performance.now();
  await page.goto("http://127.0.0.1:" + cfg.port);
  await page.waitForSelector(".central-token");
  await page.waitForFunction(
    () => document.getElementById("terminalVerdict").textContent === "CHECKING",
  );
  const loadMs = performance.now() - start,
    newGeometry = await geometry(page);
  for (const s of [
    ".token-scanner",
    ".current-token",
    ".current-evaluation",
    "#terminalResult",
    ".action-log",
  ])
    for (const k of ["x", "y", "width", "height"])
      assert(
        Math.abs(referenceGeometry[s][k] - newGeometry[s][k]) < 2,
        "Overview geometry mismatch: " + s + " " + k,
      );
  assert.equal(
    await page.locator("#terminalStages .terminal-stage").count(),
    7,
  );
  assert.equal(
    await page.locator("#terminalStages [data-status=PASS]").count(),
    5,
  );
  assert.equal(
    await page.locator("#terminalStages [data-status=CHECKING]").count(),
    1,
  );
  assert.equal(await page.locator("#terminalPositionRows tr").count(), 5);
  const text = await page.locator("#overview").textContent();
  assert.doesNotMatch(
    text,
    /JEV|Structure Evidence|Controlled Markup|Tokens Checked|Selection Rate|Win Rate|Trading Memory/,
  );
  assert.match(
    await page.locator("aside").textContent(),
    /PAPER.*MARKET: REAL/s,
  );
  assert.equal(await page.locator("[data-sell-percent]").count(), 0);
  assert((await page.locator("#tokenCarousel .carousel-token").count()) <= 7);
  await page.screenshot({
    path: "docs/previews/kronos-overview-desktop.png",
    fullPage: true,
  });
  await page.locator("[data-view=history]").click();
  await page.waitForSelector("#historyRows .history-record");
  assert.equal(await page.locator("#historyRows .history-record").count(), 50);
  const first = await page
    .locator("#historyRows .history-record")
    .first()
    .textContent();
  await page.locator("#historyNext").click();
  await page.waitForTimeout(150);
  assert.notEqual(
    await page.locator("#historyRows .history-record").first().textContent(),
    first,
  );
  await page.locator("#historyPrevious").click();
  await page.locator("[data-view=statistics]").click();
  await page.waitForSelector("#statCards .kronos-stat");
  assert.match(
    await page.locator("#statistics").textContent(),
    /Tokens Checked/,
  );
  assert.match(await page.locator("#statistics").textContent(), /Breakeven/);
  await page.screenshot({
    path: "docs/previews/kronos-statistics.png",
    fullPage: true,
  });
  await page.locator("[data-view=settings]").click();
  await page.waitForSelector("#configuration strong");
  await page.locator("#collectionPause").click();
  await page.waitForFunction(() =>
    document
      .getElementById("terminalRunning")
      .textContent.includes("Collection Paused"),
  );
  await page.locator("[data-view=overview]").click();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.waitForTimeout(100);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "horizontal overflow",
    );
    await page.screenshot({
      path: "docs/previews/kronos-overview-" + width + ".png",
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    "evidence/continuous-ui.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        syntheticRecords: 5013,
        loadMs,
        referenceGeometry,
        newGeometry,
        errors,
        apiPaths: [...new Set(responses)],
        allFixtureRequestsIntercepted: true,
        realSourceReferenceReadOnly: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: BOT B/Kronos Overview geometry; 5000-row pagination, seven stages, honest mode/status, stats separation, desktop/mobile, no real execution.",
  );
} finally {
  release?.({ error: "fixture_stop" });
  await pending?.catch(() => {});
  await app.stop();
  await browser.close();
}
