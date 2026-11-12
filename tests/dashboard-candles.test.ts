import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createChartSelection,
  normalizeM1Candles,
} from "../public/dashboard-core.js";

const publicFile = (name: string) =>
  fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const candle = (minute: number, close = minute + 1, volumeUsd: number | null = 12) => ({
  at: 1_800_000_000_000 + minute * 60_000,
  open: close - 0.5,
  high: close + 1,
  low: close - 1,
  close,
  volumeUsd,
});

test("chart uses the latest 60 normalized M1 candles only", () => {
  const candles = normalizeM1Candles(
    Array.from({ length: 70 }, (_, index) => candle(index)),
    60,
  );
  assert.equal(candles.length, 60);
  assert.equal(candles[0]!.at, candle(10).at);
  assert.equal(candles.at(-1)?.at, candle(69).at);
  assert.equal(candles.at(-1)?.close, candle(69).close);
});

test("out of order and duplicate timestamps are sorted and deduplicated", () => {
  const later = candle(2, 20);
  const candles = normalizeM1Candles([candle(3), later, candle(1), candle(2, 30)]);
  assert.deepEqual(candles.map((item) => item.at), [candle(1).at, later.at, candle(3).at]);
  assert.equal(candles[1]!.close, 30);
});

test("short and gapped history stays short and keeps genuine null volume", () => {
  const sparse = [candle(0, 1, null), candle(3, 4, 0)];
  const candles = normalizeM1Candles(sparse);
  assert.equal(candles.length, 2);
  assert.equal(candles[0]!.volumeUsd, null);
  assert.equal(candles[1]!.volumeUsd, 0);
  assert.deepEqual(candles.map((item) => item.at), sparse.map((item) => item.at));
});

test("invalid candle values are omitted without inventing replacements", () => {
  const candles = normalizeM1Candles([
    candle(0),
    { ...candle(1), high: Number.NaN },
    { ...candle(2), at: null },
    { ...candle(3), volumeUsd: -1 },
  ]);
  assert.deepEqual(candles, normalizeM1Candles([candle(0)]));
});

test("manual selection disables auto-follow until the user toggles it back", () => {
  const selection = createChartSelection();
  assert.equal(selection.observe("mint-a"), "mint-a");
  assert.equal(selection.select("mint-old"), "mint-old");
  assert.equal(selection.observe("mint-b"), "mint-old");
  assert.equal(selection.following, false);
  assert.equal(selection.toggle(), true);
  assert.equal(selection.selectedMint, "mint-b");
});

test("overview exposes existing M1 snapshots without chart market-data requests", () => {
  const overview = readFileSync(publicFile("dashboard-overview.js"), "utf8");
  const chartData = readFileSync(publicFile("dashboard-core.js"), "utf8");
  assert.match(overview, /summaries\?\.history|summaries\.history/);
  assert.match(overview, /ctx\.poll\(refresh, 1000\)/);
  assert.doesNotMatch(chartData, /fetch\s*\(|GMGN|DexScreener|Birdeye|Jupiter|GeckoTerminal/);
  assert.doesNotMatch(overview, /fetch\s*\(|marketHistory\s*\(/);
});

test("overview keeps five KPIs, central chart, compact KRONOS and one bottom Positions panel", () => {
  const html = readFileSync(publicFile("index.html"), "utf8");
  const overview = html.match(/<template id="page-overview"\s*>([\s\S]*?)<\/template>/)?.[1] || "";
  assert.equal((overview.match(/class="overview-kpi"/g) || []).length, 5);
  assert.match(overview, /id="scannerRecentList"/);
  assert.match(overview, /id="m1Chart"/);
  assert.match(overview, /class="terminal-panel kronos-evaluation/);
  assert.equal((overview.match(/class="terminal-panel overview-positions"/g) || []).length, 1);
  assert.ok(overview.indexOf("class=\"terminal-panel overview-positions\"") > overview.indexOf("id=\"m1Chart\""));
  assert.doesNotMatch(overview, /AI Learning|Recent Logs/);
});
