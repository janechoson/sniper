import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
const url = pathToFileURL(resolve("public/dashboard-statistics.js")).href;
const {
  statisticCount: count,
  statisticLamports: lamports,
  statisticFx: fx,
  statisticMoney: money,
  statisticRatio: ratio,
  statisticModel: model,
} = await import(url);
test("Statistics preserves authoritative ALL win rate including null; no wins/closed rewrite", () => {
  assert.equal(
    model(
      {
        strategyAccounting: { wins: 14, losses: 12, closed: 33 },
        winRate: 14 / 33,
      },
      "ALL",
    ).winRate,
    14 / 33,
  );
  assert.equal(
    model(
      {
        strategyAccounting: { wins: 14, losses: 12, closed: 33 },
        winRate: null,
      },
      "ALL",
    ).winRate,
    null,
  );
});
test("Filtered accounting cannot fabricate discovery, BUY, OPEN, KRONOS, Risk or realized scopes", () => {
  const m = model(
    {
      closed: 33,
      wins: 14,
      losses: 12,
      grossPnlLamports: "100",
      netPnlLamports: "90",
    },
    "KRONOS",
  );
  assert.equal(m.winRate, 14 / 26);
  assert.equal(m.closed, 33);
  for (const key of [
    "discovered",
    "bought",
    "open",
    "calls",
    "buys",
    "allowed",
    "rug",
    "realized",
    "unrealized",
  ])
    assert.equal(m[key], null, key);
});
test("Missing and zero remain distinct with zero denominators and exact zero rates", () => {
  assert.equal(count(null), null);
  assert.equal(count(undefined), null);
  assert.equal(count(""), null);
  assert.equal(count(0), 0);
  assert.equal(ratio(0, 0), null);
  assert.equal(ratio(0, 10), 0);
  assert.equal(ratio(11, 10), null);
  const m = model(
    {
      riskAllow: 0,
      riskReject: 10,
      kronosCalls: 0,
      kronosBuy: 0,
      kronosWait: 0,
      winRate: 0,
      strategyAccounting: {},
    },
    "ALL",
  );
  assert.equal(m.allowRate, 0);
  assert.equal(m.buyRate, null);
  assert.equal(m.winRate, 0);
});
test("Currency formatting preserves exact SOL lamports, signs, fees and current USD", () => {
  assert.deepEqual(money("12500000000", 100), {
    usd: "+$1,250.00",
    sol: "+12.5 SOL",
    tone: "positive",
  });
  assert.deepEqual(money("-640000000", 100), {
    usd: "-$64.00",
    sol: "-0.64 SOL",
    tone: "negative",
  });
  assert.deepEqual(money("579230", 100, false), {
    usd: "$0.06",
    sol: "0.00057923 SOL",
    tone: "neutral",
  });
  assert.equal(money("1", null).sol, "+0.000000001 SOL");
  assert.equal(money("9007199254740993", null).sol, "+9,007,199.254740993 SOL");
  assert.deepEqual(money("0", 100), {
    usd: "$0.00",
    sol: "0 SOL",
    tone: "neutral",
  });
});
test("Unknown net/gross is never zero or recomputed from other scopes", () => {
  const m = model(
    {
      realizedLamports: "10",
      unrealizedLamports: "20",
      strategyAccounting: {
        netPnlLamports: null,
        grossPnlLamports: null,
        feesPaidLamports: "2",
      },
    },
    "ALL",
  );
  assert.equal(m.accounting.netPnlLamports, null);
  assert.equal(m.accounting.grossPnlLamports, null);
  assert.deepEqual(money(m.accounting.netPnlLamports, 100), {
    usd: "—",
    sol: "—",
    tone: "unknown",
  });
});
test("Only fresh, nonfuture, positive shell FX is usable; SOL survives unavailable USD", () => {
  const now = 1000000;
  assert.equal(
    fx({ solPriceUsd: "100", solPriceUpdatedAt: now - 59999 }, now),
    100,
  );
  for (const v of [
    { solPriceUsd: "100", solPriceUpdatedAt: now - 60000 },
    { solPriceUsd: "100", solPriceUpdatedAt: now + 1 },
    { solPriceUsd: null, solPriceUpdatedAt: now },
    { solPriceUsd: "", solPriceUpdatedAt: now },
    { solPriceUsd: 0, solPriceUpdatedAt: now },
  ])
    assert.equal(fx(v, now), null);
  assert.equal(money("1000000000", null).usd, "—");
  assert.equal(money("1000000000", null).sol, "+1 SOL");
});
test("Malformed amounts and unsafe numeric amounts do not turn into known zero", () => {
  for (const v of [
    null,
    undefined,
    "",
    false,
    [],
    "1.2",
    "NaN",
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(lamports(v), null);
});
test("KRONOS/Risk ratios retain valid residual decisions and unknown invalid distributions", () => {
  const m = model(
    {
      kronosCalls: 10,
      kronosBuy: 5,
      kronosWait: 3,
      riskAllow: 2,
      riskReject: 8,
      strategyAccounting: {},
    },
    "ALL",
  );
  assert.equal(m.buyRate, 0.5);
  assert.equal(m.skipRate, 0.3);
  assert.equal(m.otherDecisions, 2);
  assert.equal(m.allowRate, 0.2);
  assert.equal(
    model(
      { kronosCalls: 3, kronosBuy: 4, kronosWait: 2, strategyAccounting: {} },
      "ALL",
    ).otherDecisions,
    null,
  );
});
