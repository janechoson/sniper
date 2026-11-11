import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { env, settingsSchema } from "../src/config.js";
import { known, unknown } from "../src/domain.js";
import {
  normalizeIntelligence,
  normalizeMarket,
  normalizeSecurity,
  numberEvidence,
  parseDiscovery,
  percent,
} from "../src/gmgn.js";
import {
  RiskEngine,
  cheapGuard,
  exitDecision,
  paperQuantity,
  paperValue,
  size,
} from "../src/risk.js";
import { Store } from "../src/store.js";
import {
  MINT,
  candidate,
  info,
  position,
  securityRaw,
  settings,
  snapshot,
} from "./fixtures.js";
import { bindFixtureClaim } from "./kronos-fixtures.js";
const context = {
    balance: 1000000000n,
    pending: 0n,
    positions: 0,
    duplicate: false,
    entriesEnabled: true,
  },
  risk = new RiskEngine();
test("exact integer 1% reserves fees and pending trades without downsizing", () => {
  assert.deepEqual(size(1000000000n, 20000000n, 100000000n), {
    available: 880000000n,
    amount: 8800000n,
  });
  assert.equal(size(299n, 0n).amount, 2n);
  assert.equal(size(1n, 2n).amount, 0n);
  assert.equal(
    settingsSchema.parse({ positionSizePercent: 5 }).positionSizePercent,
    5,
  );
  assert.throws(() => settingsSchema.parse({ dailyUsdCap: 50 }));
});
test("paper valuation handles scientific token prices without atomic precision loss", () => {
  assert.equal(paperQuantity(1000000000n, "100", "1", 6), 100000000n);
  assert.equal(paperValue(100000000n, "100", "1", 6), 1000000000n);
  assert.equal(
    paperQuantity(1000000000n, "100", "1e-10", 6),
    1000000000000000000n,
  );
});
test("GMGN missing numbers and malformed fractional percentages remain UNKNOWN", () => {
  for (const v of [null, undefined, "", true, "NaN", -1])
    assert.equal(numberEvidence(v).state, "UNKNOWN");
  assert.deepEqual(numberEvidence("0"), known(0));
  assert.deepEqual(percent(".3"), known(30));
  assert.equal(percent(30).state, "UNKNOWN");
});
test("Trenches parsing deduplicates by caller using actual category names and ignores malformed mints", () => {
  const rows = parseDiscovery({
    new_creation: [
      {
        address: MINT,
        created_timestamp: 1000,
        launchpad_platform: "Future platform",
      },
      { address: "invalid" },
    ],
    pump: [],
    completed: [{ address: MINT }],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.source, "gmgn:Future platform");
  assert.equal(rows[0]?.createdAt, 1000000);
  assert.throws(() => parseDiscovery({ new_creation: [] }));
});
test("market cap derives only from documented price and circulating supply", () => {
  const m = normalizeMarket(info());
  assert.deepEqual(m.marketCap, known(1000000));
  assert.equal(m.windows["5s"], undefined);
  assert.equal(
    normalizeMarket({ price: { price: "1" } }).marketCap.state,
    "UNKNOWN",
  );
});
test("GMGN authorities and listing rug label take precedence over optional metadata", () => {
  let sec = normalizeSecurity(
    { ...securityRaw, renounced_freeze_account: false },
    candidate(),
    settings,
  );
  assert.ok(sec.findings.some((f) => f.level === "CRITICAL"));
  sec = normalizeSecurity(
    securityRaw,
    { ...candidate(), listing: { rug_ratio: 0.99 } },
    settings,
  );
  assert.ok(sec.findings.some((f) => f.code === "GMGN_RUG_RISK"));
  assert.equal(
    normalizeSecurity(securityRaw, candidate(), settings).findings.some(
      (f) => f.code === "HONEYPOT_REPORTED",
    ),
    false,
  );
});
test("high tax is critical; missing authority is UNKNOWN rather than confirmed rug", () => {
  assert.ok(
    normalizeSecurity(
      { ...securityRaw, sell_tax: ".5" },
      candidate(),
      settings,
    ).findings.some((f) => f.code === "EXCESSIVE_TAX"),
  );
  const sec = normalizeSecurity({}, { ...candidate(), listing: {} }, settings);
  assert.equal(
    sec.findings.every((f) => f.level === "UNKNOWN"),
    true,
  );
});
test("holder and creator structural defaults remain optional unknowns", () => {
  const c = candidate(),
    sec = normalizeSecurity(securityRaw, c, settings);
  const i = normalizeIntelligence(
    {
      holder_count: 0,
      stat: { holder_count: 100, creator_hold_rate: 0, top_10_holder_rate: 0 },
    },
    sec,
    c,
  );
  assert.equal(i.holders.count.state, "UNKNOWN");
  assert.equal(i.creator.holdPercent.state, "UNKNOWN");
  assert.equal(i.bundlePercent.state, "UNKNOWN");
  assert.equal(i.dueDiligence.score.state, "UNKNOWN");
});
test("optional holder/dev data never independently blocks KRONOS-approved entry", () => {
  const snap = snapshot();
  snap.intelligence.holders.top10 = unknown();
  snap.intelligence.creator.history = unknown();
  Object.assign(snap.intelligence.creator, {
    knownBadFunding: "UNKNOWN",
    overallRisk: "UNKNOWN",
  });
  assert.equal(risk.evaluate(snap, settings, context).outcome, "BUY");
});
test("critical evidence cannot be overridden by KRONOS BUY", () => {
  const snap = snapshot();
  snap.security.findings.push({
    level: "CRITICAL",
    code: "RUG",
    reason: "GMGN critical risk",
  });
  assert.equal(risk.evaluate(snap, settings, context).outcome, "SKIP_RUG");
});
test("small critical-data list blocks unknown controls without fabricating a rug", () => {
  const snap = snapshot();
  snap.security.freezeRenounced = unknown();
  assert.equal(
    risk.evaluate(snap, settings, context).outcome,
    "SKIP_MISSING_CRITICAL_DATA",
  );
});
test("cheap filters allow low-but-positive liquidity and unknown optional age to reach KRONOS", () => {
  const s = snapshot();
  delete s.candidate.createdAt;
  s.market.liquidity = known(1);
  assert.equal(cheapGuard(s.candidate, s.market, settings).allowed, true);
  assert.equal(risk.evaluate(s, settings, context).outcome, "SKIP_MARKET");
});
test("risk limits and KRONOS decisions produce specific human-readable decisions", () => {
  let s = snapshot();
  s.intelligence.holders.top10 = known(90);
  assert.equal(risk.evaluate(s, settings, context).outcome, "SKIP_RISK");
  s = snapshot();
  s.kronos!.action = "WAIT";
  assert.equal(risk.evaluate(s, settings, context).outcome, "SKIP_RISK");
  s = snapshot();
  s.market.at = 1;
  assert.match(risk.evaluate(s, settings, context).reason, /stale/);
  assert.equal(
    risk.evaluate(snapshot(), settings, { ...context, duplicate: true })
      .allowed,
    false,
  );
  for (const positions of [1, 5, 10, 20, 100])
    assert.equal(
      risk.evaluate(snapshot(), settings, { ...context, positions }).allowed,
      true,
    );
  assert.equal(
    risk.evaluate(snapshot(), settings, { ...context, entriesEnabled: false })
      .allowed,
    false,
  );
});
test("negative PnL and position age never sell; genuine protective exits remain active", () => {
  const p = position();
  assert.equal(
    exitDecision({ ...p, nativeActive: true }, 1n, settings, {})?.reason,
    undefined,
  );
  assert.equal(
    exitDecision({ ...p, nativeActive: true }, 1n, settings, { manual: true })
      ?.sellBps,
    10000,
  );
  assert.equal(
    exitDecision(
      { ...p, nativeActive: true, entryAt: 1 },
      1000000n,
      settings,
      {},
    ),
    undefined,
  );
  for (const value of [950000n, 800000n, 500000n, 1n])
    assert.equal(exitDecision(p, value, settings, {}), undefined);
  assert.match(
    exitDecision(p, 500000n, settings, { critical: true })!.reason,
    /security/,
  );
  assert.match(
    exitDecision({ ...p, initialLiquidity: 10000 }, 500000n, settings, {
      liquidity: 0,
    })!.reason,
    /liquidity/,
  );
  assert.equal(
    exitDecision(p, 2000000n, settings, { smartMoney: true })?.reason,
    undefined,
  );
  assert.equal(
    exitDecision(
      p,
      1000000n,
      { ...settings, smartMoneyExitMode: "EXIT" },
      { smartMoney: true },
    ),
    undefined,
  );
});
test("old strategy stop-loss keys are ignored without retaining a hidden default", () => {
  const current = settingsSchema.parse({
    stopLossBps: 1500,
    stopLossPercent: 20,
    STOP_LOSS: true,
  });
  assert.equal("stopLossBps" in current, false);
  assert.equal("stopLossPercent" in current, false);
  assert.equal("STOP_LOSS" in current, false);
  assert.equal(current.trailingActivationBps, 3000);
});
test("SQLite restart preserves dedupe, BUY intent, open position and entry control", () => {
  const dir = mkdtempSync(join(tmpdir(), "gmgn-v2-"));
  let db: Store | undefined;
  try {
    const path = join(dir, "bot.sqlite");
    db = new Store(path);
    assert.equal(db.discover(candidate()), true);
    assert.equal(
      db.discover({ ...candidate(), source: "gmgn:migrated" }),
      false,
    );
    const i = bindFixtureClaim(
      db,
      risk.approve(snapshot(), settings, context, "demo"),
    );
    db.claim(i);
    db.savePosition({ ...position(), mode: "demo" });
    db.set("newEntriesEnabled", false);
    assert.equal(db.reserved("demo"), 9800000n);
    db.close();
    db = new Store(path);
    assert.equal(db.entriesEnabled(), false);
    assert.equal(db.bought(MINT, "demo"), true);
    assert.equal(db.positions("demo").length, 2);
    assert.throws(() => db!.claim(i));
    assert.equal(
      db.db.prepare("PRAGMA journal_mode").get()?.journal_mode,
      "wal",
    );
  } finally {
    db?.close();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
test("new entry environment override cannot be bypassed by stored settings", () => {
  const before = env.NEW_ENTRIES_ENABLED,
    db = new Store(":memory:");
  try {
    env.NEW_ENTRIES_ENABLED = false;
    db.set("newEntriesEnabled", true);
    assert.equal(db.entriesEnabled(), false);
  } finally {
    env.NEW_ENTRIES_ENABLED = before;
    db.close();
  }
});
