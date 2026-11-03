import assert from "node:assert/strict";

export async function runFlowUiCases(browser, base) {
  const page = await browser.newPage({
      viewport: { width: 1600, height: 1100 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(
    () => document.getElementById("mode").textContent === "MÔ PHỎNG",
  );
  await page.evaluate(() => stream.close());
  const original = await (await fetch(base + "/api/status")).json();
  const known = (value) => ({ state: "KNOWN", value });
  const token = (index, state = "QUEUED") => ({
    mint: `flow-fixture-${index}`,
    symbol: [
      "ALPHA",
      "VECTOR",
      "ORBIT",
      "NOVA",
      "PRISM",
      "ATOM",
      "WAVE",
      "PEAK",
      "LUMEN",
      "AERO",
    ][index % 10],
    source: "isolated UI fixture",
    state,
    score: 90 - index,
    lastChecked: Date.now() - 18000,
    nextCheckAt: Date.now() + 60000,
    expiresAt: Date.now() + 900000,
    reason: "Fresh conditions required",
    market: {
      price: known(0.000123),
      marketCap: known(42000 + index * 1000),
      volume: known(18000 + index * 7000),
      liquidity: known(12000),
      buys: known(90),
      sells: known(30),
    },
    security: { findings: [] },
    holders: { count: known(180) },
    tokenExecution: { tokenProgram: "TOKEN_2022" },
  });
  const flow = (count = 0) => ({
    version: 1,
    scannerRunning: true,
    limits: { queue: 10, watch: 30, deferred: 20 },
    counts: {
      scanned: 42,
      perMinute: 4,
      queue: count,
      checking: 0,
      watch: 0,
      deferred: 0,
      rejected: 0,
      approved: 0,
      traded: 0,
    },
    scanner: Array.from({ length: 8 }, (_, i) => token(i)),
    queue: Array.from({ length: count }, (_, i) => token(i)),
    watch: [],
    deferred: [],
    rejected: [],
    decisions: [],
    events: [],
  });
  let snapshot = {
    ...original,
    flow: flow(),
    positionSummary: { count: 0, attention: 0 },
  };
  async function send(value, extra = {}) {
    snapshot = {
      ...original,
      ...extra,
      flow: value,
      positionSummary: extra.positionSummary || { count: 0, attention: 0 },
      candidatePipeline: {
        capacity: 10,
        queue: value.queue,
        watch: value.watch,
        deferred: value.deferred,
      },
    };
    await page.evaluate((s) => render(s), snapshot);
  }
  const event = (id, type, from, to, extra = {}) => ({
    id,
    type,
    from,
    to,
    mint: "flow-fixture-0",
    symbol: "ALPHA",
    at: Date.now(),
    mode: "paper",
    ...extra,
  });
  for (const count of [0, 1, 9, 10]) {
    await send(flow(count));
    assert.equal(await page.locator("#flowQueueSlots > li").count(), 10);
    assert.equal(
      await page.locator("#flowQueueSlots .flow-token").count(),
      count,
    );
    assert.equal(
      await page.locator("#flowQueueCount").textContent(),
      `${count} / 10`,
    );
  }
  assert.equal(await page.locator("#sourceState").textContent(), "ĐANG QUÉT");
  assert.match(
    await page.locator("#sourceCaption").textContent(),
    /Hàng đợi đầy.*vẫn tiếp tục quét/,
  );
  assert.equal(await page.locator(".travel-token").count(), 0); // snapshots do not invent admissions
  const previousNode = await page
    .locator("#flowQueueSlots > li")
    .first()
    .elementHandle();
  const unchanged = flow(10);
  unchanged.counts.scanned = 43;
  await send(unchanged);
  assert.equal(
    await previousNode.evaluate(
      (node) => node === document.querySelector("#flowQueueSlots > li"),
    ),
    true,
  );
  const lightweight = flow(9);
  await page.evaluate(
    (frame) =>
      stream.dispatchEvent(
        new MessageEvent("flow", { data: JSON.stringify(frame) }),
      ),
    lightweight,
  );
  assert.equal(await page.locator("#flowQueueCount").textContent(), "9 / 10");
  let current = flow(1);
  current.events = [
    event(1, "CANDIDATE_QUEUED", "DISCOVERY", "QUEUED", { origin: "SCANNER" }),
  ];
  await send(current);
  await page.waitForSelector(".travel-token.tone-scanner");
  current = flow(0);
  current.rejected = [token(0, "REJECTED")];
  current.counts.rejected = 1;
  current.events = [
    event(2, "CANDIDATE_REJECTED", "ANALYZING", "REJECTED", {
      reason: "Security rejection",
    }),
  ];
  await send(current);
  await page.waitForSelector(".travel-stamp");
  assert.equal(await page.locator("#flowQueueSlots .flow-token").count(), 0);
  assert.equal(await page.locator("#rejectedPreview .flow-token").count(), 1);
  await page.waitForFunction(() => window.BOTFlow.diagnostics().active === 0);
  assert.equal(await page.locator(".travel-token").count(), 0);
  current = flow(1);
  current.queue[0] = token(0, "ANALYZING");
  current.counts.checking = 1;
  current.events = [event(3, "CANDIDATE_CHECKING", "QUEUED", "ANALYZING")];
  await send(current);
  assert.equal(await page.locator("#flowQueueSlots .is-checking").count(), 1);
  assert.equal(await page.locator("#flowQueueSlots .flow-spinner").count(), 1);
  assert.equal(
    await page
      .locator("#flowQueueSlots .is-checking .token-avatar")
      .evaluate((e) => getComputedStyle(e).animationName),
    "checking-wiggle",
  );
  current = flow(0);
  current.watch = [token(0, "WATCH")];
  current.counts.watch = 1;
  current.events = [event(4, "CANDIDATE_WATCHING", "ANALYZING", "WATCH")];
  await send(current);
  await page.waitForSelector(".travel-token.tone-watch");
  assert.equal(await page.locator(".travel-stamp").count(), 0);
  assert.equal(await page.locator("#watchBadge").textContent(), "1");
  current = flow(1);
  current.queue[0] = token(0, "QUALIFIED");
  current.decisions = [current.queue[0]];
  current.events = [
    event(5, "CANDIDATE_QUALIFIED", "ANALYZING", "QUALIFIED", {
      origin: "WATCH",
    }),
  ];
  await send(current);
  await page.waitForSelector(".travel-token.tone-qualified");
  assert.equal(
    await page.locator('#decisionNodes [data-node="QUALIFIED"].active').count(),
    1,
  );
  current.events = [event(6, "JEV_STARTED", "QUALIFIED", "JEV_ANALYZING")];
  current.decisions = [{ ...token(0, "QUALIFIED"), event: current.events[0] }];
  await send(current);
  assert.match(
    await page.locator("#decisionFocus").textContent(),
    /JEV ĐANG PHÂN TÍCH/,
  );
  current.events = [event(7, "RISK_REVIEW", "JEV", "RISK_REVIEW")];
  current.decisions[0].event = current.events[0];
  await send(current);
  assert.equal(
    await page.locator('#decisionNodes [data-node="RISK"].active').count(),
    1,
  );
  current.events = [
    event(8, "RISK_REJECTED", "RISK_REVIEW", "RISK_REJECTED", {
      reason: "Fixture current risk rejection",
    }),
  ];
  current.decisions[0].event = current.events[0];
  await send(current);
  assert.equal(
    await page.locator('#decisionNodes [data-node="RISK"].failed').count(),
    1,
  );
  assert.doesNotMatch(
    await page.locator("#decisionFocus").textContent(),
    /MUA ĐÃ XÁC NHẬN/,
  );
  current.events = [
    event(9, "CANDIDATE_QUALIFIED", "ANALYZING", "QUALIFIED", {
      origin: "SCANNER",
    }),
  ];
  current.decisions[0].event = current.events[0];
  await send(current);
  await page.waitForSelector(".travel-token.tone-qualified");
  current = flow(0);
  current.deferred = [token(0, "DEFERRED")];
  current.counts.deferred = 1;
  current.events = [
    event(10, "CANDIDATE_DEFERRED", "ANALYZING", "DEFERRED", {
      reason: "TOKEN_SAFETY_FAILED",
    }),
  ];
  await send(current);
  await page.waitForSelector(".travel-token.tone-deferred");
  assert.equal(await page.locator(".travel-stamp").count(), 0);
  assert.equal(await page.locator("#deferredBadge").textContent(), "1");
  current = flow(1);
  current.events = [
    event(11, "CANDIDATE_QUEUED", "DEFERRED", "QUEUED", { origin: "DEFERRED" }),
  ];
  await send(current);
  await page.waitForSelector(".travel-token.tone-deferred");
  assert.equal(await page.locator("#deferredBadge").isVisible(), false);
  current.decisions = [
    {
      ...token(0, "APPROVED"),
      buyState: "SUBMITTED",
      buySignature: "fixture-signature",
    },
  ];
  current.events = [event(12, "BUY_SUBMITTED", "APPROVED", "SUBMITTED")];
  await send(current);
  assert.match(await page.locator("#decisionFocus").textContent(), /ĐÃ GỬI/);
  assert.doesNotMatch(
    await page.locator("#decisionFocus").textContent(),
    /MUA ĐÃ XÁC NHẬN/,
  );
  assert.equal(await page.locator("#positionsBadge").isVisible(), false);
  current = flow(0);
  current.decisions = [
    {
      ...token(0, "BOUGHT"),
      buyState: "CONFIRMED",
      buySignature: "fixture-signature",
    },
  ];
  current.events = [event(13, "BUY_CONFIRMED", "SUBMITTED", "CONFIRMED")];
  current.counts.traded = 1;
  await send(current, { positionSummary: { count: 1, attention: 0 } });
  assert.match(
    await page.locator("#decisionFocus").textContent(),
    /MUA ĐÃ XÁC NHẬN/,
  );
  assert.equal(await page.locator("#positionsBadge").textContent(), "1");
  await send(current, {
    haltReason: "RPC_GLOBAL_UNHEALTHY",
    haltScope: "SYSTEM",
    newEntriesEnabled: false,
  });
  assert.match(
    await page.locator("#notice").textContent(),
    /TẠM DỪNG HỆ THỐNG/,
  );
  assert.equal(await page.locator("#notice.system-pause").count(), 1);
  // A reload hydrates exact current state, without replaying old transition IDs.
  current = flow(1);
  current.queue[0] = token(0, "ANALYZING");
  current.counts.checking = 1;
  current.watch = [token(1, "WATCH")];
  current.counts.watch = 1;
  current.deferred = [token(2, "DEFERRED")];
  current.counts.deferred = 1;
  current.events = [event(100, "CANDIDATE_CHECKING", "QUEUED", "ANALYZING")];
  await send(current, { positionSummary: { count: 1, attention: 1 } });
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(snapshot)}\n\n`,
    }),
  );
  await page.route("**/api/positions", (route) =>
    route.fulfill({
      json: [
        {
          id: "fixture-position",
          mint: "flow-fixture-held",
          symbol: "HELD",
          mode: "paper",
          state: "OPEN",
          quantity: "1000000",
          originalQuantity: "1000000",
          costLamports: "1000000",
          remainingCostLamports: "1000000",
          realizedLamports: "0",
          entryAt: Date.now(),
          decimals: 6,
          attention: {
            status: "NEEDS_ATTENTION",
            issue: {
              code: "TOKEN_SAFETY_FAILED",
              stage: "PRE_SELL",
              reasonCode: "fixture",
            },
            lastChecked: Date.now(),
            nextCheckAt: Date.now() + 60000,
            protectiveExit: "BACKOFF",
          },
        },
      ],
    }),
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#flowQueueSlots .is-checking").length === 1,
  );
  await page.evaluate(() => stream.close());
  assert.equal(await page.locator("#watchBadge").textContent(), "1");
  assert.equal(await page.locator("#deferredBadge").textContent(), "1");
  assert.equal(await page.locator("#positionsBadge").textContent(), "1");
  assert.equal(await page.locator(".travel-token").count(), 0);
  current = flow(10);
  current.events = Array.from({ length: 80 }, (_, i) =>
    event(200 + i, "CANDIDATE_DEFERRED", "ANALYZING", "DEFERRED", {
      mint: `burst-${i}`,
    }),
  );
  await send(current);
  const diagnostics = await page.evaluate(() => window.BOTFlow.diagnostics());
  assert.ok(diagnostics.active <= 2);
  assert.ok(diagnostics.pending <= 16);
  await page.locator('[data-view="watchlist"]').click();
  assert.equal(await page.locator(".travel-token").count(), 0);
  await page.locator('[data-view="overview"]').click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  current = flow(10);
  current.queue[0] = token(0, "ANALYZING");
  current.scanner[0].symbol = "VERY_LONG_TOKEN_SYMBOL_".repeat(8);
  current.watch = [
    { ...token(2, "WATCH"), reason: "Long actual reason ".repeat(30) },
  ];
  current.counts.watch = 1;
  current.events = [
    event(900, "CANDIDATE_QUEUED", "DISCOVERY", "QUEUED", {
      origin: "SCANNER",
    }),
  ];
  await send(current);
  assert.equal(await page.locator(".travel-token").count(), 0);
  assert.equal(
    await page
      .locator("#sourceTank .scanner-radar i")
      .evaluate((e) => getComputedStyle(e).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator("#flowQueueSlots .is-checking .token-avatar")
      .evaluate((e) => getComputedStyle(e).animationName),
    "none",
  );
  for (const width of [1600, 1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      true,
      `page overflow at ${width}`,
    );
    if (width >= 1280)
      assert.ok(
        (await page.locator("#sourceTank").boundingBox()).x <
          (await page.locator("#queueTank").boundingBox()).x,
      );
  }
  // Export a representative fixture image, clearly identified as PAPER by the app.
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  current = flow(7);
  current.queue[0] = token(0, "ANALYZING");
  current.counts.checking = 1;
  current.watch = [token(8, "WATCH"), token(9, "WATCH"), token(10, "WATCH")];
  current.counts.watch = 3;
  current.deferred = [token(11, "DEFERRED")];
  current.counts.deferred = 1;
  current.rejected = [
    {
      ...token(12, "REJECTED"),
      reason: "Security / token compatibility rejected",
    },
  ];
  current.counts.rejected = 1;
  current.decisions = [
    {
      ...token(13, "QUALIFIED"),
      event: event(901, "JEV_STARTED", "QUALIFIED", "JEV_ANALYZING"),
    },
  ];
  current.events = [event(901, "JEV_STARTED", "QUALIFIED", "JEV_ANALYZING")];
  await send(current, { positionSummary: { count: 1, attention: 1 } });
  await page.screenshot({
    path: "data/token-flow-desktop-fixture.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    "PASS: token flow 0/1/9/10, event-driven routes, stamp, checking, decisions, reload, rapid events, reduced motion and 1600/1440/1280/1024/mobile overflow.",
  );
}
