import { z } from "zod";
export * from "./production";
z.config(z.locales.vi());
export { chainSecurityPolicies, type SecurityPolicy } from "./security-policy";
import type { ChainConfig } from "@sniper/core";
import { loadRuntimeEnv, operationalMode } from "./production";
export const envSchema = z.object({
  STORAGE_DRIVER: z.enum(["sqlite", "journal"]).default("sqlite"),
  SQLITE_PATH: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  DATA_DIRECTORY: z.string().min(1).default("data"),
  ENABLED_CHAINS: z.string().default("solana,bnb,robinhood"),
  SOLANA_RPC_HTTP_URL: z.string().url().optional(),
  BNB_RPC_HTTP_URL: z.string().url().optional(),
  ROBINHOOD_RPC_HTTP_URL: z.string().url().optional(),
  ROBINHOOD_EVM_CHAIN_ID: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),
});
export function loadEnv(
  input: Record<string, string | undefined> = process.env,
) {
  const runtime = loadRuntimeEnv(input);
  return {
    ...envSchema.parse(input),
    ...runtime,
    MODE: operationalMode(runtime),
    DATA_SOURCE:
      runtime.DATA_MODE === "real" ? ("RPC" as const) : ("MOCK" as const),
  };
}
export function chainsFromEnv(env: ReturnType<typeof loadEnv>): ChainConfig[] {
  const enabled = env.ENABLED_CHAINS.split(",");
  return [
    {
      id: "solana",
      name: "Solana",
      type: "solana",
      nativeSymbol: "SOL",
      rpcHttpUrl: env.SOLANA_RPC_HTTP_URL,
      enabled: enabled.includes("solana"),
    },
    {
      id: "bnb",
      name: "BNB Chain",
      type: "evm",
      nativeSymbol: "BNB",
      evmChainId: 56,
      rpcHttpUrl: env.BNB_RPC_HTTP_URL,
      enabled: enabled.includes("bnb"),
    },
    {
      id: "robinhood",
      name: "Robinhood Chain",
      type: "evm",
      nativeSymbol: "UNCONFIGURED",
      evmChainId: env.ROBINHOOD_EVM_CHAIN_ID,
      rpcHttpUrl: env.ROBINHOOD_RPC_HTTP_URL,
      enabled: enabled.includes("robinhood"),
    },
  ];
}
export const settingsSchema = z
  .object({
    activeChain: z.enum(["solana", "bnb", "robinhood"]).default("solana"),
    strategy: z.enum(["new-launch", "momentum"]).default("new-launch"),
    mode: z.literal("PAPER").default("PAPER"),
    // Chỉ giữ USD cố định cho ledger PAPER cũ; production dùng positionSizePercent.
    tradeSizeUsd: z.number().finite().positive().max(1000).default(5),
    positionSizePercent: z.number().finite().gt(0).max(100).default(10),
    maxTradeUsd: z.number().finite().positive().max(1000).default(100),
    minLiquidityUsd: z.number().finite().positive().default(10000),
    minScore: z.number().min(0).max(100).default(60),
    maxSecurityRisk: z.number().min(0).max(100).default(25),
    maxPriceImpactPct: z.number().min(0).max(10).default(2),
    maxTradesPerDay: z.number().int().positive().max(1000).default(30),
    maxDailyLossUsd: z.number().positive().default(200),
    maxPositions: z.number().int().positive().max(100).default(8),
    maxTokenExposureUsd: z.number().positive().default(100),
    maxPortfolioExposureUsd: z.number().positive().default(500),
    maxChainExposureUsd: z
      .record(z.string(), z.number().finite().positive())
      .default({ solana: 250, bnb: 250, robinhood: 250 }),
    maxFailedTransactions: z.number().int().positive().default(3),
    maxTop1Pct: z.number().positive().max(100).default(20),
    maxTaxPct: z.number().min(0).max(100).default(10),
    stopLossPct: z.number().positive().max(90).default(20),
    trailingStopPct: z.number().positive().max(90).default(15),
    maxHoldingSec: z.number().int().positive().default(3600),
    liquidityCollapsePct: z.number().positive().max(100).default(50),
    takeProfit: z
      .array(
        z.object({
          gainPct: z.number().positive(),
          sellPct: z.number().positive().max(100),
        }),
      )
      .min(1)
      .default([
        { gainPct: 30, sellPct: 20 },
        { gainPct: 60, sellPct: 20 },
        { gainPct: 100, sellPct: 30 },
      ]),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.takeProfit.reduce((sum, level) => sum + level.sellPct, 0) > 100)
      ctx.addIssue({
        code: "custom",
        message: "Tổng tỷ lệ chốt lời không được vượt quá 100%",
        path: ["takeProfit"],
      });
    if (
      s.takeProfit.some(
        (level, i) => i > 0 && level.gainPct <= s.takeProfit[i - 1]!.gainPct,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Các mức tăng chốt lời phải được sắp xếp tăng dần",
        path: ["takeProfit"],
      });
  });
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings = (): Settings => settingsSchema.parse({});
export const experimentalChainOverrides: Record<string, Partial<Settings>> = {
  solana: { minLiquidityUsd: 10000 },
  bnb: { minLiquidityUsd: 15000 },
  robinhood: { minLiquidityUsd: 20000 },
};
