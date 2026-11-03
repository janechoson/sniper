import assert from "node:assert/strict";
export async function runTrendingUiCases(browser, base) {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await page.waitForFunction(
      () => typeof statusData !== "undefined" && statusData.mode === "paper",
    );
    await page.evaluate(() => stream.close());
    const original = await (await fetch(base + "/api/status")).json();
    const d = {
      sources: ["TRENDING", "SNIPER"],
      firstSeenAt: Date.now() - 180000,
      lastSeenAt: Date.now(),
      trending: {
        rank: 7,
        lastSeenAt: Date.now(),
        history: [
          { rank: 30, at: Date.now() - 120000 },
          { rank: 18, at: Date.now() - 60000 },
          { rank: 7, at: Date.now() },
        ],
      },
    };
    const t = {
        mint: "ui-trending",
        symbol: "TREND",
        state: "QUEUED",
        score: 100,
        lastChecked: Date.now(),
        discovery: d,
      },
      s = {
        ...t,
        mint: "ui-sniper",
        symbol: "EARLY",
        score: 90,
        discovery: { sources: ["SNIPER"] },
      };
    const snapshot = {
      ...original,
      discovery: {
        feeds: {
          TRENDING: { state: "READY", count: 100 },
          SNIPER: { state: "DEGRADED", count: 0 },
        },
      },
      flow: {
        ...original.flow,
        scannerRunning: true,
        counts: { ...original.flow.counts, queue: 2 },
        scanner: [t, s],
        queue: [t, s],
        watch: [],
        deferred: [],
        events: [],
      },
    };
    await page.evaluate((v) => render(v), snapshot);
    assert.match(
      await page.locator("#trendingSource").textContent(),
      /100 token.*SẴN SÀNG/,
    );
    assert.match(
      await page.locator("#sniperSource").textContent(),
      /NGUỒN GIÁN ĐOẠN/,
    );
    assert.match(
      await page.locator("#queueTank").textContent(),
      /XU HƯỚNG.*SĂN SỚM/,
    );
    const report = {
      purpose: "POSITION",
      mint: "ui",
      quantity: "1000000",
      checkedAt: Date.now(),
      validUntil: Date.now() + 600000,
      status: "LIMITED",
      levels: [
        {
          sellBps: 2000,
          status: "HEALTHY",
          economicallyMeaningful: true,
          minimumSolOut: "300000",
          netMinimumLamports: "190000",
        },
        {
          sellBps: 5000,
          status: "HEALTHY",
          economicallyMeaningful: true,
          minimumSolOut: "750000",
          netMinimumLamports: "640000",
        },
        {
          sellBps: 10000,
          status: "THIN",
          economicallyMeaningful: false,
          minimumSolOut: "823",
          netMinimumLamports: "-109177",
        },
      ],
    };
    await page.evaluate(
      ({ d, report }) => {
        document.querySelector('[data-view="positions"]').click();
        renderPositions(
          [
            {
              id: "trending-card",
              mint: "ui",
              symbol: "TREND",
              mode: "paper",
              state: "OPEN",
              quantity: "1000000",
              originalQuantity: "1000000",
              decimals: 6,
              costLamports: "1000000",
              remainingCostLamports: "1000000",
              realizedLamports: "0",
              lastValueLamports: "1100000",
              lastQuoteAt: Date.now(),
              entryAt: Date.now() - 60000,
              discovery: d,
              exitLiquidity: report,
            },
          ],
          [],
        );
      },
      { d, report },
    );
    assert.equal(
      await page.locator(".exit-levels [data-exit-level]").count(),
      3,
    );
    assert.match(
      await page.locator('[data-exit-level="2000"]').textContent(),
      /ĐỦ BIÊN PHÍ/,
    );
    assert.match(
      await page.locator('[data-exit-level="10000"]').textContent(),
      /MỎNG/,
    );
    assert.match(
      await page.locator(".exit-liquidity-panel").textContent(),
      /Định giá GMGN.*không phải SOL bảo đảm/,
    );
    await page.evaluate(() => {
      const now = Date.now;
      try {
        Date.now = () => now() + 700000;
        window.BOTPositions.tick();
      } finally {
        Date.now = now;
      }
    });
    assert.equal(await page.locator(".exit-estimate-stale").count(), 1);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `overflow ${width}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({
      path: "data/trending-exit-ui-isolated.png",
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: two discovery sources, source health, backend queue badges/rank history, 20/50/100 exit estimates, market vs exit value, stale timer and responsive layout.",
    );
  } finally {
    await page.close();
  }
}
