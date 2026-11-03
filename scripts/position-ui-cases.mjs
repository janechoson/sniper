import assert from "node:assert/strict";

// Isolated browser fixtures only. All exit requests are intercepted before the paper server.
export async function runPositionUiCases(browser, base) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/exit", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { queued: true } });
  });
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("mode").textContent === "MÔ PHỎNG",
  );
  await page.evaluate(() => stream.close());
  await page.locator('[data-view="positions"]').click();
  const basePosition = {
    id: "card-0",
    mint: "HXRpzCQgnZdW2bgWrrEpZ3rpCK1m9ktF3P2e2PVfhE77",
    symbol: "IMAGINE",
    mode: "paper",
    state: "OPEN",
    quantity: "1250000",
    originalQuantity: "2500000",
    decimals: 6,
    costLamports: "2000000",
    remainingCostLamports: "1000000",
    realizedLamports: "200000",
    lastValueLamports: "1500000",
    entryAt: Date.now() - 3700000,
    lastQuoteAt: Date.now() - 60000,
    mfePercent: 42.8,
    maePercent: -31.4,
    signature: "fixture-buy-signature",
    takenProfits: [],
    jevExit: {
      action: "HOLD",
      confidence: 0.9,
      reason: "UNCHANGED",
      createdAt: Date.now(),
    },
  };
  const attention = {
    status: "NEEDS_ATTENTION",
    issue: {
      code: "TOKEN_SAFETY_FAILED",
      reasonCode: "SIMULATED_BALANCE_MISMATCH",
      stage: "PRE_SELL",
    },
    lastChecked: Date.now() - 60000,
    nextCheckAt: Date.now() + 600000,
    protectiveExit: "BACKOFF",
    failureCount: 3,
  };
  const draw = async (positions) => {
    // These legacy UI fixtures explicitly model fee-free economic amounts.
    // Production derives this projection from reconciled executions, never raw costs.
    positions = positions.map((p) => {
      const principal = BigInt(p.costLamports) > 0n ? p.costLamports : null;
      const unrealized =
        p.lastValueLamports === undefined
          ? null
          : (
              BigInt(p.lastValueLamports) - BigInt(p.remainingCostLamports)
            ).toString();
      const gross =
        p.state === "CLOSED"
          ? p.realizedLamports
          : unrealized === null
            ? null
            : (BigInt(p.realizedLamports) + BigInt(unrealized)).toString();
      return {
        ...p,
        accounting: {
          principalLamports: principal,
          remainingPrincipalLamports: principal
            ? p.remainingCostLamports
            : null,
          grossRealizedPnlLamports: p.realizedLamports,
          grossUnrealizedPnlLamports: unrealized,
          grossPnlLamports: gross,
          grossPnlPct:
            gross === null || !principal
              ? null
              : (Number(gross) / Number(principal)) * 100,
          feesPaidLamports: principal ? "0" : null,
          feesPaidUsd: principal ? "0" : null,
          feeCompleteness: "IDENTIFIED_DEBITS_RECONCILED",
          netPnlLamports: gross,
          exits: [],
        },
      };
    });
    // Isolated renderer fixture supplies the API's opening-time history order.
    const history = positions
      .filter((p) => p.state === "CLOSED" && BigInt(p.originalQuantity) > 0n)
      .sort(
        (a, b) =>
          b.entryAt - a.entryAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    return page.evaluate(
      ({ items, history }) => renderPositions(items, [], history),
      { items: positions, history },
    );
  };
  try {
    for (const count of [1, 3, 10, 20, 50]) {
      const positions = Array.from({ length: count }, (_, i) => ({
        ...basePosition,
        id: `card-${i}`,
        symbol: i ? `TOKEN${i}` : "IMAGINE",
        mint: basePosition.mint + i,
        ...(i === 0 ? { attention } : {}),
      }));
      await draw(positions);
      assert.ok(await page.getByText("JEV · GIỮ", { exact: true }).count());
      await page.waitForTimeout(280);
      await page.waitForFunction(
        (n) =>
          document.querySelectorAll(
            "#positionRows .position-card:not(.position-leaving)",
          ).length === n,
        count,
      );
      assert.equal(
        await page.locator("#positionActiveCount").textContent(),
        `${count} ĐANG GIỮ`,
      );
      assert.equal(
        await page
          .locator("#positionRows .position-card")
          .first()
          .getAttribute("data-position-id"),
        "card-0",
      );
      const widths = await page
        .locator(".position-card:not(.position-leaving)")
        .evaluateAll((cards) =>
          cards.map((c) => c.getBoundingClientRect().width),
        );
      assert.ok(widths.every((w) => w <= 651 && w >= 300));
      if (count > 1) {
        const tops = await page
          .locator(".position-card:not(.position-leaving)")
          .evaluateAll((cards) =>
            cards.slice(0, 2).map((c) => c.getBoundingClientRect().top),
          );
        assert.equal(tops[0], tops[1]);
      }
    }
    const issue = page.locator('[data-position-id="card-0"]');
    assert.match(await issue.textContent(), /Số dư mô phỏng không khớp/);
    assert.match(await issue.textContent(), /Thử lại sau/);
    assert.equal(
      await issue.locator(".position-pnl-percent").textContent(),
      "+35.00%",
    );
    assert.equal(
      await issue.locator(".position-pnl-sol").textContent(),
      "+0.0007 SOL",
    );
    assert.match(
      await issue.locator(".position-performance").textContent(),
      /Lãi cao nhất \(MFE\)\+42.80%Lỗ sâu nhất \(MAE\)-31.40%Chưa chốt\+0.0005 SOLĐã chốt\+0.0002 SOL/,
    );
    assert.equal(
      await issue.locator(".position-mint").getAttribute("title"),
      basePosition.mint + "0 · Nhấn để sao chép",
    );
    assert.equal(await issue.locator("a").first().textContent(), "GD MUA ↗");
    assert.equal(
      await issue.locator("details.position-details").getAttribute("open"),
      null,
    );
    await issue.locator("details.position-details > summary").click();
    await draw([
      { ...basePosition, mint: basePosition.mint + "0", attention },
      { ...basePosition, id: "other", symbol: "OTHER" },
    ]);
    assert.equal(
      await issue.locator("details.position-details").evaluate((d) => d.open),
      true,
    );
    // A normal SSE-like update leaves an unchanged card in place and preserves expanded details.
    await issue.evaluate((card) => {
      card.dataset.retained = "yes";
    });
    await draw([
      { ...basePosition, mint: basePosition.mint + "0", attention },
      { ...basePosition, id: "other", symbol: "OTHER" },
    ]);
    assert.equal(await issue.getAttribute("data-retained"), "yes");
    page.once("dialog", (d) => d.dismiss());
    await issue
      .getByRole("button", { name: "Bán khẩn cấp toàn bộ", exact: true })
      .click();
    assert.equal(requests.length, 0);
    page.once("dialog", (d) => d.accept());
    await issue
      .getByRole("button", { name: "Bán khẩn cấp toàn bộ", exact: true })
      .click();
    assert.deepEqual(requests, [{ positionId: "card-0", sellPercent: 100 }]);
    assert.equal(
      await issue.locator(".position-actions button:disabled").count(),
      2,
    );
    await draw([
      {
        ...basePosition,
        attention,
        state: "PENDING_EXIT",
        displayState: "EXIT_PENDING",
      },
      { ...basePosition, id: "unknown", displayState: "UNKNOWN" },
    ]);
    assert.equal(
      await page.locator(".position-actions button:enabled").count(),
      0,
    );
    await draw([
      {
        ...basePosition,
        id: "missing",
        lastValueLamports: undefined,
        mfePercent: undefined,
        maePercent: undefined,
      },
    ]);
    await page.waitForTimeout(200);
    assert.equal(
      await page.locator(".position-pnl-percent").textContent(),
      "—",
    );
    assert.match(
      await page.locator("#positionPortfolio").textContent(),
      /Giá trị hiện tại—/,
    );
    assert.match(
      await page.locator(".position-performance").textContent(),
      /Lãi cao nhất \(MFE\)—Lỗ sâu nhất \(MAE\)—/,
    );
    await draw([
      {
        ...basePosition,
        id: "unreconciled",
        state: "PENDING_ENTRY",
        displayState: "UNKNOWN",
        relevant: true,
        quantity: "0",
        originalQuantity: "0",
        costLamports: "0",
        remainingCostLamports: "0",
        lastValueLamports: undefined,
      },
    ]);
    await page.waitForTimeout(200);
    assert.match(
      await page.locator("#positionPortfolio").textContent(),
      /Vốn đã đầu tư—Giá trị hiện tại—/,
    );
    assert.match(
      await page.locator(".position-metric-grid").first().textContent(),
      /Vốn đã đầu tư—Giá trị hiện tại—Đang giữ—/,
    );
    assert.equal(
      await page.locator(".position-actions button:enabled").count(),
      0,
    );
    for (const width of [1920, 1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `Horizontal overflow at ${width}`,
      );
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await draw([{ ...basePosition, id: "reduced", attention }]);
    assert.equal(
      await page
        .locator(".position-entering")
        .evaluate((c) => getComputedStyle(c).animationName),
      "none",
    );
    await page.setViewportSize({ width: 1440, height: 1100 });
    await draw(
      Array.from({ length: 3 }, (_, i) => ({
        ...basePosition,
        id: `final-${i}`,
        symbol: i ? `TOKEN${i}` : "IMAGINE",
        ...(i ? {} : { attention }),
      })),
    );
    await page.screenshot({
      path: "docs/previews/positions-cards-isolated.png",
      fullPage: true,
    });
    // Flow details stay collapsed and independent of position details across fresh SSE payloads.
    const flowPosition = {
      ...basePosition,
      id: "flow-card",
      lastQuoteAt: Date.now(),
      runner: { marketMultiple: 10 },
      flow: {
        at: Date.now(),
        regime: "INFLOW_ACCELERATING",
        confidence: 0.7,
        window: "1m",
        features: {
          volumeChangePercent: 20,
          netFlowUsd: 90000,
          buyPressure: 0.65,
          liquidityChangePercent: 4,
          smartMoneyNetFlowUsd: null,
        },
        quality: {
          observations: 5,
          missing: ["smartMoneyBuyUsd", "smartMoneySellUsd"],
        },
        transitions: [],
      },
    };
    await draw([flowPosition]);
    const flowCard = page.locator('[data-position-id="flow-card"]');
    assert.match(await flowCard.textContent(), /DÒNG MUA TĂNG TỐC/);
    assert.equal(
      await flowCard.locator(".valuation-warning").isVisible(),
      false,
    );
    assert.equal(
      await flowCard
        .locator(".position-capital-flow .position-metric-grid")
        .isVisible(),
      false,
    );
    await flowCard
      .locator('[data-detail-panel="capital-flow"] summary')
      .click();
    await flowCard.locator('[data-detail-panel="position"] summary').click();
    await draw([{ ...flowPosition, realizedLamports: "250000" }]);
    assert.equal(await flowCard.locator("details[open]").count(), 2);
    assert.match(
      await flowCard.locator(".position-capital-flow").textContent(),
      /CHƯA CÓ/,
    );
    // A clock tick without a new payload must mark a once-fresh valuation and flow stale.
    await page.evaluate(() => {
      const now = Date.now;
      try {
        Date.now = () => now() + 100000;
        window.BOTPositions.tick();
      } finally {
        Date.now = now;
      }
    });
    assert.equal(
      await flowCard.locator(".valuation-warning").isVisible(),
      true,
    );
    assert.equal(await flowCard.locator(".flow-stale").count(), 1);
    const completed = Array.from({ length: 30 }, (_, i) => ({
      ...basePosition,
      id: `history-${i}`,
      entryAt: basePosition.entryAt + i * 1000,
      symbol: `HISTORY${i}`,
      state: "CLOSED",
      quantity: "0",
      remainingCostLamports: "0",
      realizedLamports: i % 2 ? "-500000" : "200000",
      exitStatus: "Maximum holding time reached",
    }));
    await draw(completed);
    await page.locator('[data-view="history"]').click();
    const firstHistory = page.locator("#historyRows .history-record").first();
    assert.equal(
      await page.locator("#historyRows .history-record").count(),
      30,
    );
    assert.equal(await firstHistory.evaluate((row) => row.open), false);
    assert.equal(
      await firstHistory.locator(".history-detail").isVisible(),
      false,
    );
    assert.match(
      await firstHistory.locator("summary").textContent(),
      /HISTORY29.*-0.0005 SOL/,
    );
    assert.doesNotMatch(
      await firstHistory.locator("summary").textContent(),
      /Mint|Chế độ|Vốn đã đầu tư/,
    );
    await firstHistory.locator("summary").click();
    assert.equal(
      await firstHistory.locator(".history-detail").isVisible(),
      true,
    );
    assert.match(
      await firstHistory.locator(".history-detail").textContent(),
      /Đã hết thời gian nắm giữ tối đa/,
    );
    const scrollState = await page.locator("#historyRows").evaluate((list) => {
      list.scrollTop = 120;
      return {
        top: list.scrollTop,
        overflow: list.scrollHeight > list.clientHeight,
        style: getComputedStyle(list).overflowY,
      };
    });
    assert.equal(scrollState.overflow, true);
    assert.equal(scrollState.style, "auto");
    await draw(completed);
    assert.equal(await firstHistory.evaluate((row) => row.open), true);
    assert.equal(
      await page.locator("#historyRows").evaluate((list) => list.scrollTop),
      scrollState.top,
    );
    await page.locator("#historyRows").evaluate((list) => {
      list.scrollTop = 0;
    });
    await firstHistory.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await firstHistory.evaluate((row) => row.open), false);
    await page.screenshot({
      path: "docs/previews/history-compact-isolated.png",
      fullPage: true,
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: position cards 1/3/10/20, totals, partial PnL, attention ordering, missing data, confirmation/cancel, queued/UNKNOWN disabling, stable details, responsive grid and reduced motion.",
    );
  } finally {
    await page.close();
  }
}
