import { config, parse } from "dotenv";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { fixedSolLamports } from "./position-sizing.js";
config({ quiet: true });
// Match the official CLI's global GMGN credential precedence without logging values.
const globalFile = join(homedir(), ".config", "gmgn", ".env");
const globalGmgn = existsSync(globalFile)
  ? parse(readFileSync(globalFile))
  : {};
for (const key of ["GMGN_API_KEY", "GMGN_PRIVATE_KEY"])
  if (globalGmgn[key]) process.env[key] = globalGmgn[key];
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
export const env = z
  .object({
    TRADING_MODE: z.enum(["paper", "demo", "live"]).default("demo"),
    LIVE_TRADING_ACK: bool.default(false),
    NEW_ENTRIES_ENABLED: bool.default(true),
    GMGN_API_KEY: z.string().default(""),
    GMGN_PRIVATE_KEY: z.string().default(""),
    GMGN_PRIVATE_KEY_PATH: z
      .string()
      .default(join(homedir(), ".config", "gmgn", "keypair.pem"))
      .transform((v) => v || join(homedir(), ".config", "gmgn", "keypair.pem")),
    WALLET_PUBLIC_KEY: z.string().default(""),
    SOLANA_PRIVATE_KEY: z.string().default(""),
    SOLANA_KEYPAIR_PATH: z.string().default(""),
    JUPITER_API_KEY: z.string().default(""),
    SOLANA_RPC_HTTP: z.url().optional(),
    SOLANA_RPC_WS: z.url().optional(),
    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    DATABASE_PATH: z.string().default("data/bot.sqlite"),
    DATABASE_DIRECTORY:z.string().optional(),
    PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
    SCANNER_ENABLED: bool.default(true),
    SCAN_INTERVAL_MS: z.coerce.number().int().min(10000).default(15000),
    OBSERVATION_CYCLES: z.coerce.number().int().min(1).max(20).default(3),
    AI_GUARD_ENABLED: bool.default(true),
    AI_GUARD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(8000),
    AI_GUARD_PASS_TTL_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
    AI_GUARD_MAX_CONCURRENCY: z.literal("1").default("1"),
    AI_GUARD_MAX_ATTEMPTS: z.literal("1").default("1"),
    AI_GUARD_FAIL_POLICY: z.literal("BLOCK").default("BLOCK"),
    AI_GUARD_COLD_START_POLICY: z.enum(["UNCERTAIN", "BLOCK", "PASS"]).default("UNCERTAIN"),
    AUTO_CHART_LEARNING_ENABLED: bool.default(true),
    AUTO_CHART_LEARNING_DELAY_MS: z.coerce.number().int().min(30000).max(86400000).default(30000),
    AUTO_CHART_LEARNING_MAX_CONCURRENCY: z.literal("1").default("1"),
    AUTO_CHART_LEARNING_MIN_CANDLES: z.coerce.number().int().min(10).max(500).default(30),
    AUTO_CHART_LEARNING_ALLOW_INCOMPLETE: bool.default(true),
    CODEX_MAX_CONCURRENCY: z.literal("1").default("1"),
    CODEX_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(300000).default(30000),
    KNOWLEDGE_VALIDATION_MIN_CASES: z.coerce.number().int().min(30).max(500).default(30),
    KNOWLEDGE_VALIDATION_MIN_POSITIVE: z.coerce.number().int().min(10).max(500).default(10),
    KNOWLEDGE_VALIDATION_MIN_NEGATIVE: z.coerce.number().int().min(10).max(500).default(10),
    KNOWLEDGE_VALIDATION_MIN_PRECISION: z.coerce.number().min(0).max(1).default(0.7),
    KNOWLEDGE_VALIDATION_MIN_RECALL: z.coerce.number().min(0).max(1).default(0.7),
    KNOWLEDGE_VALIDATION_MAX_FALSE_POSITIVE_RATE: z.coerce.number().min(0).max(1).default(0.2),
    KNOWLEDGE_VALIDATION_MAX_ABSTENTION_RATE: z.coerce.number().min(0).max(1).default(0.2),
    KNOWLEDGE_VALIDATION_MIN_PRECISION_LCB: z.coerce.number().min(0).max(1).default(0.4),
    KNOWLEDGE_VALIDATION_MIN_RECALL_LCB: z.coerce.number().min(0).max(1).default(0.4),
    KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT: z.coerce.number().max(0).default(-20),
    KNOWLEDGE_DRIFT_MIN_CASES: z.coerce.number().int().min(5).max(100).default(10),
    KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE: z.coerce.number().min(0).max(1).default(0.3),
  })
  .parse(process.env);
export function gmgnSigningKey() {
  if (env.GMGN_PRIVATE_KEY) return env.GMGN_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (!existsSync(env.GMGN_PRIVATE_KEY_PATH)) return "";
  if (
    process.platform !== "win32" &&
    statSync(env.GMGN_PRIVATE_KEY_PATH).mode & 0o077
  )
    throw new Error("GMGN key file must have mode 0600");
  return (
    readFileSync(env.GMGN_PRIVATE_KEY_PATH, "utf8").match(
      /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/,
    )?.[0] ?? ""
  );
}
export const STRUCTURE_WATCH_MAX_MS = 10 * 60 * 1000;
export const settingsSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              !key.startsWith("jevExit") &&
              ![
                "standardBuysEnabled",
                "entryStrategy",
                "nativeStrategyOrders",
                "maxPositions",
                "maxHoldSeconds",
                "priorityFeeSol",
                "tipFeeSol",
                "stopLossBps",
                "stopLossPercent",
                "stopLossThreshold",
                "STOP_LOSS",
                "STOP_LOSS_PERCENT",
              ].includes(key),
          ),
        )
      : value,
  z
    .object({
      tokenBlacklist: z
        .array(
          z
            .string()
            .trim()
            .refine((value) => {
              try {
                return new PublicKey(value).toBase58() === value;
              } catch {
                return false;
              }
            }, "Địa chỉ token Solana không hợp lệ"),
        )
        .default([])
        .transform((values) => [...new Set(values)]),
      positionSizeMode: z.enum(["PERCENT", "SOL"]).default("PERCENT"),
      positionSizePercent: z
        .number()
        .min(0.01)
        .max(100)
        .multipleOf(0.01)
        .default(1),
      positionSizeSol: z
        .number()
        .refine((value) => {
          try {
            fixedSolLamports(value);
            return true;
          } catch {
            return false;
          }
        }, "SOL must be positive, safely representable and have at most 9 decimal places")
        .default(0.2),
      feeReserveLamports: z.string().regex(/^\d+$/).default("20000000"),
      maxAgeSeconds: z.number().positive().default(3600),
      minLiquidityUsd: z.number().nonnegative().default(10000),
      maxTop1Percent: z.number().min(0).max(100).default(30),
      maxTop10Percent: z.number().min(0).max(100).default(70),
      maxCreatorPercent: z.number().min(0).max(100).default(30),
      criticalRugRatio: z.number().min(0).max(1).default(0.8),
      warningRugRatio: z.number().min(0).max(1).default(0.3),
      maxTaxPercent: z.number().min(0).max(100).default(20),
      maxSnapshotAgeMs: z.number().int().min(5000).max(120000).default(45000),
      maxDecisionPriceMovePercent: z.number().min(0).max(100).default(10),
      slippagePercent: z.number().int().min(1).max(30).default(1),
      paperFeeLamports: z.string().regex(/^\d+$/).default("100000"),
      trailingActivationBps: z.number().int().min(1).max(100000).default(3000),
      trailingStopBps: z.number().int().min(1).max(9999).default(2000),
      liquidityCollapseBps: z.number().int().min(1).max(10000).default(5000),
      takeProfits: z
        .array(
          z.object({
            gainBps: z.number().int().positive(),
            sellBps: z.number().int().min(1).max(10000),
          }),
        )
        .max(8)
        .default([
          { gainBps: 3000, sellBps: 50_00 },
          { gainBps: 7000, sellBps: 10000 },
        ]),
      smartMoneyExitMode: z.enum(["OFF", "WARNING", "EXIT"]).default("WARNING"),
      analysisRefreshMs: z.number().int().min(10000).default(60000),
      intelligenceCacheMs: z.number().int().min(10000).default(60000),
      candidatesPerCycle: z.number().int().min(1).max(20).default(5),
      trendingInterval: z.enum(["1m", "5m", "1h", "6h", "24h"]).default("5m"),
      structureWatchTtlMs: z.preprocess(
        (v) =>
          typeof v === "number" ? Math.min(v, STRUCTURE_WATCH_MAX_MS) : v,
        z
          .number()
          .int()
          .min(60000)
          .max(STRUCTURE_WATCH_MAX_MS)
          .default(STRUCTURE_WATCH_MAX_MS),
      ),
      structureWatchMaxSize: z.number().int().min(1).max(100).default(50),
      structureObservationMs: z
        .number()
        .int()
        .min(10000)
        .max(60000)
        .default(15000),
      structureMaxGapMs: z
        .number()
        .int()
        .min(60000)
        .max(300000)
        .default(120000),
      structureConfirmations: z.number().int().min(2).max(5).default(2),
      gmgnRequestIntervalMs: z.number().int().min(1200).default(2000),
      gmgnBackoffBaseMs: z.number().int().min(1000).default(10000),
      gmgnBackoffMaxMs: z.number().int().min(10000).max(900000).default(300000),
      gmgnQueueMaxSize: z.number().int().min(10).max(500).default(200),
      trendingLimit: z.number().int().min(1).max(100).default(100),
      trendingPollMs: z.number().int().min(30000).default(60000),
      sniperPollMs: z.number().int().min(15000).default(30000),
      trendingFreshMs: z.number().int().min(60000).default(180000),
      trendingMaxAgeSeconds: z.number().int().min(3600).default(2592000),
      trendingPriorityBoost: z.number().min(10).max(100).default(40),
      multiSourcePriorityBoost: z.number().min(1).max(30).default(10),
      candidateAgingPointsPerMinute: z.number().min(1).max(50).default(20),
      sniperMaxWaitMs: z.number().int().min(60000).default(180000),
      sniperWatchReserve: z.number().int().min(1).max(10).default(5),
      trendingAnalysisBurst: z.number().int().min(1).max(10).default(4),
      queueReplacementMargin: z.number().min(1).max(50).default(10),
      exitProbeFeeBudgetLamports: z
        .string()
        .regex(/^[1-9]\d*$/)
        .default("110000"),
      exitProbeEntryBps: z
        .array(
          z
            .number()
            .int()
            .refine((v) => [2000, 5000, 10000].includes(v)),
        )
        .min(1)
        .max(3)
        .default([2000, 5000]),
      exitProbeMinNetLamports: z
        .string()
        .regex(/^[1-9]\d*$/)
        .default("10000"),
      exitProbeMaxImpactPercent: z.number().min(1).max(100).default(15),
      exitProbeMaxAgeMs: z.number().int().min(5000).max(20000).default(15000),
      positionExitProbeMs: z.number().int().min(60000).default(300000),
      positionExitProbeSpacingMs: z.number().int().min(15000).default(30000),
      candidateQueueSize: z.number().int().min(1).max(10).default(10),
      watchMaxSize: z.number().int().min(1).max(100).default(30),
      watchRecheckMs: z.number().int().min(10000).default(60000),
      deferredMaxSize: z.number().int().min(1).max(100).default(20),
      deferredTtlMs: z.number().int().min(10000).default(900000),
      deferredRecheckMs: z.number().int().min(10000).default(60000),
      deferredMaxRechecks: z.number().int().min(1).max(20).default(3),
      tokenFailureThreshold: z.number().int().min(1).max(20).default(3),
      recentRejectTtlMs: z.number().int().min(10000).default(1800000),
      positionRecheckMs: z.number().int().min(10000).default(60000),
      positionCollectorConcurrency: z.number().int().min(1).max(8).default(4),
      gmgnReadConcurrency: z.number().int().min(1).max(4).default(3),
      exitExecutionsPerCycle: z.number().int().min(1).max(5).default(2),
      flowMaxObservations: z.number().int().min(3).max(240).default(120),
      flowHistoryMs: z.number().int().min(60000).max(3600000).default(1800000),
      flowMinObservations: z.number().int().min(3).max(10).default(3),
      flowMinSpanMs: z.number().int().min(10000).max(300000).default(30000),
      flowObservationIntervalMs: z
        .number()
        .int()
        .min(5000)
        .max(60000)
        .default(15000),
      flowMaxTransitions: z.number().int().min(5).max(60).default(30),
      flowRegimeConfirmations: z.number().int().min(1).max(5).default(2),
      flowMeaningfulChangePercent: z.number().min(5).max(50).default(10),
      flowStaleMs: z.number().int().min(30000).max(300000).default(90000),
    })
    .strict(),
);
export type Settings = z.infer<typeof settingsSchema>;
export function defaultSettings() {
  try {
    return settingsSchema.parse(
      JSON.parse(readFileSync("config/strategy.json", "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return settingsSchema.parse({});
    throw e;
  }
}
