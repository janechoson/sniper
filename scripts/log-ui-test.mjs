import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

// Browser-only fixture: no server, database, credentials or trading process.
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const html = readFileSync("public/index.html", "utf8").replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/g,
    "",
  );
  await page.route("http://log.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: path.endsWith(".css") ? "text/css" : "text/html",
      body: path.endsWith(".css")
        ? readFileSync("public/style.css", "utf8")
        : html,
    });
  });
  await page.goto("http://log.test/");
  const code = readFileSync("public/app.js", "utf8").split(
    "/* Backend-driven overview.",
  )[0];
  await page.addScriptTag({ content: code });
  await page.evaluate(() => {
    document
      .querySelectorAll(".view")
      .forEach((e) => e.classList.toggle("hidden", e.id !== "logs"));
    document
      .querySelectorAll("[data-view]")
      .forEach((e) => e.classList.toggle("active", e.dataset.view === "logs"));
    window.BOTLogUI.view("logs");
    window.BOTLogUI.connection(true);
    window.BOTLogUI.updateTables(
      [
        {
          mint: "fixture-mint-babyai-123456789",
          symbol: "BABYAI",
          name: "Baby AI",
        },
      ],
      [],
      [],
    );
  });
  const now = Date.now();
  const event = (
    type,
    reason,
    offset = 0,
    mint = "fixture-mint-babyai-123456789",
  ) => ({ mint, at: now - offset, payload: { type, reason, mode: "paper" } });
  const fixture = [
    event("ATTEMPT_STARTED", "Fresh attempt"),
    event("SECURITY_PASS", "SECURITY: PASS", 1000),
    event("RISK_ALLOW", "RISK: PASS", 2000),
    event(
      "ATTEMPT_REJECTED",
      "00000000-0000-4000-8000-000000000001 · STRUCTURE · INSUFFICIENT_STRUCTURE_EVIDENCE",
      3000,
    ),
    event("JEV_APPROVED", "JEV approved", 4000),
    event("BUY_CONFIRMED", "Confirmed", 5000),
    event("SYSTEM_UNKNOWN", "Evidence unavailable", 6000, "unknown-mint"),
    event("SECURITY_PASS", "Old event", 10 * 86400000),
  ];
  const feed = (events) =>
    page.evaluate(
      (events) => window.BOTLogUI.updateStatus({ mode: "paper", events }),
      events,
    );
  const rows = page.locator(".insights-log-row");
  await feed(fixture);
  assert.equal(await rows.count(), 7);
  await feed(fixture);
  assert.equal(await rows.count(), 7, "dedup");
  assert.match(await rows.allTextContents().then((x) => x.join(" ")), /BABYAI/);
  assert.match(
    await rows.allTextContents().then((x) => x.join(" ")),
    /Unknown Token/,
  );
  assert.match(
    await rows.allTextContents().then((x) => x.join(" ")),
    /UNKNOWN/,
  );
  await page.locator('[data-log-type="STRUCTURE"]').click();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.innerText(), /REJECT/);
  await rows.locator("button[aria-expanded]").click();
  assert.match(
    await page.locator(".insights-log-detail-row:visible").innerText(),
    /INSUFFICIENT_STRUCTURE_EVIDENCE/,
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#logExport").click();
  const download = await downloadPromise;
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  assert.equal(exported.rows.length, 1);
  assert.deepEqual(exported.rows[0].raw, fixture[3]);
  await page.locator('[data-log-type="ALL"]').click();
  await page.locator("#logSearch").fill("insufficient_structure");
  assert.equal(await rows.count(), 1);
  await page.locator("#logSearch").fill("Baby AI");
  assert.equal(await rows.count(), 6);
  await page.locator("#logSearch").fill("");
  await page.locator("#logRange").selectOption("all");
  assert.equal(await rows.count(), 8);
  await page.locator("#logPause").click();
  await feed([event("ATTEMPT_STARTED", "Realtime new", -1000)]);
  assert.equal(await rows.count(), 8, "pause freezes display");
  await page.locator("#logPause").click();
  assert.equal(await rows.count(), 9, "resume catches up");
  await page.locator('.insights-log-row button[aria-expanded="true"]').click();
  mkdirSync("docs/previews", { recursive: true });
  await page.screenshot({
    path: "docs/previews/log-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/previews/log-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "no global horizontal overflow",
  );
  await page.setViewportSize({ width: 1500, height: 900 });
  await feed(
    Array.from({ length: 850 }, (_, i) =>
      event("SYSTEM_EVENT", "bounded-" + i, -2000 - i),
    ),
  );
  assert.equal(await rows.count(), 40);
  assert.match(await page.locator("#logScope").innerText(), /800 log/);
  await page.locator("#logNext").click();
  assert.equal(await page.locator("#logPage").innerText(), "2 / 20");
  await page.locator("#logClear").click();
  assert.equal(await rows.count(), 0);
  await feed(fixture);
  assert.equal(
    await rows.count(),
    0,
    "old batch cannot repopulate cleared display",
  );
  await feed([event("SYSTEM_EVENT", "after clear", -100000)]);
  assert.equal(await rows.count(), 1);
  const v3 = {
    type: "STRUCTURE_EVIDENCE_V3",
    priceStatus: "PRICE_RECOVERY_INFERRED",
    marketFlowStatus: "SUPPORTIVE",
    smartMoneyStatus: "BUY_SUPPORT",
    supportLevel: "STRONG",
    evidence: {
      passed: true,
      smartMoney: { distinctBuyers: 2, distinctSellers: 1 },
    },
  };
  await feed([
    {
      mint: "fixture-mint-babyai-123456789",
      at: Date.now() + 200000,
      payload: v3,
    },
  ]);
  await page.locator('[data-log-type="STRUCTURE"]').click();
  assert.equal(await rows.count(), 1);
  assert.match(await rows.innerText(), /STRUCTURE EVIDENCE V3/);
  assert.match(await rows.innerText(), /2 buyers \/ 1 sellers/);
  await rows.locator("button[aria-expanded]").click();
  assert.match(
    await page.locator(".insights-log-detail-row:visible").innerText(),
    /PRICE_RECOVERY_INFERRED/,
  );
  await page.screenshot({
    path: "docs/previews/structure-v3-log.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Log browser fixtures, metadata, results, dedup, filters, search, ranges, raw detail/export, pause/resume, pagination, buffer bound, local clear, desktop/mobile. No server or trading calls.",
  );
} finally {
  await browser.close();
}
