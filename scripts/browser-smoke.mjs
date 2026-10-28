import { chromium, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const base =
  process.env.BROWSER_BASE_URL ?? process.argv[2] ?? "http://127.0.0.1:3000";
const snapshot = await fetch(base + "/api/snapshot").then((r) => r.json());
const settings = await fetch(base + "/api/settings").then((r) => r.json());
if (
  snapshot.source !== "RPC" ||
  !snapshot.observation?.enabled ||
  snapshot.liveEnabled ||
  snapshot.observation.budgetUsd !== "5"
)
  throw new Error("QA_REQUIRES_REAL_OBSERVATION_ONLY");
if (
  snapshot.candidates.some(
    (c) => c.event.source !== "RPC" || c.event.tokenAddress.startsWith("mock:"),
  )
)
  throw new Error("NON_REAL_CANDIDATE");
if (snapshot.executions.length)
  throw new Error("OBSERVATION_MUST_NOT_CREATE_EXECUTIONS");
const secrets = readFileSync(".env", "utf8")
  .split(/\r?\n/)
  .flatMap((line) => {
    const match =
      /^\s*([A-Z_]*(?:KEY|TOKEN|SECRET|MNEMONIC|SEED)[A-Z_]*)\s*=\s*(.*?)\s*$/.exec(
        line,
      );
    const value = match?.[2]?.replace(/^['"]|['"]$/g, "");
    return value && value.length > 8 && !/YOUR_|CHANGEME/.test(value)
      ? [value]
      : [];
  });
function checkPublic(payload) {
  const serialized = JSON.stringify(payload);
  if (secrets.some((secret) => serialized.includes(secret)))
    throw new Error("SECRET_VALUE_IN_BROWSER_PAYLOAD");
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(private_?key|mnemonic|seed|api_?key|authorization|wallet_?secret|secret_?key)$/i.test(
          key,
        ) &&
        child
      )
        throw new Error("FORBIDDEN_SECRET_FIELD_IN_BROWSER_PAYLOAD");
      inspect(child);
    }
  };
  inspect(payload);
}
checkPublic(snapshot);
checkPublic(settings);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
const inspections = [];
await page.addInitScript(() => {
  window.__qaEvents = [];
  const OriginalEventSource = window.EventSource;
  window.EventSource = class extends OriginalEventSource {
    constructor(...args) {
      super(...args);
      this.addEventListener("update", (event) => {
        try {
          window.__qaEvents = [
            JSON.parse(event.data),
            ...window.__qaEvents,
          ].slice(0, 24);
        } catch {
          /* Không lưu event không phải JSON. */
        }
      });
    }
  };
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (
    response.url().includes("/api/") &&
    !response.url().includes("/api/events")
  )
    inspections.push(
      response
        .json()
        .then(checkPublic)
        .catch((error) => {
          if (!/Unexpected|JSON|closed/.test(error.message))
            errors.push(error.message);
        }),
    );
});
try {
  await page.goto(base);
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(244, 236, 216)",
  );
  await expect(page.locator(".mode-pill")).toHaveText("PAPER · MÔ PHỎNG");
  await expect(page.locator(".terminal-metric")).toHaveCount(4);
  await expect(page.locator(".source-funnel")).toHaveCount(0);
  await expect(page.locator(".compact-positions")).toHaveCount(0);
  await expect(page.locator(".controls")).toHaveCount(0);
  await expect(page.locator(".chain-select")).toHaveCount(0);
  await expect(page.locator("#strategy, #mode")).toHaveCount(0);
  await expect(page.locator(".terminal-system")).not.toHaveAttribute(
    "open",
    "",
  );
  await page.locator(".terminal-system > summary").click();
  await expect(page.locator(".system-chains")).toBeVisible();
  await page.locator(".terminal-system > summary").click();
  await expect(page.locator(".system-chains")).not.toBeVisible();
  await expect(page.locator(".scanner-panel .scanner-button")).toHaveCount(1);
  await expect(page.locator(".terminal-log")).toHaveCSS(
    "background-color",
    "rgb(244, 236, 216)",
  );
  await expect(page.locator(".terminal-metric").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );
  await expect(page.locator(".terminal-metric").first()).toHaveCSS(
    "border-radius",
    "17px",
  );
  await expect(page.locator(".terminal-overview")).toContainText(
    "5 USD / tín hiệu mô phỏng",
  );
  await expect(page.locator(".chart-empty")).toContainText(
    "Chưa có lịch sử P&L đã xác minh",
  );
  await expect(page.locator(".chart-plot")).toHaveCount(0);
  await expect(page.locator(".system-chain")).toHaveCount(
    snapshot.chains.length,
  );
  await expect(page.locator(".header-right")).toContainText(
    "Đã kết nối luồng dữ liệu",
  );
  expect(await page.locator(".terminal-event").count()).toBeLessThanOrEqual(50);
  await expect(
    page.locator(".scanner-panel .scanner-table tbody tr"),
  ).toHaveCount(snapshot.candidates.length);
  if (snapshot.candidates.length > 20) {
    const scroll = page.locator(".scanner-panel .table-scroll");
    const overflow = await scroll.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    expect(overflow).toBe(true);
    await scroll.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  if (await page.locator(".terminal-event").count()) {
    await expect(page.locator(".terminal-event").first()).toHaveCSS(
      "border-bottom-width",
      "0px",
    );
    await expect(page.locator(".event-tag").first()).not.toHaveCSS(
      "box-shadow",
      "none",
    );
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  for (const [width, height] of [
    [1920, 1080],
    [1440, 900],
    [1366, 768],
    [820, 1180],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: `data/dashboard-${width}.png`,
      fullPage: true,
    });
    if (width === 1920) {
      const scanner = await page.locator(".scanner-panel").boundingBox();
      const chart = await page.locator(".terminal-performance").boundingBox();
      expect(chart.y + chart.height).toBeLessThan(800);
      expect(scanner.y).toBeLessThan(1080);
      expect(scanner.height).toBeLessThan(540);
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator(".entry-control").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Hủy", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  if (await page.locator(".scanner-table tbody tr").count()) {
    await page.locator(".scanner-table tbody tr").first().click();
    await expect(
      page.getByRole("dialog", { name: "Phân tích token" }),
    ).toBeVisible();
    await expect(page.locator(".final-risk")).toBeVisible();
    await expect(page.locator(".jev-summary")).toBeVisible();
    const unknown = page.locator(".rug-summary .rug-state.UNKNOWN");
    if (await unknown.count())
      await expect(unknown.first()).toHaveCSS("color", "rgb(115, 105, 87)");
    await page.keyboard.press("Escape");
  }
  const nav = page.getByRole("navigation");
  for (const width of [1920, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    await nav.getByRole("button", { name: /Vị thế/ }).click();
    await expect(page.locator(".observation-positions")).toBeVisible();
    await expect(page.locator(".terminal-overview")).toHaveCount(0);
    await expect(page.locator(".controls")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await nav
      .getByRole("button", { name: "Lịch sử quyết định", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /Các quyết định đã lưu/ }),
    ).toBeVisible();
    if (snapshot.discovery) {
      await expect(page.locator(".source-funnel")).toHaveCount(1);
      await page.locator(".source-funnel > summary").click();
      await expect(page.locator(".source-funnel tbody tr")).toHaveCount(4);
      for (const source of ["PUMP", "PUMPSWAP", "RAYDIUM", "METEORA"])
        await expect(
          page
            .locator(".source-funnel")
            .getByRole("rowheader", { name: source, exact: true }),
        ).toBeVisible();
      await page.locator(".source-funnel > summary").click();
    }
    const evmSourceCount = Object.keys(
      snapshot.discovery?.evmSources ?? {},
    ).length;
    if (evmSourceCount) {
      await expect(page.locator(".evm-discovery")).toHaveCount(1);
      await page.locator(".evm-discovery > summary").click();
      await expect(page.locator(".evm-discovery tbody tr")).toHaveCount(
        evmSourceCount,
      );
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.locator(".evm-discovery > summary").click();
    }
    expect(await page.locator(".history-details details[open]").count()).toBe(
      0,
    );
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await nav.getByRole("button", { name: "Cài đặt", exact: true }).click();
    await expect(page.locator(".settings-panel")).toBeVisible();
    await expect(page.locator(".mode-explanation")).toContainText(
      "10% số dư khả dụng",
    );
    await expect(page.locator(".readiness-panel")).not.toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page
      .getByText("Kết nối, ví và điều kiện chạy thật", { exact: true })
      .click();
    await expect(page.locator(".readiness-panel")).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await nav.getByRole("button", { name: "Tổng quan", exact: true }).click();
  }
  const denied = await page.request.post(base + "/api/position-close", {
    data: { positionId: "qa-nonexistent", confirm: true },
  });
  expect(denied.status()).toBe(503);
  // Những trạng thái chưa có trong runtime chỉ kiểm tra ở trang cô lập.
  // Mọi /api/* đều bị intercept; không request mutation đến server, không ghi DB.
  const probe = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  probe.on("pageerror", (error) => errors.push(error.message));
  const fixture = structuredClone(snapshot);
  delete fixture.observation;
  fixture.running = true;
  fixture.activeChain = "bnb";
  fixture.killSwitch = { active: false, reasons: [] };
  fixture.tradingWallet = {
    evm: {
      address: "0x0000000000000000000000000000000000000001",
      signerStatus: "WATCH_ONLY",
    },
    solana: { signerStatus: "NOT_CONFIGURED" },
  };
  fixture.analytics = {
    ...fixture.analytics,
    scope: { cachedCandidates: 1, closedTrades: 2, unknownNetResults: 0 },
    winRate: 50,
    realizedEquity: [
      { at: Date.now() - 20000, pnlUsd: 12.5 },
      { at: Date.now() - 10000, pnlUsd: 9.25 },
    ],
  };
  const makePosition = (id, pnl) => ({
    id,
    walletId: "qa-only",
    chainId: "bnb",
    tokenAddress: `0x${id.padEnd(40, "0")}`,
    quoteTokenAddress: "QA_ONLY",
    decimals: 18,
    quoteDecimals: 18,
    providerId: "QA_UI_ONLY",
    mode: "PAPER",
    state: "OPEN",
    initialQuantity: "100",
    remainingQuantity: "100",
    investedQuoteAmount: "1000",
    remainingCostQuoteAmount: "1000",
    realizedQuotePnl: "0",
    exitTransactionIds: [],
    openedAt: Date.now(),
    updatedAt: Date.now(),
    takenLevels: [],
    executablePnlUsd: pnl,
    exitPolicy: {
      stopLossPct: settings.stopLossPct,
      trailingStopPct: settings.trailingStopPct,
      maxHoldingSec: settings.maxHoldingSec,
      takeProfit: settings.takeProfit,
    },
  });
  fixture.managedPositions = [
    makePosition("1", 12.5),
    makePosition("2", -3.25),
  ];
  fixture.health.ai = {
    status: "unhealthy",
    detail: "QA UI: Jev unavailable",
    checkedAt: Date.now(),
  };
  fixture.chains[0].health = {
    status: "unhealthy",
    detail: "QA UI: RPC degraded",
    checkedAt: Date.now(),
  };
  const evidence = {
    value: null,
    state: "UNKNOWN",
    source: "QA_UI_ONLY",
    origin: "UNKNOWN",
    observedAt: new Date().toISOString(),
    reasonCodes: [],
  };
  const candidate = {
    id: "qa-only",
    event: {
      chainId: "bnb",
      tokenAddress: "QA_UI_ONLY",
      dexId: "QA_UI_ONLY",
      source: "RPC",
    },
    action: "REJECT",
    reasons: ["SELLABILITY_UNKNOWN"],
    risk: { passed: false, reasons: ["SELLABILITY_UNKNOWN"] },
    createdAt: Date.now(),
    rugCheck: {
      id: "qa-only",
      snapshotHash: "a".repeat(64),
      contract: {},
      trading: { sellability: evidence },
      liquidity: {},
      holders: {},
      creator: {},
      holderClusters: [],
      externalProviders: [],
      disagreements: [],
      reasonCodes: [],
      dataQuality: {
        completeness: 0,
        unknownFields: ["trading.sellability"],
        sources: [],
        collectedAt: new Date().toISOString(),
      },
      latencies: {},
    },
  };
  fixture.candidates = [candidate];
  const calls = [];
  await probe.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": QA UI isolated\n\n",
      });
    if (request.method() !== "GET") {
      const body = request.postDataJSON();
      calls.push({ path, body });
      if (path === "/api/control") {
        if (body.action === "pause") fixture.running = false;
        if (body.action === "start") fixture.running = true;
        if (body.action === "kill")
          fixture.killSwitch = { active: true, reasons: ["MANUAL_KILL"] };
        if (body.action === "reset")
          fixture.killSwitch = { active: false, reasons: [] };
      }
      if (path === "/api/settings" && body.activeChain)
        fixture.activeChain = body.activeChain;
      if (path === "/api/position-close")
        fixture.managedPositions = fixture.managedPositions.filter(
          (position) => position.id !== body.positionId,
        );
    }
    const payload =
      path === "/api/snapshot"
        ? fixture
        : path === "/api/history"
          ? { records: fixture.candidates, total: 1 }
          : path === "/api/wallet-balance"
            ? {
                walletId: "qa-only",
                chainId: fixture.activeChain,
                nativeAmount: "1250000000000000000",
                nativeDecimals: 18,
                tokens: [],
                observedAt: Date.now(),
                quality: "REAL",
              }
            : settings;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
  try {
    await probe.goto(base);
    await expect(probe.locator(".compact-positions")).toHaveCount(0);
    await expect(probe.locator(".win-rate-card .metric-value")).toHaveText(
      "50,0%",
    );
    await expect(probe.locator(".terminal-metric").nth(1)).toContainText(
      "9,25",
    );
    await expect(probe.locator(".chart-plot polyline")).toHaveCount(1);
    await probe.locator(".chart-plot svg").hover();
    await expect(probe.locator(".chart-readout")).not.toHaveText(/Tối đa/);
    await probe.getByRole("button", { name: "Đọc RPC ↗", exact: true }).click();
    await expect(probe.locator(".terminal-metric").first()).toContainText(
      "1,25000 BNB",
    );
    await probe
      .getByRole("navigation")
      .getByRole("button", { name: /Vị thế/ })
      .click();
    await probe
      .locator(".table-panel tbody tr")
      .first()
      .getByRole("button")
      .first()
      .click();
    await expect(
      probe.getByRole("dialog", { name: "Chi tiết vị thế" }),
    ).toBeVisible();
    await probe.getByRole("button", { name: "Yêu cầu đóng vị thế…" }).click();
    await expect(
      probe.getByRole("heading", { name: "Xác nhận đóng vị thế" }),
    ).toBeVisible();
    expect(calls.some((call) => call.path === "/api/position-close")).toBe(
      false,
    );
    await probe
      .getByRole("button", { name: "Xác nhận đóng trên giấy" })
      .click();
    expect(
      calls.find((call) => call.path === "/api/position-close").body,
    ).toEqual({ positionId: "1", confirm: true });
    await probe
      .getByRole("navigation")
      .getByRole("button", { name: "Tổng quan", exact: true })
      .click();
    await probe.locator(".entry-control").click();
    await probe.getByRole("button", { name: "Xác nhận", exact: true }).click();
    await expect(probe.locator(".entry-control")).toHaveText(
      "ĐANG CHẶN LỆNH MỚI",
    );
    await probe.locator(".entry-control").click();
    await probe.getByRole("button", { name: "Xác nhận", exact: true }).click();
    await expect(probe.locator(".entry-control")).toHaveText("Dừng lệnh mới…");
    await probe.getByRole("button", { name: "Ⅱ Tạm dừng quét" }).click();
    await expect(probe.locator(".bot-state")).toContainText("ĐÃ DỪNG");
    await probe.getByRole("button", { name: "▷ Bắt đầu quét" }).click();
    await expect(probe.locator(".bot-state")).toContainText("ĐANG QUÉT");
    await expect(probe.locator(".chain-select")).toHaveCount(0);
    await expect(probe.locator(".header-chain")).toHaveText("BNB");
    await probe.locator(".scanner-table tbody tr").click();
    await expect(probe.locator(".final-risk")).toContainText("TỪ CHỐI");
    await expect(probe.locator(".jev-summary")).toContainText(
      "Chưa có kết quả Jev hợp lệ",
    );
    await expect(
      probe.locator(".rug-summary .rug-state.UNKNOWN").first(),
    ).toHaveCSS("color", "rgb(115, 105, 87)");
    await probe.keyboard.press("Escape");
    await probe
      .getByRole("navigation")
      .getByRole("button", { name: "Cài đặt", exact: true })
      .click();
    await probe
      .getByRole("button", { name: "Lưu cài đặt", exact: true })
      .click();
    await expect(probe.getByRole("status")).toContainText(
      "Bot đã kiểm tra và lưu cài đặt.",
    );
    expect(
      calls.some(
        (call) =>
          call.path === "/api/settings" &&
          call.body.stopLossPct === settings.stopLossPct,
      ),
    ).toBe(true);
    fixture.analytics.scope.unknownNetResults = 1;
    fixture.analytics.realizedEquity.splice(1, 0, {
      at: Date.now() - 15000,
      pnlUsd: null,
    });
    fixture.mode = "LIVE";
    await probe.reload();
    await expect(probe.locator(".mode-live")).toHaveText("LIVE · TIỀN THẬT");
    await expect(probe.locator("#mode")).toHaveCount(0);
    await expect(
      probe.locator(".terminal-metric").nth(1).locator(".metric-value"),
    ).toHaveText("—");
    await expect(probe.locator(".chart-plot polyline")).toHaveCount(0);
    await expect(probe.locator(".chart-plot circle")).toHaveCount(2);
    await probe.route("**/api/snapshot", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "QA_UI_BOT_UNAVAILABLE" }),
      }),
    );
    await probe.reload();
    await expect(probe.locator(".error[role=alert]")).toContainText(
      "QA_UI_BOT_UNAVAILABLE",
    );
    await expect(probe.locator(".loading-state")).toBeVisible();
    await expect(probe.locator(".terminal-metric")).toHaveCount(0);
  } finally {
    await probe.close();
  }
  const toastPage = await browser.newPage();
  await toastPage.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ["buy", "sell"]
        .map(
          (side) =>
            `event: update\ndata: ${JSON.stringify({ id: `qa-toast-${side}`, type: `observation_${side}`, data: { symbol: "KIỂM THỬ GIAO DIỆN", execution: "SIMULATED" } })}\n\n`,
        )
        .join(""),
    }),
  );
  try {
    await toastPage.goto(base);
    await expect(toastPage.locator(".observation-toasts")).toContainText(
      "Đã mua mô phỏng · 5 USD",
    );
    await expect(toastPage.locator(".observation-toasts")).toContainText(
      "Đã bán mô phỏng",
    );
  } finally {
    await toastPage.close();
  }
  const latest = await fetch(base + "/api/snapshot").then((response) =>
    response.json(),
  );
  expect(latest.executions).toHaveLength(0);
  expect(latest.liveEnabled).toBe(false);
  expect(latest.observation.budgetUsd).toBe("5");
  await Promise.all(inspections);
  checkPublic(await page.evaluate(() => window.__qaEvents));
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Chrome đạt: giao diện kem giấy Papertrade/olive; 1920/1440/1366/820/390; 4 menu; dữ liệu RPC/SSE; không lộ secrets; trạng thái thiếu/UNKNOWN; kiểm tra điều khiển và P&L trong trang cô lập. Không ghi fixture vào DB hoặc phát giao dịch.",
  );
} finally {
  await browser.close();
}
