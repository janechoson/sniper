import { config, parse } from "dotenv";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
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
    TRADING_MODE: z.enum(["paper", "live"]).default("paper"),
    LIVE_TRADING_ACK: bool.default(false),
    NEW_ENTRIES_ENABLED: bool.default(true),
    GMGN_API_KEY: z.string().default(""),
    GMGN_PRIVATE_KEY: z.string().default(""),
    GMGN_PRIVATE_KEY_PATH: z
      .string()
      .default(join(homedir(), ".config", "gmgn", "keypair.pem"))
      .transform((v) => v || join(homedir(), ".config", "gmgn", "keypair.pem")),
    TYPESAFE_API_KEY: z.string().default(""),
    WALLET_PUBLIC_KEY: z.string().default(""),
    SOLANA_PRIVATE_KEY: z.string().default(""),
    SOLANA_KEYPAIR_PATH: z.string().default(""),
    JUPITER_API_KEY: z.string().default(""),
    JEV_MODEL: z.literal("jev-1.14.0").default("jev-1.14.0"),
    SOLANA_RPC_HTTP: z.url().optional(),
    SOLANA_RPC_WS: z.url().optional(),
    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    DATABASE_PATH: z.string().default("data/bot.sqlite"),
    PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
    SCANNER_ENABLED: bool.default(true),
    SCAN_INTERVAL_MS: z.coerce.number().int().min(10000).default(15000),
    PAPER_INITIAL_SOL: z.coerce.number().positive().default(1),
    OBSERVATION_CYCLES: z.coerce.number().int().min(1).max(20).default(3),
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
              ![
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
      entryStrategy: z.preprocess(
        (value) =>
          value === undefined || value === "STANDARD" || value === "KRONOS"
            ? "FIRST_BUY_WINS"
            : value,
        z.literal("FIRST_BUY_WINS"),
      ),
      positionSizePercent: z
        .number()
        .min(0.01)
        .max(100)
        .multipleOf(0.01)
        .default(1),
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
      jevExitConcurrency: z.number().int().min(1).max(4).default(2),
      jevExitQueueSize: z.number().int().min(20).max(500).default(100),
      jevExitRecheckMs: z.number().int().min(30000).default(60000),
      jevExitMinIntervalMs: z.number().int().min(10000).default(15000),
      jevExitDecisionMaxAgeMs: z.number().int().min(30000).default(120000),
      jevExitMaterialPnlPoints: z.number().positive().default(10),
      jevExitMinConfidence: z.number().min(0).max(1).default(0.6),
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
      jevExitTradeCooldownMs: z
        .number()
        .int()
        .min(15000)
        .max(600000)
        .default(60000),
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
