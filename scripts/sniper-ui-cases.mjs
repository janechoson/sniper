import assert from "node:assert/strict";
export async function runSniperUiCases(browser, base) {
  const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(base);
    await page.waitForFunction(() => typeof statusData !== "undefined");
    await page.evaluate(() => stream.close());
    const original = await (await fetch(base + "/api/status")).json();
    const r = {
      mint: "watched-fixture",
      phase: "SUPPORT_FORMING",
      status: "ACTIVE",
      structureWatchStartedAt: Date.now() - 120000,
      structureWatchExpiresAt: Date.now() + 480000,
      lastObservedAt: Date.now() - 180000,
      entryDiscoverySource: "TRENDING",
      eligibleForEntryWatch: true,
      evidenceCurrent: true,
    };
    await page.evaluate(
      ({ s, r }) =>
        render({
          ...s,
          structureWatch: [r],
          gmgnRequests: {
            state: "RATE_LIMITED",
            cooldownRemainingMs: 12000,
            queueDepth: 18,
            cacheHit: 80,
            logicalReads: 100,
            singleFlightJoined: 12,
          },
        }),
      { s: original, r },
    );
    assert.match(
      await page.locator("#structureWatchList").innerText(),
      /Đang hình thành lực đỡ/i,
    );
    assert.match(
      await page.locator("#structureWatchList").innerText(),
      /watched-fixture/,
    );
    assert.match(
      await page.locator("#structureWatchList").innerText(),
      /ĐANG KHÓA/,
    );
    assert.match(
      await page.locator("#structureWatchList").innerText(),
      /10:00/,
    );
    assert.match(await page.locator("#structureWatchList").innerText(), /Cũ/i);
    assert.match(
      await page.locator("#providers").innerText(),
      /GIỚI HẠN TẦN SUẤT.*12\s*(s|giây)/,
    );
    const trending = await page.evaluate(
      (r) => window.BOTStructurePanel(r, "TRENDING").textContent,
      r,
    );
    assert.doesNotMatch(trending, /KHÔNG ÁP DỤNG/);
    assert.match(trending, /10:00/);
    assert.match(trending, /ĐANG KHÓA/);
    const temporary = await page.evaluate((r) => {
      const panel = window.BOTStructurePanel(
        {
          ...r,
          recoveryGateMode: "TEMP_RECOVERY_BYPASS",
          progress: {
            selling: "PENDING",
            absorption: "PENDING",
            support: "PENDING",
            recovery: "PENDING",
          },
        },
        "TRENDING",
      );
      return panel.textContent;
    }, r);
    assert.match(temporary, /TEMP RECOVERY BYPASS/);
    assert.doesNotMatch(temporary, /ĐỦ CẤU TRÚC|✓/);
    const distinct = await page.evaluate((r) => {
      const absorption = window.BOTStructurePanel(
        {
          ...r,
          phase: "ABSORPTION_DETECTED",
          absorptionDetected: true,
          absorptionCount: 2,
          supportConfirmed: false,
          supportCount: 0,
          sellingSeen: true,
          recoveryCount: 0,
        },
        "TRENDING",
      );
      const zeroBuy = window.BOTStructurePanel(
        {
          ...r,
          phase: "SELLING_APPEARED",
          absorptionDetected: false,
          supportConfirmed: false,
          sellingSeen: true,
          recoveryCount: 0,
        },
        "TRENDING",
      );
      return {
        absorption: absorption.textContent,
        zeroBuy: zeroBuy.textContent,
      };
    }, r);
    assert.match(distinct.absorption, /Hấp thụ ✓/);
    assert.doesNotMatch(distinct.absorption, /Hỗ trợ ✓|Phục hồi ✓/);
    assert.doesNotMatch(distinct.zeroBuy, /Hỗ trợ ✓|Phục hồi ✓/);
    const legacy = await page.evaluate(
      (r) =>
        window.BOTStructurePanel(
          {
            ...r,
            evidenceCurrent: false,
            status: "PASSED",
            phase: "ENTRY_ELIGIBLE",
            supportConfirmed: true,
            progress: {
              selling: "COMPLETE",
              absorption: "COMPLETE",
              support: "COMPLETE",
              recovery: "COMPLETE",
            },
          },
          "TRENDING",
        ).textContent,
      r,
    );
    assert.match(legacy, /Bằng chứng cũ/);
    assert.doesNotMatch(legacy, /ĐỦ CẤU TRÚC|✓/);
    await page.screenshot({ path: "data/v5-structure-ui.png", fullPage: true });
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 2,
        ),
        false,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Structure Watch phase/TTL/locked/stale, GMGN cooldown/queue/cache, Trending final gate, responsive; zero browser errors.",
    );
  } finally {
    await page.close();
  }
}
