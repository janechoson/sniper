import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  makeFillAccounting,
  tradeAccounting,
} from "../src/trade-accounting.ts";

// Browser-only fixture. Every request is intercepted; no server, DB or provider.
const now = Date.now(),
  mint = "AccountingFixtureMint";
function fill(id, side, quantity, principal, at) {
  const fee = 5000000n,
    amount = BigInt(principal);
  const delta = side === "BUY" ? -amount - fee : amount - fee;
  const e = {
    id,
    signature: id,
    state: "CONFIRMED",
    at,
    intent: {
      positionId: "fixture",
      mode: "paper",
      side,
      amount: String(principal),
    },
    evidence: {
      solDelta: String(delta),
      tokenDelta: String(quantity),
      feeLamports: String(fee),
    },
    fx: { price: "150", at, source: "BROWSER_FIXTURE_SOL_USD" },
  };
  e.accounting = makeFillAccounting(
    e,
    delta,
    BigInt(quantity),
    fee,
    0n,
    6,
    e.fx,
    at,
    "BLOCK_TIME",
  );
  return e;
}
const entry = fill(
  "fixture-entry",
  "BUY",
  1000000000,
  1000000000,
  now - 3600000,
);
const base = {
  id: "fixture",
  mint,
  symbol: "DEMO",
  mode: "paper",
  state: "OPEN",
  quantity: "1000000000",
  originalQuantity: "1000000000",
  decimals: 6,
  costLamports: "1005000000",
  remainingCostLamports: "1005000000",
  realizedLamports: "0",
  entryAt: entry.at,
  lastValueLamports: "1100000000",
  lastQuoteAt: now,
  mfePercent: 12,
  maePercent: -2,
  grossMfePercent: 12,
  grossMaePercent: -2,
  signature: entry.signature,
  takenProfits: [],
};
const open = { ...base, accounting: tradeAccounting(base, [entry]) };
const exits = [
  fill("partial-1", "SELL", -250000000, 300000000, now - 2400000),
  fill("partial-2", "SELL", -250000000, 350000000, now - 1200000),
  fill("final-exit", "SELL", -500000000, 550000000, now),
];
const closed = {
  ...base,
  state: "CLOSED",
  quantity: "0",
  lastValueLamports: "0",
  sellSignature: "final-exit",
};
closed.accounting = tradeAccounting(closed, [entry, ...exits]);
const unknown = {
  ...base,
  id: "legacy",
  symbol: "LEGACY",
  accounting: tradeAccounting({ ...base, id: "legacy" }, []),
};
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1550, height: 1050 },
  });
  const errors = [],
    unexpected = [];
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  await page.addInitScript(() => {
    window.EventSource = class {
      addEventListener() {}
      close() {}
    };
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname;
    if (url.hostname !== "accounting.test") {
      unexpected.push(url.href);
      return route.abort();
    }
    let body, contentType;
    if (path === "/") {
      body = readFileSync("public/index.html", "utf8");
      contentType = "text/html";
    } else if (
      [
        "/app.js",
        "/flow.js",
        "/style.css",
        "/kronos.js",
        "/token-avatar.js",
      ].includes(path)
    ) {
      body = readFileSync("public" + path, "utf8");
      if (path === "/app.js")
        body = body.replace(
          /^get\("\/api\/status"\)[\s\S]*?\.catch\(error\);/m,
          "",
        );
      contentType = path.endsWith(".css") ? "text/css" : "text/javascript";
    } else {
      unexpected.push(url.href);
      return route.fulfill({ status: 404, body: "" });
    }
    await route.fulfill({ body, contentType });
  });
  await page.goto("http://accounting.test/");
  await page.waitForFunction(() => !!window.BOTPositions);
  await page.evaluate(() => {
    statusData = {
      mode: "paper",
      settings: {
        takeProfits: [],
        trailingActivationBps: 5000,
        trailingStopBps: 2000,
      },
    };
  });
  await page.evaluate(
    ({ open, unknown }) => renderPositions([open, unknown], [], []),
    { open, unknown },
  );
  await page.locator('[data-view="positions"]').click();
  const card = page.locator('[data-position-id="fixture"]');
  assert.equal(
    await card.locator(".position-pnl-percent").textContent(),
    "+10.00%",
  );
  assert.match(await card.textContent(), /0\.005 SOL.*\$0\.75/);
  assert.match(await card.textContent(), /0\.095 SOL/);
  assert.match(await card.textContent(), /\$0\.15/); // actual effective entry, not signal
  assert.equal(
    await page
      .locator('[data-position-id="legacy"] .position-pnl-percent')
      .textContent(),
    "—",
  );
  mkdirSync("docs/previews", { recursive: true });
  await page.screenshot({
    path: "docs/previews/accounting-positions.png",
    fullPage: true,
  });
  await page.evaluate(
    ({ open }) =>
      renderPositions(
        [
          {
            ...open,
            lastAnalystAttempt: {
              action: "NO_DECISION",
              decisionState: "NO_DECISION_TIMEOUT",
              confidence: 0,
              sellBps: 0,
              reason: "PROVIDER_UNAVAILABLE",
              createdAt: Date.now(),
            },
            safetyState: {
              strategic: "NO_DECISION",
              protective: "BLOCKED",
              execution: "EXECUTION_BLOCKED_BY_UNKNOWN_TX",
              blocker: { signature: "fixture-signature" },
              protections: [{ retry: { classification: "NO_ROUTE" } }],
            },
          },
        ],
        [],
        [],
      ),
    { open },
  );
  assert.match(await card.textContent(), /CHƯA CÓ QUYẾT ĐỊNH/);
  assert.match(await card.textContent(), /Cần thoát nhưng chưa có route/);
  assert.match(await card.textContent(), /Thực thi bị khóa/);
  assert.doesNotMatch(await card.textContent(), /JEV · GIỮ/);
  await page.screenshot({
    path: "docs/previews/sell-safety-v2-states.png",
    fullPage: true,
  });
  const analystCases = [
    {
      decisionState: "NO_DECISION_PROVIDER_FAILURE",
      error: "JEV_EXIT_ACTION_FRACTION_MISMATCH",
      title: /Phản hồi JEV mâu thuẫn/,
      detail: /Hành động và tỷ lệ bán không khớp/,
    },
    ...[0.35, 0.42].map((score) => ({
      decisionState: "NO_DECISION_INSUFFICIENT_DATA",
      analystResponse: { answers: { data_sufficiency: { noul: score } } },
      title: /Chưa đủ điều kiện dữ liệu/,
      detail: new RegExp(
        `0,${Math.round(score * 100)}/1; ngưỡng yêu cầu: 0,70/1`,
      ),
    })),
    {
      decisionState: "NO_DECISION_INSUFFICIENT_DATA",
      analystResponse: { answers: { data_sufficiency: { noul: 0.9 } } },
      title: /Chưa đủ điều kiện dữ liệu/,
      detail: /Điểm đã đạt ngưỡng nhưng lý do và hành động chưa đáp ứng/,
    },
    ...[undefined, null, "0.35"].map((score) => ({
      decisionState: "NO_DECISION_INSUFFICIENT_DATA",
      analystResponse: { answers: { data_sufficiency: { noul: score } } },
      title: /Chưa đủ điều kiện dữ liệu/,
      detail: /JEV đánh giá chưa đủ bằng chứng/,
    })),
    {
      decisionState: "NO_DECISION_LOW_CONFIDENCE",
      title: /Độ tin cậy quyết định JEV chưa đạt ngưỡng/,
      detail: /khác với điểm đủ dữ liệu/,
    },
    {
      decisionState: "NO_DECISION_TIMEOUT",
      error: "JEV_EXIT_TIMEOUT",
      title: /JEV hết thời gian phản hồi/,
      detail: /quá thời gian chờ/,
    },
    ...["NO_DECISION_SCHEMA_FAILURE", "NO_DECISION_INVALID_RESPONSE"].map(
      (decisionState) => ({
        decisionState,
        title: /Phản hồi JEV sai định dạng/,
        detail: /Không đọc được phản hồi/,
      }),
    ),
    ...[401, 403, 429, 500].map((http) => ({
      decisionState: "NO_DECISION_PROVIDER_FAILURE",
      error: `JEV_EXIT_HTTP_${http}`,
      title:
        http === 401 || http === 403
          ? /JEV từ chối xác thực hoặc quyền truy cập/
          : http === 429
            ? /JEV giới hạn tần suất yêu cầu/
            : /Dịch vụ JEV trả lỗi/,
      detail: new RegExp(`HTTP ${http}`),
    })),
    {
      decisionState: "NO_DECISION_PROVIDER_FAILURE",
      error: "JEV_EXIT_UNAVAILABLE",
      title: /Lỗi gọi dịch vụ JEV/,
      detail: /Không có phản hồi hợp lệ/,
    },
  ];
  for (const { title, detail, ...attempt } of analystCases) {
    await page.evaluate(
      ({ open, attempt }) =>
        renderPositions(
          [
            {
              ...open,
              lastAnalystAttempt: {
                action: "NO_DECISION",
                confidence: 0,
                sellBps: 0,
                reason: "PROVIDER_UNAVAILABLE",
                createdAt: Date.now(),
                ...attempt,
              },
              safetyState: {
                strategic: "NO_DECISION",
                protective: "NONE",
                execution: "IDLE",
              },
            },
          ],
          [],
          [],
        ),
      { open, attempt },
    );
    const text = await card.locator(".position-jev").textContent();
    assert.match(text, title);
    assert.match(text, detail);
    assert.match(text, /Chưa cấp quyết định mới/);
    assert.match(text, /Chưa có tín hiệu thoát bảo vệ/);
    assert.doesNotMatch(
      text,
      /Jev tạm thời không khả dụng|JEV · GIỮ|NaN|undefined|null/,
    );
    if (attempt.analystResponse?.answers?.data_sufficiency?.noul === 0.35) {
      assert.match(text, /Không phải xác suất thắng/);
      await page.screenshot({
        path: "docs/previews/jev-insufficient-data-label.png",
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 1050 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "JEV status labels must fit mobile without horizontal overflow",
    );
    await page.setViewportSize({ width: 1550, height: 1050 });
  }
  console.log(
    `PASS: ${analystCases.length} JEV label cases; legacy mismatch, sufficiency, missing scores, timeout, schema, auth, rate limit and network.`,
  );
  await page.evaluate(({ closed }) => renderPositions([], [], [closed]), {
    closed,
  });
  await page.locator('[data-view="history"]').click();
  const history = page.locator(".history-record").first();
  await history.locator(":scope > summary").click();
  assert.equal(await history.locator(".history-executions > div").count(), 3);
  assert.match(await history.textContent(), /THOÁT CUỐI/);
  assert.match(await history.textContent(), /0\.02 SOL.*\$3/);
  assert.match(await history.textContent(), /0\.18 SOL/);
  assert.equal(await history.locator(".history-links a").count(), 4);
  assert.equal(
    await history.locator(".history-links a").last().getAttribute("href"),
    "https://solscan.io/tx/final-exit",
  );
  await page.screenshot({
    path: "docs/previews/accounting-history.png",
    fullPage: true,
  });
  for (const view of ["history", "positions", "overview"]) {
    await page.evaluate(({ open }) => renderPositions([open], [], []), {
      open,
    });
    if (view === "overview")
      await page.evaluate(
        ({ open }) =>
          window.BOTOverview.update(
            { positions: [open], scanner: { running: false } },
            statusData,
          ),
        { open },
      );
    if (view === "history")
      await page.evaluate(({ closed }) => renderHistory([closed], new Map()), {
        closed,
      });
    await page.locator(`[data-view="${view}"]`).click();
    for (const width of [1550, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${view} overflow at ${width}`,
      );
      const text = await page.locator(`#${view}`).innerText();
      assert.doesNotMatch(text, /\b(?:null|undefined|NaN)\b/);
    }
  }
  await page.locator('[data-view="history"]').click();
  await page.screenshot({
    path: "docs/previews/accounting-history-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  writeFileSync(
    "docs/accounting-ui-verification.json",
    JSON.stringify(
      {
        fixtureOnly: true,
        passed: true,
        widths: [1550, 1024, 768, 390],
        checks: [
          "gross fee net separate",
          "effective entry",
          "legacy unknown",
          "three exits and links",
          "no page overflow",
          "no null/undefined/NaN",
          "no network/server/DB",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: browser accounting, lifecycle, links, unknowns and desktop/mobile layouts.",
  );
} finally {
  await browser.close();
}
