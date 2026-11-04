/** Isolated PAPER HTTP/browser checks; no retained screenshots or test data. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { env } from "../src/config.js";
import { provider, position } from "../tests/fixtures.js";
import { ATTEMPT_STAGES } from "../src/candidate-attempt.js";

const dir = mkdtempSync(join(tmpdir(), "kronos-integrated-ui-"));
env.PORT = 42000 + Math.floor(Math.random() * 5000);
env.DATABASE_PATH = join(dir, "fixture.sqlite");
env.TRADING_MODE = "paper";
env.LIVE_TRADING_ACK = false;
env.NEW_ENTRIES_ENABLED = false;
env.SCANNER_ENABLED = false;
env.WALLET_PUBLIC_KEY = "";
const base = `http://127.0.0.1:${env.PORT}`,
  g = provider();
const app = await startServer({
  providers: { gmgn: g.gmgn },
});
await app.engine.stop();
let browser;
try {
  const p = {
    ...position(),
    mode: "paper" as const,
    strategy: "KRONOS" as const,
    symbol: "KROWN",
    lastValueLamports: "1000000",
    lastQuoteAt: Date.now(),
  };
  app.engine.store.savePosition(p);
  for (const [n, strategy] of (
    ["STANDARD", "KRONOS", "KRONOS"] as const
  ).entries())
    app.engine.store.savePosition({
      ...position(),
      id: "closed-" + n,
      mint: "closed-mint-" + n,
      mode: "paper",
      strategy,
      state: "CLOSED",
      quantity: "0",
      symbol: "CLOSED" + n,
      entryAt: Date.now() + n,
    });
  const status = await (await fetch(base + "/api/status")).json();
  assert.equal(
    (await (await fetch(base + "/api/kronos")).json()).integrated,
    true,
  );
  assert.equal(
    (
      await (
        await fetch(base + "/api/history?strategy=KRONOS&limit=1&offset=1")
      ).json()
    )[0].id,
    "closed-1",
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.route("**/api/events", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.goto(base);
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/settings"]',
  );
  await page.evaluate(() => {
    (window as any).stream?.close();
  });
  assert.equal(await page.locator('[data-view="kronos"]').count(), 0);
  await page.locator('[data-view="settings"]').click();
  assert.equal(
    await page.locator('[name="entryStrategy"]').count(),
    0,
  );
  const updated = await page.evaluate(
    async ({ base, csrf, settings }) => {
      const response = await fetch(base + "/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ ...settings, entryStrategy: "KRONOS" }),
      });
      return response.status;
    },
    { base, csrf: status.csrf, settings: app.engine.settings },
  );
  assert.equal(updated, 200);
  assert.equal(app.engine.settings.entryStrategy, "FIRST_BUY_WINS");
  const buySize = page.locator('input[name="positionSizePercent"]');
  assert.equal(await buySize.getAttribute("readonly"), null);
  assert.equal(await buySize.getAttribute("min"), "0.01");
  assert.equal(await buySize.getAttribute("max"), "100");
  assert.equal(await buySize.getAttribute("step"), "0.01");
  await buySize.fill("2.5");
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForFunction(() =>
    document.getElementById("saved")?.textContent?.includes("lưu"),
  );
  assert.equal(app.engine.settings.positionSizePercent, 2.5);
  const sizedStatus = await (await fetch(base + "/api/status")).json();
  assert.equal(
    sizedStatus.nextBuyLamports,
    ((BigInt(sizedStatus.availableLamports) * 250n) / 10000n).toString(),
  );
  const invalid = await page.evaluate(
    async ({ base, csrf, settings }) =>
      (
        await fetch(base + "/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({ ...settings, positionSizePercent: 100.01 }),
        })
      ).status,
    { base, csrf: status.csrf, settings: app.engine.settings },
  );
  assert.equal(invalid, 400);
  assert.equal(app.engine.settings.positionSizePercent, 2.5);
  await page.reload();
  await page.locator('[data-view="settings"]').click();
  await page.waitForSelector('input[name="positionSizePercent"]');
  assert.equal(await buySize.inputValue(), "2.5");
  const frame = {
    attempt: {
      attemptId: "kronos-browser-fixture",
      mint: p.mint,
      symbol: p.symbol,
      source: "GMGN_TRENDING",
      startedAt: Date.now(),
      result: "RUNNING",
      stage: "KRONOS",
      stages: Object.fromEntries(
        ATTEMPT_STAGES.map((s) => [s, s === "KRONOS" ? "CHECKING" : "PENDING"]),
      ),
      summaries: {
        strategy: "FIRST_BUY_WINS",
        strategies: {
          KRONOS: {
            decision: "CHECKING",
            execution: "WAITING_DECISION",
            stages: { KRONOS: "CHECKING" },
          },
        },
        token: { mint: p.mint, symbol: p.symbol },
      },
      logs: [],
    },
    positions: [],
    queue: [],
    scanner: { running: true },
  };
  await page.locator('[data-view="overview"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/"]',
  );
  await page.evaluate(
    (frame) => (window as any).BOTOverview.update(frame),
    frame,
  );
  assert.equal(await page.locator(".strategy-card").count(), 2);
  assert.match(
    await page.locator('.strategy-card[data-strategy="KRONOS"]').innerText(),
    /CHECKING/,
  );
  for (const action of ["BUY", "WAIT"]) {
    const next = {
      ...frame,
      attempt: {
        ...frame.attempt,
        summaries: {
          ...frame.attempt.summaries,
          strategies: {
            KRONOS: {
              decision: action,
              execution: "WAITING_DECISION",
              stages: { KRONOS: "PASS" },
            },
          },
          kronos: {
            action,
            reason: "fixture " + action,
            evidence: { candleCount: 60, terminalPrices: [1, 1.01, 1.02] },
          },
        },
      },
    };
    await page.evaluate(
      (frame) => (window as any).BOTOverview.update(frame),
      next,
    );
    const text = await page
      .locator('.strategy-card[data-strategy="KRONOS"]')
      .innerText();
    assert.equal(
      await page
        .locator('.strategy-card[data-strategy="KRONOS"] [data-stage="KRONOS"]')
        .getAttribute("data-status"),
      "PASS",
    );
    assert.equal(
      await page
        .locator('.strategy-card [data-field="Decision"],#kronosForecast')
        .count(),
      0,
    );
    assert.doesNotMatch(text, /Confidence:|97%/);
    assert.match(
      await page
        .locator('.strategy-card[data-strategy="STANDARD"]')
        .innerText(),
      /Structure Evidence V3/,
    );
  }
  await page.locator('[data-view="positions"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/positions"]',
  );
  await page.waitForSelector("#positions .position-card");
  assert.match(await page.locator("#positions").innerText(), /KRONOS/);
  await page.locator('[data-view="history"]').click();
  const response = page.waitForResponse((r) =>
    r.url().includes("/api/history?strategy=KRONOS"),
  );
  await page.locator("#historyStrategy").selectOption("KRONOS");
  await response;
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#historyRows .strategy-badge").length === 2,
  );
  await page.locator('[data-view="statistics"]').click();
  await page.locator("#statisticsStrategy").selectOption("KRONOS");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('[data-view="overview"]').click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  assert.deepEqual(errors, []);
  assert.equal(app.engine.store.executions().length, 0);
  assert.equal(g.calls.length, 0);
  console.log(
    "PASS: integrated settings, Kronos card, strategy badges, History filter/pagination, statistics filter, desktop/mobile; zero browser errors/real transactions; no images retained.",
  );
} finally {
  await browser?.close();
  await app.stop();
  assert.equal(resolve(dir), resolve(env.DATABASE_PATH, ".."));
  rmSync(dir, { recursive: true, force: true });
}
