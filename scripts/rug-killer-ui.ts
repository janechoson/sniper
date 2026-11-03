/** Fixture-only design/grouped-log browser verification; no production commands or artifacts. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { env } from "../src/config.js";
import { provider, position } from "../tests/fixtures.js";
import { ATTEMPT_STAGES } from "../src/candidate-attempt.js";
const dir = mkdtempSync(join(tmpdir(), "rug-killer-ui-"));
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
    viewport: { width: 1440, height: 1080 },
  });
  const errors: string[] = [],
    calls: string[] = [],
    methods: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) {
      calls.push(new URL(r.url()).pathname);
      methods.push(r.method());
    }
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const now = await page.evaluate(() => Date.now()),
    id1 = "11111111-1111-4111-8111-111111111111",
    id2 = "22222222-2222-4222-8222-222222222222";
  const mint = "fixture-mint";
  const event = (
    id: number,
    at: number,
    attemptId: string,
    reason: string,
    status = "PASS",
    stage = "SECURITY",
  ) => ({
    id,
    mint,
    at,
    payload: { mode: "paper", attemptId, stage, status, reason, type: "STAGE" },
  });
  const payload: any = {
    mode: "paper",
    tokens: [{ mint, symbol: "HEDGE" }],
    events: Array.from({ length: 8 }, (_, i) =>
      event(
        i + 1,
        now - 10000 + i,
        id1,
        i === 4 ? "CHILD_ONLY_HOLDER_REASON" : "SECURITY snapshot " + i,
      ),
    ),
    flow: { events: [] },
    overview: { attempt: null },
  };
  await page.route("**/api/logs?*", (r) => r.fulfill({ json: payload }));
  const releases: Array<() => void> = [];
  let held = false;
  await page.route("**/api/attempt?*", async (r) => {
    const id = new URL(r.request().url()).searchParams.get("id");
    if (held)
      await new Promise<void>((done) => {
        releases.push(done);
      });
    await r.fulfill({
      json: {
        attemptId: id,
        mint,
        mode: "paper",
        symbol: "HEDGE",
        startedAt: now - 11000,
        result: "REJECTED",
        endedAt: now - 1000,
        logs: [
          {
            at: now - 8000,
            stage: "RISK",
            status: "FAIL",
            message: "PERSISTED_DETAIL_REASON",
          },
        ],
        ownershipClaim: { strategy: "KRONOS" },
      },
    });
  });
  await page.goto(base + "/logs");
  await page.waitForSelector('#routeOutlet[data-state="ready"]');
  const rows = () => page.locator(".rk-log-parent");
  assert.equal(await rows().count(), 1);
  assert.equal(await rows().locator(".rk-log-count").innerText(), "8");
  assert.equal(
    await page.locator(".rk-log-timeline li").count(),
    0,
    "No hidden child DOM on initial load",
  );
  assert.equal(calls.includes("/api/attempt"), false);
  await rows().locator(".rk-log-expand").click();
  await page.waitForSelector(".rk-log-timeline li", {});
  await page.waitForFunction(() =>
    document
      .querySelector(".rk-log-timeline")
      ?.textContent?.includes("PERSISTED_DETAIL_REASON"),
  );
  assert.equal(calls.filter((p) => p === "/api/attempt").length, 1);
  assert.equal(await rows().locator(".rk-log-count").innerText(), "9");
  assert.match(await rows().innerText(), /KRONOS · OWNER/);
  await page
    .locator(".rk-log-raw")
    .first()
    .evaluate((e) => {
      (e as HTMLDetailsElement).open = true;
    });
  await page.waitForSelector(".rk-log-raw pre");
  await page.clock.runFor(5100);
  assert.equal(
    await page
      .locator(".rk-log-raw")
      .first()
      .evaluate((e) => (e as HTMLDetailsElement).open),
    true,
    "Polling preserves open raw detail",
  );
  assert.equal(
    await page.locator(".rk-log-timeline time").first().innerText(),
    new Date(now - 10000).toLocaleTimeString("vi-VN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
      "." +
      String(new Date(now - 10000).getMilliseconds()).padStart(3, "0"),
  );
  await page.locator("#logSearch").fill("CHILD_ONLY_HOLDER_REASON");
  assert.equal(await rows().count(), 1);
  await page.locator("#logSearch").fill("absent-child");
  assert.equal(await rows().count(), 0);
  await page.locator("#logSearch").fill("");
  await page
    .locator("#logTypeFilters button")
    .filter({ hasText: /^SECURITY / })
    .click();
  assert.equal(await rows().count(), 1);
  assert.equal(await page.locator(".rk-log-timeline li").count(), 8);
  await page
    .locator("#logTypeFilters button")
    .filter({ hasText: /^ALL / })
    .click();
  payload.events.push(event(9, now + 1, id1, "LIVE_FAIL", "FAIL"));
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () => document.querySelector(".rk-log-count")?.textContent === "10",
  );
  assert.equal(await rows().count(), 1);
  assert.equal(await rows().getAttribute("data-expanded"), "true");
  payload.events.push(event(10, now + 2, id2, "SECOND_APPEARANCE", "PENDING"));
  payload.events.push({
    id: 11,
    mint: null,
    at: now + 3,
    payload: {
      mode: "paper",
      type: "SYSTEM_WARNING",
      reason: "provider delayed",
    },
  });
  const scroller = page.locator(".insights-log-table-wrap");
  await scroller.evaluate((e) => {
    e.scrollTop = 220;
  });
  const readingEvent = await page
    .locator(".rk-log-timeline li")
    .evaluateAll((rs) => {
      const visible = rs.find((r) => {
        const b = r.getBoundingClientRect(),
          p = r.closest(".insights-log-table-wrap")!.getBoundingClientRect();
        return b.top >= p.top && b.top < p.bottom;
      });
      return visible
        ? {
            key: (visible as HTMLElement).dataset.eventKey,
            top: visible.getBoundingClientRect().top,
          }
        : null;
    });
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () => document.querySelectorAll(".rk-log-parent").length === 3,
  );
  assert.equal(
    await page
      .locator('.rk-log-parent[data-attempt-id="' + id1 + '"]')
      .getAttribute("data-expanded"),
    "true",
  );
  if (readingEvent) {
    const top = await page
      .locator(".rk-log-timeline li")
      .evaluateAll(
        (rs, key) =>
          rs
            .find((r) => (r as HTMLElement).dataset.eventKey === key)
            ?.getBoundingClientRect().top,
        readingEvent.key,
      );
    assert.ok(
      top !== undefined && Math.abs(top - readingEvent.top) < 2,
      "Reading anchor stays in place as parent order changes",
    );
  }
  assert.equal(
    (await page.getByText("System", { exact: true }).count()) > 0,
    true,
  );
  // Parent grouping runs before paging: 45 new attempts plus the same-mint pair/system.
  for (let i = 0; i < 45; i++)
    payload.events.push(
      event(20 + i, now + 20 + i, "page-attempt-" + i, "fixture-" + i),
    );
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () => document.querySelectorAll(".rk-log-parent").length === 40,
  );
  assert.match(await page.locator("#logPage").innerText(), /1–40 \/ 48 nhóm/);
  const firstKeys = await rows().evaluateAll((rs) =>
    rs.map((r) => (r as HTMLElement).dataset.logKey),
  );
  await page.locator("#logNext").click();
  assert.equal(await rows().count(), 8);
  const secondKeys = await rows().evaluateAll((rs) =>
    rs.map((r) => (r as HTMLElement).dataset.logKey),
  );
  assert.equal(
    firstKeys.some((k) => secondKeys.includes(k)),
    false,
  );
  await page.locator("#logSearch").fill("HEDGE");
  assert.match(await page.locator("#logPage").innerText(), /47 nhóm/);
  await page.locator("#logSearch").fill("SECOND_APPEARANCE");
  assert.equal(await rows().count(), 1);
  await page.locator("#logPause").click();
  payload.events.push(event(100, now + 200, id2, "PAUSE_TEST"));
  await page.clock.runFor(5100);
  await page.waitForTimeout(100);
  assert.equal(await rows().locator(".rk-log-count").innerText(), "1");
  assert.match(
    await page.locator("#logStreamStatus").innerText(),
    /bot vẫn chạy/,
  );
  await page.locator("#logPause").click();
  assert.equal(await rows().locator(".rk-log-count").innerText(), "2");
  payload.tokens.push({
    mint: "xss-mint",
    symbol: '<img src=x onerror="alert(1)">',
  });
  payload.events.push({
    id: 101,
    mint: "xss-mint",
    at: now + 210,
    payload: {
      mode: "paper",
      attemptId: "xss-attempt",
      stage: "SECURITY",
      status: "FAIL",
      reason: "<script>alert(1)</script>",
    },
  });
  await page.locator("#logSearch").fill("<img");
  await page.clock.runFor(5100);
  await page.waitForFunction(
    () => document.querySelectorAll(".rk-log-parent").length === 1,
  );
  assert.equal(
    await rows().locator("img,script").count(),
    0,
    "Untrusted names are text",
  );
  // Concurrent detail GETs use independent request keys; route exit still cancels them.
  await page.locator("#logSearch").fill("page-attempt-");
  held = true;
  await rows().nth(0).locator(".rk-log-expand").click();
  await rows().nth(1).locator(".rk-log-expand").click();
  await page.waitForTimeout(100);
  assert.equal(
    releases.length,
    2,
    "Both detail requests are alive independently",
  );
  await page.locator('a[data-route][href="/positions"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-route="/positions"][data-state="ready"]',
  );
  held = false;
  for (const release of releases) release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".rk-log-timeline").count(), 0);
  const before = calls.filter((p) => p === "/api/logs").length;
  await page.clock.runFor(16000);
  await page.waitForTimeout(100);
  assert.equal(
    calls.filter((p) => p === "/api/logs").length,
    before,
    "No Logs polling after leaving",
  );
  // Reference Overview with real-shaped fixture facts and actual source renderer.
  app.engine.store.savePosition({
    ...position(),
    mode: "paper",
    symbol: "HEDGE",
  });
  await page.locator('a[data-route][href="/"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-route="/"][data-state="ready"]',
  );
  const overview = {
    attempt: {
      attemptId: "overview-fixture",
      mint,
      symbol: "HEDGE",
      source: "GMGN_TRENDING",
      startedAt: now - 12000,
      result: "REJECTED",
      stage: "COMMON_RISK",
      stages: Object.fromEntries(
        ATTEMPT_STAGES.map((s) => [
          s,
          [
            "CHEAP_FILTER",
            "SECURITY",
            "COMPATIBILITY",
            "HISTORY",
            "CAPITAL_FLOW",
          ].includes(s)
            ? "PASS"
            : s === "COMMON_RISK"
              ? "FAIL"
              : "PENDING",
        ]),
      ),
      logs: [
        {
          at: now - 10000,
          stage: "CHEAP_FILTER",
          status: "CHECKING",
          message: "Bắt đầu Fresh Attempt",
        },
        {
          at: now - 9000,
          stage: "SECURITY",
          status: "PASS",
          message: "Security đã xác nhận",
        },
        {
          at: now - 8000,
          stage: "COMMON_RISK",
          status: "FAIL",
          message: "Liquidity is below the configured entry policy",
        },
      ],
      summaries: {
        token: {
          mint,
          symbol: "HEDGE",
          name: "Hedge",
          createdAt: now - 5 * 3600000,
          listing: {
            price: 0.000085,
            liquidity: 61400,
            market_cap: 85000,
            volume: 1800000,
            holder_count: 1711,
          },
        },
        history: {
          candles: Array.from({ length: 30 }, (_, i) => ({
            close: 0.000085 - i * 0.0000001,
          })),
        },
        strategies: {
          STANDARD: { decision: "REJECT", execution: "BLOCKED", stages: {} },
          KRONOS: { decision: "REJECT", execution: "BLOCKED", stages: {} },
        },
      },
    },
    queue: ["FOMO", "Robinhood", "TYGR", "COMETAIL", "ANSEM", "retire"].map(
      (symbol, i) => ({ mint: "queue-" + i, symbol }),
    ),
    positions: app.engine.store.positions("paper"),
    positionTotal: 1,
    market: [],
    scanner: { running: true, scanning: false },
  };
  await page.evaluate((o) => (window as any).BOTOverview.update(o), overview);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1080 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Overview viewport " + width,
    );
    if (width === 1440) {
      const cards = await page
        .locator(".current-token,.strategy-card,.action-log")
        .evaluateAll((rs) =>
          rs.map((r) => {
            const b = r.getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          }),
        );
      assert.equal(cards.length, 4);
      const first = cards[0];
      assert.ok(first);
      assert.ok(cards.every((r) => Math.abs(r.w - first.w) < 2));
      assert.ok(cards.every((r) => Math.abs(r.y - first.y) < 2));
      assert.ok(cards.every((r) => Math.abs(r.h - first.h) < 2));
      assert.equal(
        await page.locator(".token-scanner h2").innerText(),
        "Tokens đang quét",
      );
      const preview = await page.locator(".overview-positions").boundingBox();
      assert.ok(
        preview && preview.y < 900,
        "Position preview visible within 1080p",
      );
    }
  }
  // Global palette and overflow across every main page; no changes to Statistics layout.
  for (const route of [
    "/",
    "/positions",
    "/history",
    "/memory",
    "/settings",
    "/logs",
    "/thongke",
  ]) {
    if (route !== "/") {
      await page.locator('a[data-route][href="' + route + '"]').click();
      await page.waitForSelector(
        '#routeOutlet[data-route="' + route + '"][data-state="ready"]',
      );
    }
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        route + " overflow at " + width,
      );
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
        "rgb(247, 240, 222)",
      );
      assert.equal(
        await page
          .locator(".brandmark")
          .evaluate((e) => getComputedStyle(e).backgroundColor),
        "rgb(181, 42, 39)",
      );
    }
  }
  assert.deepEqual(errors, []);
  assert.ok(methods.every((m) => m === "GET"));
  assert.equal(g.calls.length, 0);
  assert.equal(app.engine.store.executions().length, 0);
  console.log(
    "PASS: grouped timeline, attempt isolation, lazy detail, child search/filter, group pagination, display-only pause, route cleanup, global palette, responsive seven routes, equal Overview cards, no POST or real trading.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("rug-killer-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
