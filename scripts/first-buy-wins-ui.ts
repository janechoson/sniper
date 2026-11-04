/** Source-only PAPER browser + isolated compile verification. No retained artifacts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { startServer } from "../src/server.js";
import { env } from "../src/config.js";
import { provider, position } from "../tests/fixtures.js";
import { ATTEMPT_STAGES } from "../src/candidate-attempt.js";

const dir = mkdtempSync(join(tmpdir(), "first-buy-wins-ui-"));
let app: Awaited<ReturnType<typeof startServer>> | undefined, browser;
try {
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      join(dir, "compiled"),
    ],
    { stdio: "inherit", windowsHide: true },
  );
  env.DATABASE_PATH = join(dir, "fixture.sqlite");
  env.PORT = 42000 + Math.floor(Math.random() * 5000);
  env.TRADING_MODE = "paper";
  env.LIVE_TRADING_ACK = false;
  env.WALLET_PUBLIC_KEY = "";
  env.SCANNER_ENABLED = false;
  env.NEW_ENTRIES_ENABLED = false;
  const g = provider();
  app = await startServer({
    providers: { gmgn: g.gmgn },
  });
  await app.engine.stop();
  const base = `http://127.0.0.1:${env.PORT}`;
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  // Keep fixture frames stable: install alone still advances timers in real time.
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/api/events", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" }),
  );
  await page.goto(base);
  await page.waitForSelector(".strategy-card", { state: "attached" });
  assert.equal(await page.locator(".strategy-card").count(), 2);
  assert.equal(
    await page
      .locator("#terminalResult, #terminalVerdict, #terminalStrategyCards")
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("heading", { name: "Kết quả", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Đánh giá hiện tại – STANDARD",
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Đánh giá hiện tại – KRONOS", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await page.locator("#terminalOverview > .strategy-card").count(),
    2,
  );
  assert.equal(await page.locator(".strategy-card .strategy-card").count(), 0);
  assert.equal(
    await page.locator(".strategy-card [data-status=PASS]").count(),
    0,
    "Empty cards cannot invent PASS",
  );
  await page.locator('a[data-route][href="/settings"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/settings"]',
  );
  assert.equal(
    await page.locator('[name="entryStrategy"]').count(),
    0,
  );
  await page.locator('a[data-route][href="/"]').click();
  await page.waitForSelector(
    '#routeOutlet[data-state="ready"][data-route="/"]',
  );
  const browserNow = await page.evaluate(() => Date.now());
  const frame = (owner: "STANDARD" | "KRONOS", late: boolean) => ({
    attempt: {
      attemptId: "ui-race",
      mint: "fixture-mint",
      symbol: "COMPARE",
      source: "GMGN_TRENDING",
      startedAt: Date.now(),
      result: "RUNNING",
      stage: "BUY",
      stages: Object.fromEntries(
        ATTEMPT_STAGES.map((stage) => [stage, "PASS"]),
      ),
      logs: [],
      summaries: {
        strategy: "FIRST_BUY_WINS",
        token: { symbol: "COMPARE" },
        ownershipClaim: { strategy: owner },
        manipulationStructure: { status: "LOW" },
        strategies: {
          STANDARD: {
            decision: owner === "STANDARD" || late ? "BUY" : "CHECKING",
            execution:
              owner === "STANDARD"
                ? "CONFIRMED"
                : late
                  ? "BLOCKED_OWNER_ALREADY_CLAIMED"
                  : "WAITING_DECISION",
            stages: {
              STRUCTURE: owner === "STANDARD" || late ? "PASS" : "CHECKING",
              JEV: owner === "STANDARD" || late ? "PASS" : "PENDING",
              RISK: owner === "STANDARD" || late ? "PASS" : "PENDING",
            },
          },
          KRONOS: {
            decision: owner === "KRONOS" || late ? "BUY" : "CHECKING",
            execution:
              owner === "KRONOS"
                ? "CONFIRMED"
                : late
                  ? "BLOCKED_OWNER_ALREADY_CLAIMED"
                  : "WAITING_DECISION",
            stages: {
              KRONOS: owner === "KRONOS" || late ? "PASS" : "CHECKING",
              RISK: owner === "KRONOS" || late ? "PASS" : "PENDING",
            },
          },
        },
      },
    },
    queue: [],
    positions: [],
    scanner: { running: true },
  });
  const standard = page.locator('.strategy-card[data-strategy="STANDARD"]'),
    kronos = page.locator('.strategy-card[data-strategy="KRONOS"]');
  const show = async (value: unknown, status?: unknown) =>
    page.evaluate(
      ({ frame, status }) => {
        const before = JSON.stringify(frame);
        (window as any).BOTOverview.update(frame, status);
        if (JSON.stringify(frame) !== before)
          throw Error("UI mutated backend frame");
      },
      { frame: value, status },
    );
  const stage = (strategy: "STANDARD" | "KRONOS", name: string) =>
    (strategy === "STANDARD" ? standard : kronos).locator(
      '[data-stage="' + name + '"]',
    );
  const common = [
    "CHEAP_FILTER",
    "SECURITY",
    "COMPATIBILITY",
    "HISTORY",
    "CAPITAL_FLOW",
    "COMMON_RISK",
  ];
  const internals = [
    "FINAL_ANALYSIS",
    "OWNERSHIP_CAPITAL",
    "BUY_QUOTE",
    "EXIT_FEASIBILITY",
    "VALIDATE",
    "SIMULATE",
    "PRE_SIGN",
    "POSITION",
  ];
  for (const owner of ["STANDARD", "KRONOS"] as const)
    for (const late of [false, true]) {
      const original = frame(owner, late);
      await show(original);
      assert.equal(
        await stage(owner, "BUY").getAttribute("data-status"),
        "SUCCESS",
      );
      const loser = owner === "STANDARD" ? "KRONOS" : "STANDARD";
      assert.equal(
        await stage(loser, "BUY").getAttribute("data-status"),
        late ? "BLOCKED" : "PENDING",
      );
      if (late)
        assert.equal(
          original.attempt.summaries.strategies[loser].decision,
          "BUY",
        );
      for (const card of [standard, kronos]) {
        assert.equal(await card.locator('[data-stage="BUY"]').count(), 1);
        assert.equal(
          await card
            .locator(
              ".strategy-decision,.strategy-card-row,.strategy-card-owner,.strategy-policy",
            )
            .count(),
          0,
        );
        assert.doesNotMatch(
          await card.innerText(),
          /Decision|Execution|Owner:|FIRST_BUY_WINS|Fresh Final Analysis|Jupiter BUY Quote|Exit Feasibility|Simulation|Pre-sign Validation/,
        );
      }
    }
  assert.equal(
    await page
      .locator("#standardDecision,#kronosDecision,#kronosForecast")
      .count(),
    0,
  );
  for (const name of internals)
    for (const strategy of ["STANDARD", "KRONOS"] as const)
      assert.equal(await stage(strategy, name).count(), 0);
  for (const name of common)
    for (const strategy of ["STANDARD", "KRONOS"] as const) {
      assert.equal(
        await stage(strategy, name).getAttribute("data-status"),
        "PASS",
      );
      assert.equal(await stage(strategy, name).locator("em").isVisible(), true);
    }
  assert.equal(await standard.locator(".terminal-stage").count(), 11);
  assert.equal(await kronos.locator(".terminal-stage").count(), 9);
  for (const name of ["CONTROLLED_MARKUP", "STRUCTURE", "JEV"]) {
    assert.equal(await stage("STANDARD", name).count(), 1);
    assert.equal(await stage("KRONOS", name).count(), 0);
  }
  assert.equal(await stage("STANDARD", "KRONOS").count(), 0);
  const color = async (strategy: "STANDARD" | "KRONOS", name: string) =>
    stage(strategy, name)
      .locator("em")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  const progress = frame("STANDARD", false);
  delete (progress.attempt.summaries as any).ownershipClaim;
  progress.attempt.stages = Object.fromEntries(
    ATTEMPT_STAGES.map((name) => [
      name,
      name === "CHEAP_FILTER"
        ? "PASS"
        : name === "SECURITY"
          ? "CHECKING"
          : "PENDING",
    ]),
  );
  await show(progress);
  assert.equal(await color("STANDARD", "CHEAP_FILTER"), "rgb(22, 132, 71)");
  assert.equal(await color("KRONOS", "SECURITY"), "rgb(184, 120, 8)");
  assert.equal(await color("STANDARD", "COMPATIBILITY"), "rgb(199, 192, 175)");
  const commonFail = frame("STANDARD", false);
  delete (commonFail.attempt.summaries as any).ownershipClaim;
  commonFail.attempt.stages.CAPITAL_FLOW = "FAIL";
  Object.assign(commonFail.attempt, {
    failedStage: "CAPITAL_FLOW",
    reasonCode: "INSUFFICIENT_DIRECTIONAL_DATA",
    result: "REJECTED",
  });
  Object.assign(commonFail.attempt, {
    logs: [
      {
        at: Date.now(),
        stage: "CAPITAL_FLOW",
        status: "FAIL",
        message: "INSUFFICIENT_DIRECTIONAL_DATA",
      },
    ],
  });
  await show(commonFail);
  for (const strategy of ["STANDARD", "KRONOS"] as const)
    assert.equal(await color(strategy, "CAPITAL_FLOW"), "rgb(213, 43, 40)");
  assert.match(
    await page.locator("#terminalLogs").innerText(),
    /INSUFFICIENT_DIRECTIONAL_DATA/,
  );
  const branchFail = frame("STANDARD", false);
  delete (branchFail.attempt.summaries as any).ownershipClaim;
  Object.assign(branchFail.attempt.summaries.strategies.STANDARD, {
    decision: "REJECT",
    execution: "NOT_EXECUTED",
    stages: { STRUCTURE: "FAIL", JEV: "PENDING", RISK: "PENDING" },
  });
  branchFail.attempt.stages.STRUCTURE = "FAIL";
  await show(branchFail);
  assert.equal(await color("STANDARD", "STRUCTURE"), "rgb(213, 43, 40)");
  assert.equal(
    await stage("KRONOS", "KRONOS").getAttribute("data-status"),
    "CHECKING",
  );
  assert.equal(await kronos.locator('[data-status="FAIL"]').count(), 0);
  const modelError = frame("KRONOS", false);
  delete (modelError.attempt.summaries as any).ownershipClaim;
  Object.assign(modelError.attempt.summaries.strategies.KRONOS, {
    decision: "ERROR",
    execution: "NOT_EXECUTED",
    stages: { KRONOS: "FAIL", RISK: "PENDING" },
  });
  await show(modelError);
  assert.equal(
    await stage("KRONOS", "KRONOS").getAttribute("data-status"),
    "FAIL",
  );
  assert.equal(
    await stage("STANDARD", "STRUCTURE").getAttribute("data-status"),
    "CHECKING",
  );
  const wait = frame("STANDARD", false);
  Object.assign(wait.attempt.summaries.strategies.KRONOS, {
    decision: "WAIT",
    execution: "NOT_EXECUTED",
    stages: { KRONOS: "FAIL", RISK: "PENDING" },
  });
  Object.assign(wait.attempt.summaries, {
    kronos: {
      action: "WAIT",
      reason: "DISAGREEMENT_OR_FLAT_UNCERTAIN",
      evidence: {
        candleCount: 60,
        lastObservedClose: 1,
        terminalPrices: [1.1, 0.9, 1],
      },
    },
  });
  await show(wait);
  assert.equal(
    await stage("KRONOS", "KRONOS").getAttribute("data-status"),
    "PASS",
  );
  assert.equal(
    await stage("KRONOS", "BUY").getAttribute("data-status"),
    "PENDING",
  );
  for (const classification of [
    "LOW",
    "MODERATE",
    "STRONG",
    "INSUFFICIENT_DATA",
  ]) {
    const classified = frame("STANDARD", false);
    classified.attempt.summaries.manipulationStructure.status = classification;
    await show(classified);
    assert.equal(
      await stage("STANDARD", "CONTROLLED_MARKUP").locator("b").innerText(),
      classification,
    );
  }
  for (const [execution, expected, active] of [
    ["OWNERSHIP_CLAIMED", "OWNER", false],
    ["OWNERSHIP_CLAIMED", "EXECUTING", true],
    ["EXECUTION_FAILED", "FAIL", true],
    ["RECONCILING", "CHECKING", true],
    ["CONFIRMED", "SUCCESS", true],
  ] as const) {
    const phase = frame("STANDARD", false);
    phase.attempt.stages = Object.fromEntries(
      ATTEMPT_STAGES.map((name) => [
        name,
        common.includes(name) ? "PASS" : "PENDING",
      ]),
    );
    phase.attempt.summaries.strategies.STANDARD.execution = execution;
    if (active) phase.attempt.stages.BUY_QUOTE = "CHECKING";
    Object.assign(phase.attempt, {
      logs: [
        {
          at: Date.now(),
          stage: "BUY_QUOTE",
          status: "CHECKING",
          message: "Jupiter BUY Quote: CHECKING",
        },
        {
          at: Date.now(),
          stage: "SIMULATE",
          status: "PASS",
          message: "Simulation: PASS",
        },
      ],
    });
    await show(phase);
    assert.equal(
      await stage("STANDARD", "BUY").getAttribute("data-status"),
      expected,
    );
    assert.match(
      await page.locator("#terminalLogs").innerText(),
      /Jupiter BUY Quote/,
    );
    assert.match(await page.locator("#terminalLogs").innerText(), /Simulation/);
  }
  const compactCases: Array<[unknown, string]> = [
    [1120874.07722105, "$1.1M"],
    [1120.07, "$1.1K"],
    [49132.16127588, "$49.1K"],
    [999, "$999"],
    [12450, "$12.5K"],
    [2530000, "$2.5M"],
    [1240000000, "$1.2B"],
    [1000000, "$1M"],
    [494977.20164837, "$495K"],
    [15430, "$15.4K"],
    [999999, "$1M"],
    [0, "$0"],
    [-1120.07, "-$1.1K"],
    [null, "N/A"],
    [undefined, "N/A"],
    [NaN, "N/A"],
    [Infinity, "N/A"],
    ["", "N/A"],
  ];
  const smallCases: Array<[unknown, string]> = [
    [12.45, "$12.45"],
    [1.08, "$1.08"],
    [0.15, "$0.15"],
    [-0.08, "-$0.08"],
    [0.009, "$0.009"],
    [0.00175667, "$0.0018"],
    [5e-12, "$5e-12"],
    [0, "$0.00"],
    [null, "N/A"],
    [undefined, "N/A"],
    [NaN, "N/A"],
    [Infinity, "N/A"],
    [false, "N/A"],
  ];
  for (const [helper, cases] of [
    ["formatCompactUsd", compactCases],
    ["formatSmallUsd", smallCases],
  ] as const)
    for (const [value, expected] of cases)
      assert.equal(
        await page.evaluate(
          ({ helper, value }) =>
            (window as any).BOTOverview.formatters[helper](value),
          { helper, value },
        ),
        expected,
        helper + " " + String(value),
      );
  const monetary = {
    ...frame("STANDARD", true),
    positions: [
      {
        ...position(),
        id: "usd-position",
        strategy: "STANDARD",
        displayState: "OPEN",
        exitState: "READY",
        valuationStale: false,
        accounting: {
          entry: { priceUsd: "0.0082" },
          principalLamports: "873000",
          grossPnlLamports: "-85990",
          grossPnlPct: -9.9,
          feesPaidLamports: "19000",
          netPnlLamports: "-104990",
          feeCompleteness: "COMPLETE",
          feeRecords: [],
        },
      },
    ],
    market: [{ mint: position().mint, payload: { priceUsd: "0.0072" } }],
  };
  Object.assign(monetary.attempt.summaries, {
    market: {
      price: { state: "KNOWN", value: 0.00004914 },
      marketCap: { state: "KNOWN", value: 1120874.07722105 },
      liquidity: { state: "KNOWN", value: 49132.16127588 },
      volume: { state: "KNOWN", value: 494977.20164837 },
    },
  });
  const fx = {
    mode: "paper",
    balanceLamports: "1000000000",
    solPriceUsd: "92.456",
    solPriceUpdatedAt: browserNow,
  };
  await show(monetary, fx);
  const cells = page.locator(
    '#terminalPositionRows tr[data-position-id="usd-position"] td',
  );
  assert.equal(await cells.nth(3).innerText(), "$0.08");
  assert.equal(await cells.nth(5).innerText(), "-$0.008");
  assert.equal(await cells.nth(7).innerText(), "$0.0018");
  assert.equal(await cells.nth(2).innerText(), "$0.0082");
  assert.equal(await cells.nth(4).innerText(), "$0.0072");
  assert.equal(await cells.nth(6).innerText(), "-9.9%");
  assert.match(await cells.nth(8).innerText(), /SOL/);
  assert.equal(
    await page.locator('[data-label="Market Cap"] strong').innerText(),
    "$1.1M",
  );
  assert.equal(
    await page.locator('[data-label="Liquidity"] strong').innerText(),
    "$49.1K",
  );
  assert.equal(
    await page.locator('[data-label="Volume 24h"] strong').innerText(),
    "$495K",
  );
  assert.equal(
    await page.locator('[data-label="Price"] strong').innerText(),
    "$0.00004914",
  );
  await show(monetary, { ...fx, solPriceUsd: "100" });
  assert.equal(await cells.nth(7).innerText(), "$0.0019");
  for (const invalid of [
    { solPriceUsd: null },
    { solPriceUsd: "NaN" },
    { solPriceUsd: "Infinity" },
    { solPriceUsd: "0" },
    { solPriceUpdatedAt: browserNow - 60001 },
    { solPriceUpdatedAt: browserNow + 60000 },
  ]) {
    await show(monetary, { ...fx, ...invalid });
    for (const index of [3, 5, 7])
      assert.equal(await cells.nth(index).innerText(), "N/A");
  }
  await show(monetary, fx);
  // Actual read handlers: original owner plus both decisions are returned separately.
  const store = app.engine.store;
  env.NEW_ENTRIES_ENABLED = true;
  store.set("newEntriesEnabled", true);
  const attempt = app.engine.attempts.begin({
    mint: "fixture-history-mint",
    symbol: "HISTORY",
    source: "gmgn:trending",
    discoveredAt: Date.now(),
  });
  for (const strategy of ["STANDARD", "KRONOS"] as const)
    app.engine.attempts.strategy(attempt.attemptId, strategy, {
      decision: "BUY",
      execution:
        strategy === "STANDARD" ? "CONFIRMED" : "BLOCKED_OWNER_ALREADY_CLAIMED",
      owner: "STANDARD",
    });
  const acquired = store.claimMintForBuy(
    {
      mode: "paper",
      mint: attempt.mint,
      attemptId: attempt.attemptId,
      strategy: "STANDARD",
      decisionId: "ui-only-decision",
      decisionAt: Date.now(),
    },
    { revision: 0, path: "TRENDING", policy: "TRENDING_ONE_SHOT_V1" },
  );
  assert.ok(acquired.claimed);
  const p = {
    ...position(),
    mint: attempt.mint,
    mode: "paper" as const,
    strategy: "STANDARD" as const,
    state: "CLOSED" as const,
    quantity: "0",
    attemptId: attempt.attemptId,
    ownershipClaimId: acquired.claim.id,
  };
  store.savePosition(p);
  store.set("newEntriesEnabled", false);
  env.NEW_ENTRIES_ENABLED = false;
  const historical = await (
      await fetch(base + "/api/history?strategy=STANDARD")
    ).json(),
    detail = await (
      await fetch(base + "/api/attempt?id=" + attempt.attemptId)
    ).json();
  assert.equal(historical[0].entryComparison.strategies.KRONOS.decision, "BUY");
  assert.equal(
    historical[0].entryComparison.ownershipClaim.strategy,
    "STANDARD",
  );
  assert.equal(detail.ownershipClaim.strategy, "STANDARD");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const narrow = structuredClone(monetary);
    narrow.attempt.summaries.manipulationStructure.status = "INSUFFICIENT_DATA";
    Object.assign(narrow.attempt.summaries.strategies.KRONOS, {
      executionReason: "MODEL_DETAIL_".repeat(30),
    });
    await show(narrow, { ...fx, solPriceUpdatedAt: browserNow });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await page.locator(".strategy-card").count(), 2);
    const left = await standard.boundingBox(),
      right = await kronos.boundingBox();
    assert.ok(left && right);
    assert.ok(
      left.height < 650 && right.height < 650,
      "Compact cards have natural content height",
    );
    if (width >= 1024) {
      assert.ok(Math.abs(left.y - right.y) < 2);
      assert.ok(right.x > left.x + left.width - 1);
    } else assert.ok(right.y >= left.y + left.height - 1, "Mobile cards stack");
    for (const card of [standard, kronos]) {
      for (const light of await card.locator(".terminal-stage em").all())
        assert.equal(await light.isVisible(), true);
      assert.equal(
        await card.locator(".terminal-stage").evaluateAll((rows) =>
          rows.every((row) => {
            const el = row as HTMLElement;
            return el.clientWidth >= el.scrollWidth;
          }),
        ),
        true,
        "Stage names and lights fit without clipping",
      );
    }
    assert.equal(await page.locator(".token-scanner").isVisible(), true);
    assert.equal(await page.locator(".current-token").isVisible(), true);
    assert.equal(await page.locator(".action-log").isVisible(), true);
    assert.equal(await page.locator(".overview-positions").isVisible(), true);
  }
  assert.deepEqual(errors, []);
  assert.equal(store.executions().length, 0);
  assert.equal(g.calls.length, 0);
  console.log(
    "PASS: compact separate cards, BUY states/lights, no footers/internals, unchanged History/API ownership, USD/current FX and missing/stale handling, compact cap/volume, precise token Price, 1440/1024/390; zero console errors/provider requests/real execution; no retained artifacts.",
  );
} finally {
  await browser?.close();
  await app?.stop();
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.ok(basename(dir).startsWith("first-buy-wins-ui-"));
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
