import { runPositionUiCases } from "./position-ui-cases.mjs";
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "gmgn-oneshot-ui-"));
const port = 41000 + Math.floor(Math.random() * 5000),
  base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dist/server.js"], {
  env: {
    ...process.env,
    TRADING_MODE: "paper",
    LIVE_TRADING_ACK: "false",
    SCANNER_ENABLED: "false",
    NEW_ENTRIES_ENABLED: "false",
    PORT: String(port),
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    WALLET_PUBLIC_KEY: "",
    GMGN_PRIVATE_KEY: "",
    GMGN_PRIVATE_KEY_PATH: "",
    GMGN_API_KEY: "",
    TYPESAFE_API_KEY: "",
    JUPITER_API_KEY: "",
    PAPER_INITIAL_SOL: "1",
  },
  stdio: "pipe",
  windowsHide: true,
});
let browser,
  stderr = "";
server.stderr.on("data", (d) => (stderr += d));
try {
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(base + "/api/status")).ok) break;
    } catch {}
    if (n > 100) throw Error("Paper UI server did not start: " + stderr);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1672, height: 941 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Freeze incoming transport after initial status so deterministic fixture frames cannot be overwritten.
  await page.route("**/api/events", (r) =>
    r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": fixture\n\n",
    }),
  );
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("overviewMode").textContent === "PAPER",
  );
  assert.equal(await page.locator("#terminalOverview").isVisible(), true);
  assert.equal(
    await page.locator("#terminalStages [data-status=PASS]").count(),
    0,
  );
  await page.screenshot({
    path: "data/one-shot-overview-empty.png",
    fullPage: true,
  });
  const now = Date.now(),
    stages = Object.fromEntries(
      [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
        "JEV",
        "RISK",
        "STRUCTURE",
        "FINAL_ANALYSIS",
        "OWNERSHIP_CAPITAL",
        "BUY_QUOTE",
        "EXIT_FEASIBILITY",
        "VALIDATE",
        "SIMULATE",
        "PRE_SIGN",
        "BUY",
        "POSITION",
      ].map((x) => [x, "PENDING"]),
    );
  const known = (value) => ({ state: "KNOWN", value });
  const attempt = {
    attemptId: "ui-attempt-1",
    mint: "backend-mint-one",
    symbol: "BABYAI",
    source: "GMGN_TRENDING",
    startedAt: now,
    result: "RUNNING",
    stage: "SECURITY",
    stages: { ...stages, CHEAP_FILTER: "PASS", SECURITY: "CHECKING" },
    summaries: {
      token: {
        symbol: "BABYAI",
        mint: "backend-mint-one",
        source: "Pump.fun",
        createdAt: now - 8100000,
      },
      market: {
        price: known(0.0001245),
        marketCap: known(124500),
        liquidity: known(82100),
        volume: known(1200000),
      },
      metrics: { holders: 1842, transactions: 12543 },
    },
    logs: [
      {
        at: now,
        stage: "CHEAP_FILTER",
        status: "PASS",
        message: "Cheap Filter: PASS",
      },
      {
        at: now,
        stage: "SECURITY",
        status: "CHECKING",
        message: "Security: CHECKING",
      },
    ],
  };
  const position = {
    id: "position-backend",
    mint: "position-mint",
    symbol: "DOGEAI",
    mode: "paper",
    state: "OPEN",
    displayState: "OPEN",
    exitState: "READY",
    entryPriceUsd: "0.0000821",
    costLamports: "512000000",
    remainingCostLamports: "512000000",
    lastValueLamports: "644608000",
    mfePercent: 34.2,
    maePercent: -8.1,
    entryAt: now - 5040000,
    quantity: "1000",
    valuationStale: false,
  };
  const frame = {
    attempt,
    queue: ["PENG", "MOOD", "SPOOK", "FROG", "NOVA", "PEPE2"].map(
      (symbol, i) => ({ mint: "queued-" + i, symbol }),
    ),
    positions: [position],
    market: [{ mint: position.mint, payload: { priceUsd: "0.0001245" } }],
    scanner: { running: true, scanning: true },
  };
  const update = async (f) =>
    page.evaluate((f) => window.BOTOverview.update(f), f);
  await update(frame);
  assert.equal(
    await page.locator(".central-token").getAttribute("data-attempt-id"),
    "ui-attempt-1",
  );
  assert.equal(
    await page.locator("#terminalStages [data-status=PASS]").count(),
    1,
  );
  assert.equal(
    await page.locator("[data-stage=SECURITY]").getAttribute("data-status"),
    "CHECKING",
  );
  assert.equal(
    await page.locator("#terminalVerdict").textContent(),
    "CHECKING",
  );
  assert.match(
    await page.locator("#terminalLogs").textContent(),
    /Security: CHECKING/,
  );
  const before = await page.locator("#terminalPositionRows").textContent();
  frame.positions[0] = { ...position, lastValueLamports: "700000000" };
  await update(frame);
  assert.notEqual(
    await page.locator("#terminalPositionRows").textContent(),
    before,
  );
  assert.equal(
    await page.locator("[data-stage=SECURITY]").getAttribute("data-status"),
    "CHECKING",
  );
  let request;
  await page.route("**/api/exit", async (r) => {
    request = r.request().postDataJSON();
    await r.fulfill({ contentType: "application/json", body: '{"ok":true}' });
  });
  page.on("dialog", (d) => d.accept());
  await page.locator("#terminalPositionRows [data-sell-percent='50']").click();
  await page.waitForTimeout(50);
  assert.deepEqual(request, { positionId: position.id, sellPercent: 50 });
  frame.positions[0].exitState = "PENDING";
  await update(frame);
  frame.positions[0].exitState = "READY";
  await update(frame);
  await page.locator("#terminalPositionRows [data-sell-percent='100']").click();
  await page.waitForTimeout(50);
  assert.deepEqual(request, { positionId: position.id, sellPercent: 100 });
  frame.attempt = {
    ...attempt,
    result: "REJECTED",
    failedStage: "SECURITY",
    reasonCode: "MINT_AUTHORITY_ACTIVE",
    stages: { ...attempt.stages, SECURITY: "FAIL" },
    logs: [
      ...attempt.logs,
      {
        at: now,
        stage: "SECURITY",
        status: "FAIL",
        message: "MINT_AUTHORITY_ACTIVE",
      },
    ],
  };
  await update(frame);
  assert.equal(
    await page.locator("#terminalVerdict").textContent(),
    "REJECTED",
  );
  assert.match(
    await page.locator("#terminalDecision").textContent(),
    /MINT_AUTHORITY_ACTIVE/,
  );
  assert.equal(
    await page.locator("[data-stage=SECURITY]").getAttribute("data-status"),
    "FAIL",
  );
  await page.screenshot({
    path: "data/one-shot-overview-rejected.png",
    fullPage: true,
  });
  frame.attempt = {
    ...attempt,
    attemptId: "ui-attempt-2",
    symbol: "NEXT",
    stages,
  };
  await update(frame);
  assert.equal(
    await page.locator(".central-token").getAttribute("data-attempt-id"),
    "ui-attempt-2",
  );
  assert.equal(
    await page.locator("#terminalStages [data-status=PASS]").count(),
    0,
  );
  frame.attempt = {
    ...attempt,
    attemptId: "ui-approved",
    result: "BOUGHT",
    stage: "POSITION",
    stages: Object.fromEntries(Object.keys(stages).map((k) => [k, "PASS"])),
    summaries: {
      ...attempt.summaries,
      entryAmountLamports: "234000000",
      jev: { confidence: 0.78 },
      history: {
        tokenAge: 8100000,
        availableHistory: 3600000,
        historyCoverage: 1,
        candles: Array.from({ length: 60 }, (_, i) => ({
          at: now - (60 - i) * 60000,
          close: 0.0001 + i * 0.0000004,
        })),
      },
    },
    logs: [
      ...attempt.logs,
      {
        at: now,
        stage: "POSITION",
        status: "PASS",
        message: "BUY confirmed · Position reconciled",
      },
    ],
  };
  frame.positions = [
    { ...position, id: "approved-doge" },
    {
      ...position,
      id: "approved-pepe",
      mint: "pepe",
      symbol: "PEPE2",
      lastValueLamports: "435000000",
      mfePercent: 12.3,
      maePercent: -18.6,
    },
    {
      ...position,
      id: "approved-nova",
      mint: "nova",
      symbol: "NOVA",
      lastValueLamports: "540000000",
      mfePercent: 28.1,
      maePercent: -11.4,
    },
  ];
  await update(frame);
  assert.equal(
    await page.locator("#terminalVerdict").textContent(),
    "BUY CONFIRMED",
  );
  assert.equal(await page.locator("#terminalPositionRows tr").count(), 3);
  assert.equal(await page.locator(".terminal-sparkline svg").count(), 1);
  await page.screenshot({
    path: "data/one-shot-overview-approved.png",
    fullPage: true,
  });
  await page.locator("[data-view=positions]").click();
  assert.equal(await page.locator("#positions").isVisible(), true);
  await page.locator("[data-view=learning]").click();
  assert.equal(await page.locator("#learning").isVisible(), true);
  await page.locator("[data-view=overview]").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#terminalOverview").isVisible(), true);
  await page.screenshot({
    path: "data/one-shot-overview-mobile.png",
    fullPage: true,
  });
  await page.locator("[data-view=settings]").click();
  assert.equal(await page.locator("#kill").isVisible(), true);
  assert.equal(await page.locator("#scan").isVisible(), true);
  await page.locator("input[name=minLiquidityUsd]").fill("25000");
  await page.locator("#settingsForm button[type=submit]").click();
  await page.waitForFunction(
    () =>
      document.getElementById("saved").textContent.includes("lưu") ||
      document.getElementById("saved").textContent.includes("Saved"),
  );
  assert.equal(
    (await (await fetch(base + "/api/status")).json()).settings.minLiquidityUsd,
    25000,
  );
  await runPositionUiCases(browser, base);
  assert.deepEqual(errors, []);
  writeFileSync(
    "data/one-shot-ui-results.json",
    JSON.stringify(
      {
        passed: true,
        suites: ["Overview", "Positions", "History", "Settings"],
        fail: 0,
        errors,
        mode: "paper",
        realTransactions: 0,
        serverPort: port,
      },
      null,
      2,
    ),
  );
  console.log(
    "Overview, Positions, History and Settings browser checks passed; paper server; no real transactions.",
  );
} finally {
  await browser?.close();
  server.kill();
}
