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
  app.engine.updateSettings({
    ...app.engine.settings,
    takeProfits: [{ gainBps: 4000, sellBps: 2500 }],
  });
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
  assert.deepEqual(
    await page.locator(".settings-group-title").allTextContents(),
    [
      "Quy mô lệnh & vốn",
      "Rủi ro & bảo mật",
      "Nguồn token & xử lý",
      "Thoát lệnh",
    ],
  );
  assert.deepEqual(
    await page
      .locator('[data-group="risk"] input')
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).name),
      ),
    [
      "minLiquidityUsd",
      "maxTop1Percent",
      "maxTop10Percent",
      "maxCreatorPercent",
      "maxTaxPercent",
    ],
  );
  for (const name of [
    "watchMaxSize",
    "watchRecheckMs",
    "deferredTtlMs",
    "structureWatchTtlMs",
    "structureObservationMs",
    "analysisRefreshMs",
    "sniperPollMs",
    "sniperWatchReserve",
    "tokenFailureThreshold",
    "recentRejectTtlMs",
    "flowMaxTransitions",
    "flowObservationIntervalMs",
    "flowRegimeConfirmations",
    "exitProbeMaxImpactPercent",
    "positionRecheckMs",
    "gmgnQueueMaxSize",
    "exitProbeEntryBps",
    "positionExitProbeMs",
    "positionExitProbeSpacingMs",
    "exitProbeMaxAgeMs",
    "structureMaxGapMs",
    "intelligenceCacheMs",
    "trailingStopBps",
    "gmgnBackoffMaxMs",
    "trendingInterval",
    "maxDecisionPriceMovePercent",
    "trailingActivationBps",
    "gmgnBackoffBaseMs",
    "trendingPollMs",
    "flowMaxObservations",
    "flowMinSpanMs",
    "flowHistoryMs",
    "flowMeaningfulChangePercent",
    "trendingFreshMs",
    "candidateQueueSize",
    "paperFeeLamports",
    "exitProbeMinNetLamports",
    "flowStaleMs",
    "liquidityCollapseBps",
    "maxSnapshotAgeMs",
    "criticalRugRatio",
    "exitProbeFeeBudgetLamports",
    "flowMinObservations",
    "feeReserveLamports",
    "warningRugRatio",
    "gmgnRequestIntervalMs",
  ])
    assert.equal(
      await page.locator('[name="' + name + '"]').count(),
      0,
      name + " is hidden from the settings UI",
    );
  for (const name of [
    "positionSizePercent",
    "minLiquidityUsd",
    "trendingMaxAgeSeconds",
  ])
    assert.equal(
      await page.locator('[name="' + name + '"]').count(),
      1,
      name + " still has a live consumer",
    );
  assert.equal(await page.locator("#takeProfits").count(), 0);
  assert.equal(
    await page.locator('label[for="setting-maxTop10Percent"]').innerText(),
    "Top 10 holder %",
  );
  assert.equal(await page.locator("#settingsToast").isVisible(), false);
  const buyPermission = page.getByRole("switch", {
    name: "Cho phép mua",
    exact: true,
  });
  assert.equal(await page.locator("select#kill").count(), 0);
  assert.equal(await buyPermission.isChecked(), false);
  assert.equal(await page.locator("#buyPermissionState").innerText(), "OFF");
  // Only the stopped PAPER fixture permits this operator command.
  env.NEW_ENTRIES_ENABLED = true;
  let controlResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/kill",
  );
  await buyPermission.check();
  assert.equal((await controlResponse).status(), 200);
  await page.waitForSelector("#kill:not([aria-busy])");
  assert.equal(app.engine.store.entriesEnabled(), true);
  assert.equal(await page.locator("#buyPermissionState").innerText(), "ON");
  controlResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/kill",
  );
  await buyPermission.focus();
  await page.keyboard.press("Space");
  assert.equal((await controlResponse).status(), 200);
  await page.waitForSelector("#kill:not([aria-busy])");
  assert.equal(app.engine.store.entriesEnabled(), false);
  assert.equal(await buyPermission.isChecked(), false);
  assert.equal(await page.locator("#buyPermissionState").innerText(), "OFF");
  // A real backend rejection restores the acknowledged OFF state.
  env.NEW_ENTRIES_ENABLED = false;
  controlResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/kill",
  );
  await buyPermission.check();
  assert.equal((await controlResponse).status(), 409);
  await page.waitForSelector("#kill:not([aria-busy])");
  assert.equal(await buyPermission.isChecked(), false);
  assert.equal(app.engine.store.entriesEnabled(), false);
  assert.equal(
    await page.locator("#settingsToast").getAttribute("data-kind"),
    "error",
  );
  await page.locator("#settingsToastClose").click();
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
  const sizeMode = page.locator('[name="positionSizeMode"]'),
    fixedSol = page.locator('[name="positionSizeSol"]'),
    percentSize = page.locator('[name="positionSizePercent"]');
  const saveSizing = async () => {
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/settings" &&
        r.request().method() === "POST",
    );
    await page.locator('#settingsForm button[type="submit"]').click();
    assert.equal((await response).status(), 200);
    await page.waitForSelector("#settingsForm:not([aria-busy])");
    assert.equal(
      await page.locator("#settingsToast").getAttribute("data-kind"),
      "success",
    );
  };
  assert.equal(await sizeMode.inputValue(), "PERCENT");
  assert.equal(await fixedSol.inputValue(), "0.2");
  assert.equal(await fixedSol.isDisabled(), true);
  await sizeMode.selectOption("SOL");
  assert.equal(await percentSize.isDisabled(), true);
  assert.equal(await fixedSol.isEnabled(), true);
  await saveSizing();
  const fixedSettings = await (await fetch(base + "/api/settings")).json();
  assert.equal(fixedSettings.positionSizeMode, "SOL");
  assert.equal(fixedSettings.positionSizeSol, 0.2);
  assert.equal((await app.engine.status()).nextBuyLamports, "200000000");
  await page.reload();
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.equal(await sizeMode.inputValue(), "SOL");
  assert.equal(await fixedSol.inputValue(), "0.2");
  assert.equal(await percentSize.isDisabled(), true);
  await fixedSol.fill("0.234567891");
  await saveSizing();
  assert.equal((await app.engine.status()).nextBuyLamports, "234567891");
  // Server validation rejects invalid SOL without changing saved sizing.
  for (const value of [0, -0.2, 0.0000000001]) {
    const response = await page.evaluate(async (value) => {
      const shell = await (await fetch("/api/ui/shell")).json(),
        settings = await (await fetch("/api/settings")).json();
      return (
        await fetch("/api/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": shell.csrf,
          },
          body: JSON.stringify({ ...settings, positionSizeSol: value }),
        })
      ).status;
    }, value);
    assert.equal(response, 400);
    assert.equal(app.engine.settings.positionSizeSol, 0.234567891);
  }
  await sizeMode.selectOption("PERCENT");
  assert.equal(await percentSize.isEnabled(), true);
  assert.equal(await percentSize.inputValue(), "2.5");
  assert.equal(await fixedSol.isDisabled(), true);
  await saveSizing();
  assert.equal(app.engine.settings.positionSizeMode, "PERCENT");
  assert.equal(app.engine.settings.positionSizeSol, 0.234567891);
  assert.equal((await app.engine.status()).nextBuyLamports, "24500000");
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
    const alignment = await page
      .locator(".settings-group-grid")
      .evaluateAll((grids) =>
        grids.flatMap((grid) => {
          const bounds = grid.getBoundingClientRect();
          const rows = new Map<number, number[]>();
          const problems: string[] = [];
          for (const field of grid.children) {
            const control = field.querySelector("input,select")!;
            const box = control.getBoundingClientRect();
            const row = Math.round(field.getBoundingClientRect().top);
            rows.set(row, [...(rows.get(row) ?? []), box.top]);
            if (
              Math.abs(box.height - 44) > 1 ||
              box.left < bounds.left - 1 ||
              box.right > bounds.right + 1
            )
              problems.push(control.id);
          }
          for (const tops of rows.values())
            if (Math.max(...tops) - Math.min(...tops) > 1)
              problems.push("misaligned row");
          return problems;
        }),
      );
    assert.deepEqual(
      alignment,
      [],
      `Aligned controls within grid at ${width}px`,
    );
    const toast = await page.locator("#settingsToast").boundingBox();
    assert.ok(toast && toast.x >= 0 && toast.x + toast.width <= width);
  }
  // Match the older LIVE backend: no fixed-size keys/capability yet.
  // Controls must stay visible without sending unsupported keys on other saves.
  const legacyPayloads: Record<string, unknown>[] = [];
  await page.route("**/api/ui/shell", async (r) => {
    const response = await r.fetch(),
      data = await response.json();
    delete data.capabilities.fixedSolPositionSize;
    await r.fulfill({ response, json: data });
  });
  await page.route("**/api/settings", async (r) => {
    if (r.request().method() === "POST") {
      legacyPayloads.push(r.request().postDataJSON());
      await r.continue();
      return;
    }
    const response = await r.fetch(),
      data = await response.json();
    delete data.positionSizeMode;
    delete data.positionSizeSol;
    await r.fulfill({ response, json: data });
  });
  await page.reload();
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  assert.equal(await sizeMode.isVisible(), true);
  assert.equal(await sizeMode.isDisabled(), true);
  assert.equal(await sizeMode.inputValue(), "PERCENT");
  assert.equal(await fixedSol.isVisible(), true);
  assert.equal(await fixedSol.inputValue(), "0.2");
  assert.equal(await fixedSol.isDisabled(), true);
  assert.match(
    await page.locator("#positionSizeModeHint").innerText(),
    /Cần nạp backend mới/,
  );
  assert.equal(await percentSize.isEnabled(), true);
  await percentSize.fill("4.5");
  await saveSizing();
  assert.equal(legacyPayloads.length, 1);
  assert.equal(Object.hasOwn(legacyPayloads[0]!, "positionSizeMode"), false);
  assert.equal(Object.hasOwn(legacyPayloads[0]!, "positionSizeSol"), false);
  assert.equal(app.engine.settings.positionSizePercent, 4.5);
  await page.unroute("**/api/ui/shell");
  await page.unroute("**/api/settings");
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
  assert.ok(posts.every((p) => p === "/api/settings" || p === "/api/kill"));
  assert.equal(g.calls.length, 0);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "PASS: fixed-size controls visible on old/new backends, no unsupported legacy save keys, percent/SOL persistence and validation, hidden settings preserved, responsive toasts, no real trading.",
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
