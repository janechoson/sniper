import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    }),
    errors = [],
    commands = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const now = Date.now(),
    record = {
      id: "paper-fixture",
      mint: "PublicFixtureMintOnly",
      symbol: "DEMO",
      name: "Paper fixture",
      status: "OPEN",
      createdAt: now,
      discoveredAt: now,
      source: "GMGN_TRENDING",
      gates: { SECURITY: { status: "PASS", at: now } },
      entry: { value: 1, observedAt: now - 600000, source: "GMGN_TOKEN_INFO" },
      current: { value: 1.1, observedAt: now, source: "GMGN_TOKEN_INFO" },
      currentPnlPct: 10,
      pnlPct: 10,
      mfePct: 15,
      maePct: -3,
      priceStale: false,
      latest: {
        action: "HOLD",
        at: now,
        lastObservedClose: 1.1,
        forecast: {
          paths: [
            [1.1, 1.11, 1.12, 1.13, 1.14],
            [1.1, 1.09, 1.08, 1.09, 1.12],
            [1.1, 1.1, 1.12, 1.11, 1.13],
          ],
        },
      },
    };
  const state = {
    paperOnly: true,
    enabled: false,
    csrf: "lab-fixture",
    summary: {
      records: 1,
      limit: 300,
      paperBuys: 1,
      open: 1,
      closed: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      averagePnlPct: null,
      totalPaperPnlPct: null,
    },
    records: [record],
    queueDepth: 0,
    concurrency: 1,
    inference: { p50Ms: 650, p95Ms: null, timeouts: 0 },
  };
  const html = readFileSync("public/index.html", "utf8").replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/g,
    "",
  );
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== "kronos.test") throw Error("External request forbidden");
    let body,
      type = "application/json";
    if (u.pathname === "/") {
      body = html;
      type = "text/html";
    } else if (u.pathname === "/style.css") {
      body = readFileSync("public/style.css", "utf8");
      type = "text/css";
    } else if (u.pathname === "/api/kronos") body = JSON.stringify(state);
    else if (u.pathname === "/api/status")
      body = JSON.stringify({ csrf: "bot-fixture" });
    else if (u.pathname === "/api/kronos/control") {
      const data = route.request().postDataJSON();
      commands.push(data);
      body = JSON.stringify({
        ok: true,
        decisions: [
          { action: "PAPER_BUY", at: now - 600000 },
          { action: "HOLD", at: now },
        ],
      });
    } else return route.abort();
    await route.fulfill({ body, contentType: type });
  });
  await page.goto("http://kronos.test");
  await page.addScriptTag({
    content: readFileSync("public/kronos.js", "utf8"),
  });
  await page.evaluate((s) => {
    document
      .querySelectorAll(".view")
      .forEach((e) => e.classList.toggle("hidden", e.id !== "kronos"));
    window.KronosUI.render(s);
  }, state);
  assert.match(
    await page.locator("#kronos").textContent(),
    /PAPER TRADING ONLY/,
  );
  assert.match(await page.locator("#kronosRows").textContent(), /PAPER OPEN/);
  assert.match(await page.locator("#kronosRows").textContent(), /\+10%/);
  assert.match(await page.locator("#kronos").textContent(), /1 \/ 300/);
  await page.locator("#kronosRows button").click();
  assert.equal(await page.locator("#kronosRows svg").count(), 1);
  assert.match(
    await page.locator("#kronosRows pre").textContent(),
    /PAPER_BUY/,
  );
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/kronos/control") &&
        r.request().postDataJSON()?.action === "enable",
    ),
    page.locator("#kronosEnable").click(),
  ]);
  assert(
    commands.some((x) => x.action === "enable" && x.csrf === "lab-fixture"),
  );
  page.once("dialog", (d) => d.dismiss());
  await page.locator("#kronosReset").click();
  assert(!commands.some((x) => x.action === "reset"));
  page.once("dialog", (d) => d.accept());
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/kronos/control") &&
        r.request().postDataJSON()?.action === "reset",
    ),
    page.locator("#kronosReset").click(),
  ]);
  assert(
    commands.some(
      (x) =>
        x.action === "reset" &&
        x.confirmation === "RESET KRONOS PAPER EXPERIMENT",
    ),
  );
  mkdirSync("docs/previews", { recursive: true });
  await page.screenshot({
    path: "docs/previews/kronos-lab-desktop.png",
    fullPage: true,
  });
  await page.evaluate(
    (s) =>
      window.KronosUI.render({
        ...s,
        records: [
          {
            ...s.records[0],
            symbol: "<img src=x onerror=alert(1)>",
            priceStale: true,
            currentPnlPct: null,
          },
        ],
      }),
    state,
  );
  assert.equal(await page.locator("#kronosRows img").count(), 0);
  assert.match(await page.locator("#kronosRows").textContent(), /STALE/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/previews/kronos-lab-mobile.png",
    fullPage: true,
  });
  assert(
    await page
      .locator(".kronos-table-wrap")
      .evaluate((e) => e.scrollWidth > e.clientWidth),
  );
  await page.evaluate(() =>
    window.KronosUI.render({ error: "KRONOS_LAB_OFFLINE", records: [] }),
  );
  assert.equal(await page.locator("#kronosEnable").isDisabled(), true);
  assert.match(await page.locator("#kronosStatus").textContent(), /offline/);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Kronos PAPER UI, actual-state metrics/unknowns, forecast labels, details, reset confirmation, offline/stale/XSS, desktop/mobile. All calls intercepted; no server/production data.",
  );
} finally {
  await browser.close();
}
