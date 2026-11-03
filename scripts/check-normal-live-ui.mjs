import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "chrome" } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  mutations = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => {
  if (!["GET", "HEAD"].includes(route.request().method())) {
    mutations.push(route.request().method() + " " + route.request().url());
    return route.abort();
  }
  return route.continue();
});
try {
  await page.goto("http://127.0.0.1:3000", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.querySelector("#mode")?.textContent?.toLowerCase() === "live",
  );
  const status = await page.request
    .get("http://127.0.0.1:3000/api/status")
    .then((r) => r.json());
  assert.equal(status.controlled, null);
  assert.equal(status.newEntriesEnabled, true);
  assert.equal(status.haltReason, null);
  assert.equal(status.scanner.running, true);
  assert.equal("maxPositions" in status.settings, false);
  await page.locator('[data-view="positions"]').click();
  await page
    .locator("#positionRows")
    .getByText("IMAGINE", { exact: false })
    .first()
    .waitFor();
  const badge = await page.locator("#positionsBadge").textContent();
  assert.match(badge.trim(), /^\d+$/);
  assert.ok(await page.getByText("MFE:", { exact: false }).count());
  assert.ok(await page.getByText("NEEDS_ATTENTION", { exact: false }).count());
  await page.screenshot({
    path: "data/normal-live-positions.png",
    fullPage: true,
  });
  await page.locator('[data-view="settings"]').click();
  assert.equal(await page.locator('[name="maxPositions"]').count(), 0);
  await page.locator('[data-view="overview"]').click();
  await page.screenshot({
    path: "data/normal-live-dashboard.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []);
  const evidence = {
    at: new Date().toISOString(),
    badge: badge.trim(),
    entriesEnabled: status.newEntriesEnabled,
    scannerRunning: status.scanner.running,
    controlled: status.controlled,
    haltReason: status.haltReason,
    browserErrors: errors,
    mutationRequests: mutations,
    screenshots: [
      "data/normal-live-positions.png",
      "data/normal-live-dashboard.png",
    ],
  };
  writeFileSync(
    "data/normal-live-ui-verification.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
