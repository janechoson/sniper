/** Actual temp HTTP settings persistence + browser save feedback; no production writes. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { env } from "../src/config.js";
import { provider } from "../tests/fixtures.js";
const dir = mkdtempSync(join(tmpdir(), "settings-feedback-ui-"));
let app: Awaited<ReturnType<typeof startServer>> | undefined, browser;
try {
  Object.assign(env, {
    DATABASE_PATH: join(dir, "fixture.sqlite"),
    PORT: 43000 + Math.floor(Math.random() * 4000),
    TRADING_MODE: "paper",
    LIVE_TRADING_ACK: false,
    WALLET_PUBLIC_KEY: "",
    SCANNER_ENABLED: false,
    NEW_ENTRIES_ENABLED: false,
  });
  const g = provider();
  app = await startServer({ providers: { gmgn: g.gmgn } });
  await app.engine.stop();
  const base = "http://127.0.0.1:" + env.PORT;
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [],
    posts: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(new URL(r.url()).pathname);
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.goto(base + "/settings");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  for (const name of [
    "watchMaxSize",
    "watchRecheckMs",
    "deferredTtlMs",
    "structureWatchTtlMs",
    "structureObservationMs",
    "analysisRefreshMs",
    "sniperPollMs",
    "sniperWatchReserve",
  ])
    assert.equal(
      await page.locator('[name="' + name + '"]').count(),
      0,
      name + " is retired from normal one-shot settings",
    );
  for (const name of [
    "positionSizePercent",
    "minLiquidityUsd",
    "structureMaxGapMs",
    "trendingMaxAgeSeconds",
    "tokenFailureThreshold",
    "recentRejectTtlMs",
    "trailingActivationBps",
    "maxSnapshotAgeMs",
  ])
    assert.equal(
      await page.locator('[name="' + name + '"]').count(),
      1,
      name + " still has a live consumer",
    );
  assert.equal(await page.locator("#settingsToast").isVisible(), false);
  const before = await (await fetch(base + "/api/settings")).json();
  await page.locator('[name="positionSizePercent"]').fill("2.5");
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForSelector(
    '#settingsToast[data-kind="success"]:not([hidden])',
  );
  assert.match(
    await page.locator("#settingsToast").innerText(),
    /Đã lưu cấu hình thành công/,
  );
  const after = await (await fetch(base + "/api/settings")).json();
  assert.equal(after.positionSizePercent, 2.5);
  for (const key of Object.keys(before).filter(
    (k) => k !== "positionSizePercent",
  ))
    assert.deepEqual(after[key], before[key], key + " preserved on save");
  // A rejected API preserves user's edits and shows actionable, safely rendered feedback.
  await page.route("**/api/settings", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ status: 400, json: { error: "FIXTURE_VALIDATION_FAILED" } })
      : r.continue(),
  );
  await page.locator('[name="positionSizePercent"]').fill("3");
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForSelector('#settingsToast[data-kind="error"]:not([hidden])');
  assert.match(
    await page.locator("#settingsToast").innerText(),
    /Lưu cấu hình thất bại.*FIXTURE_VALIDATION_FAILED/,
  );
  assert.equal(
    await page.locator('[name="positionSizePercent"]').inputValue(),
    "3",
  );
  assert.equal(
    (await (await fetch(base + "/api/settings")).json()).positionSizePercent,
    2.5,
  );
  assert.equal(
    await page.locator("#settingsToast").getAttribute("role"),
    "alert",
  );
  assert.equal(
    await page.locator('#settingsForm button[type="submit"]').isEnabled(),
    true,
  );
  await page.locator("#settingsToastClose").click();
  assert.equal(await page.locator("#settingsToast").isVisible(), false);
  await page.unroute("**/api/settings");
  // Invalid JSON is rejected locally before POST.
  const count = posts.length;
  await page.locator("#takeProfits").fill("not-json");
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForSelector('#settingsToast[data-kind="error"]:not([hidden])');
  assert.equal(posts.length, count);
  await page.locator("#takeProfits").fill(JSON.stringify(after.takeProfits));
  // Save acknowledgement remains successful when the follow-up GET is unavailable.
  let saved = false;
  await page.route("**/api/settings", async (r) => {
    if (r.request().method() === "POST") {
      const result = await r.fetch();
      saved = true;
      await r.fulfill({ response: result });
    } else if (saved)
      await r.fulfill({
        status: 503,
        json: { error: "FIXTURE_REFRESH_FAILED" },
      });
    else await r.continue();
  });
  await page.locator('#settingsForm button[type="submit"]').click();
  await page.waitForSelector(
    '#settingsToast[data-kind="warning"]:not([hidden])',
  );
  assert.match(
    await page.locator("#settingsToast").innerText(),
    /Cấu hình đã lưu/,
  );
  assert.equal(
    (await (await fetch(base + "/api/settings")).json()).positionSizePercent,
    3,
  );
  await page.unroute("**/api/settings");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const toast = await page.locator("#settingsToast").boundingBox();
    assert.ok(toast && toast.x >= 0 && toast.x + toast.width <= width);
  }
  await page.locator('a[data-route][href="/history"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/history"]',
  );
  assert.equal(
    await page.locator("#settingsToast").count(),
    0,
    "Toast does not leak across routes",
  );
  assert.deepEqual(errors, []);
  assert.ok(posts.every((p) => p === "/api/settings"));
  assert.equal(g.calls.length, 0);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "PASS: retired controls removed, active backoff/Structure freshness/reference/sizing retained, actual successful save and hidden values preserved, API/JSON failure, post-save refresh warning, responsive accessible toast, no real trading.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("settings-feedback-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
