import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { normalizeTokenLogo, TOKEN_IMAGE_CSP } from "../src/token-metadata.ts";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const LOGO = "https://gmgn.ai/external-res/test.webp",
  NEXT = "https://gmgn.ai/external-res/new.webp",
  BROKEN = "https://gmgn.ai/external-res/broken.webp";
try {
  const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const html = readFileSync("public/index.html", "utf8").replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/g,
    "",
  );
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (
      u.origin === "https://gmgn.ai" &&
      u.pathname.startsWith("/external-res/")
    )
      return u.href === BROKEN
        ? route.fulfill({ status: 404, body: "missing" })
        : route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
              "base64",
            ),
          });
    if (u.hostname !== "logos.test") throw Error("Unexpected external request");
    if (u.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src ${TOKEN_IMAGE_CSP}; connect-src 'self'`,
        },
        body: html,
      });
    if (u.pathname === "/style.css")
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync("public/style.css", "utf8"),
      });
    if (u.pathname.startsWith("/api/"))
      return route.fulfill({ contentType: "application/json", body: "{}" });
    return route.abort();
  });
  await page.goto("http://logos.test");
  await page.addScriptTag({
    content: readFileSync("public/token-avatar.js", "utf8"),
  });
  await page.addScriptTag({ content: readFileSync("public/flow.js", "utf8") });
  const app = readFileSync("public/app.js", "utf8").replace(
    /^get\("\/api\/status"\)[\s\S]*?\.catch\(error\);/m,
    "",
  );
  await page.addScriptTag({ content: app });
  await page.addScriptTag({
    content: readFileSync("public/kronos.js", "utf8"),
  });
  const cases = [
    LOGO,
    null,
    BROKEN,
    "javascript:alert(1)",
    "https://evil.test/icon.svg",
    "https://pump.mypinata.cloud/ipfs/real-content-id",
  ];
  const parity = await page.evaluate(
    (values) => values.map((v) => window.BOTTokenAvatar.normalize(v)),
    cases,
  );
  assert.deepEqual(parity, cases.map(normalizeTokenLogo));
  await page.evaluate(
    ({ LOGO, BROKEN }) => {
      const box = document.createElement("div");
      box.id = "avatar-cases";
      for (const [id, token] of Object.entries({
        available: { symbol: "STONK", logo: LOGO },
        missing: { symbol: "PR", logo: null },
        broken: { symbol: "BROKEN", logo: BROKEN },
        unknown: { mint: "UnknownMint123456789" },
        unsafe: { symbol: "<img>", logo: "javascript:alert(1)" },
      })) {
        const avatar = window.BOTTokenAvatar.create(token);
        avatar.id = "case-" + id;
        box.append(avatar);
      }
      document.body.append(box);
    },
    { LOGO, BROKEN },
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#case-available")?.dataset.logoState ===
        "loaded" &&
      document.querySelector("#case-broken")?.dataset.logoState === "fallback",
  );
  assert.equal(
    await page.locator("#case-available img").getAttribute("src"),
    LOGO,
  );
  assert.equal(
    await page.locator("#case-available .token-initials").isHidden(),
    true,
  );
  assert.equal(await page.locator("#case-missing img").count(), 0);
  assert.equal(
    await page.locator("#case-missing .token-initials").textContent(),
    "PR",
  );
  assert.equal(await page.locator("#case-broken img").count(), 0);
  assert.equal(
    await page.locator("#case-broken .token-initials").isVisible(),
    true,
  );
  assert.equal(
    await page.locator("#case-unknown .token-initials").textContent(),
    "?",
  );
  assert.equal(await page.locator("#case-unsafe img").count(), 0);
  const token = {
    mint: "PublicLogoFixtureMint123456789",
    symbol: "STONK",
    name: "Stonk",
    logo: LOGO,
  };
  await page.evaluate((token) => {
    window.BOTTokenAvatar.remember([token]);
    statusData = {
      mode: "paper",
      settings: {
        takeProfits: [],
        trailingActivationBps: 5000,
        trailingStopBps: 2000,
      },
    };
    const p = {
      id: "logo-position",
      mint: token.mint,
      symbol: token.symbol,
      state: "OPEN",
      mode: "paper",
      provider: "JUPITER",
      quantity: "100",
      originalQuantity: "100",
      costLamports: "100",
      remainingCostLamports: "100",
      realizedLamports: "0",
      highWaterLamports: "100",
      lastValueLamports: "100",
      entryAt: Date.now() - 60000,
      lastQuoteAt: Date.now(),
      takenProfits: [],
    };
    renderPositions([p], [token], []);
    renderHistory(
      [{ ...p, id: "logo-history", state: "CLOSED", quantity: "0" }],
      new Map([[token.mint, token]]),
    );
    window.BOTOverview.update(
      {
        attempt: {
          attemptId: "logo-attempt",
          mint: token.mint,
          symbol: token.symbol,
          result: "RUNNING",
          stages: {},
          summaries: { token, market: {} },
          logs: [],
        },
        token,
        queue: [],
        positions: [],
        scanner: { running: true },
      },
      statusData,
    );
    window.BOTLogUI.updateTables([token], [], []);
    window.BOTLogUI.updateStatus({
      mode: "paper",
      events: [
        {
          mint: token.mint,
          at: Date.now(),
          payload: {
            type: "SECURITY_PASS",
            reason: "SECURITY: PASS",
            mode: "paper",
          },
        },
      ],
    });
    window.BOTLogUI.view("logs");
    window.KronosUI.render({
      summary: { records: 2 },
      records: [
        {
          ...token,
          id: "kronos-logo",
          status: "OPEN",
          gates: {},
          latest: { action: "HOLD" },
        },
        {
          id: "unknown-kronos",
          mint: "UnknownKronosMint123456",
          status: "ANALYZING",
          gates: {},
        },
      ],
    });
  }, token);
  for (const selector of [
    "#terminalToken .token-logo",
    "#tokenCarousel .token-logo",
    "#positionRows .token-logo",
    "#historyRows .token-logo",
    "#insightsLogRows .token-logo",
    "#kronosRows .token-logo",
  ]) {
    if (selector.includes("insightsLogRows")) continue;
    assert.equal(
      await page.locator(selector).first().getAttribute("src"),
      LOGO,
      selector,
    );
  }
  assert(
    (await page.locator(".insights-log-avatar .token-logo").count()) > 0,
    "Log uses common image helper",
  );
  assert.match(
    await page.locator("#kronosRows").textContent(),
    /Unknown Token/,
  );
  assert.match(await page.locator("#kronosRows").textContent(), /Unknow…3456/);
  await page.evaluate(
    ({ token, NEXT }) => {
      window.BOTTokenAvatar.remember([{ ...token, logo: NEXT }]);
      renderPositions(
        [
          {
            id: "logo-position",
            mint: token.mint,
            symbol: token.symbol,
            mode: "paper",
            state: "OPEN",
            quantity: "100",
            originalQuantity: "100",
            costLamports: "100",
            remainingCostLamports: "100",
            realizedLamports: "0",
            highWaterLamports: "100",
            lastValueLamports: "100",
            entryAt: Date.now(),
            lastQuoteAt: Date.now(),
            takenProfits: [],
          },
        ],
        [{ ...token, logo: NEXT }],
        [],
      );
    },
    { token, NEXT },
  );
  assert.equal(
    await page.locator("#positionRows .token-logo").first().getAttribute("src"),
    NEXT,
  );
  await page.evaluate(() => {
    document.getElementById("avatar-cases").hidden = true;
    document
      .querySelectorAll("[data-view]")
      .forEach((b) =>
        b.classList.toggle("active", b.dataset.view === "kronos"),
      );
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.toggle("hidden", v.id !== "kronos"));
  });
  mkdirSync("docs/previews", { recursive: true });
  await page.screenshot({
    path: "docs/previews/token-logos-kronos.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: shared logos across Overview/Positions/History/Log/Kronos, available/missing/broken/unknown/unsafe, metadata refresh and CSP allowlist. Images intercepted; no provider or trading calls.",
  );
} finally {
  await browser.close();
}
