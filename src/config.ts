import { config } from "dotenv";
import { z } from "zod";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveConfig } from "./live-config.js";
export const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
config({ path: join(ROOT, ".env"), quiet: true });
export function localPath(value: string) {
  const path = resolve(ROOT, value),
    rel = relative(ROOT, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw Error("KRONOS_PATH_OUTSIDE_PROJECT");
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  const actual = realpathSync(parent),
    base = realpathSync(ROOT),
    r = relative(base, actual);
  if (r.startsWith("..") || isAbsolute(r))
    throw Error("KRONOS_SYMLINK_OUTSIDE_PROJECT");
  return path;
}
export function runtimeConfig(input: NodeJS.ProcessEnv = process.env) {
  const mode = input.TRADING_MODE === "live" ? "live" : "paper";
  const port = z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .parse(input.KRONOS_PORT ?? 8793);
  return {
    mode,
    realExecutionEnabled: mode === "live",
    execution: mode === "live" ? liveConfig(input) : undefined,
    dryRun: input.KRONOS_EXECUTION_DRY_RUN === "true",
    port,
    database: localPath(input.KRONOS_DATABASE_PATH ?? "data/kronos.sqlite"),
    runtime: localPath(input.KRONOS_RUNTIME ?? "runtime"),
    logs: localPath(input.KRONOS_LOG_DIR ?? "logs"),
    apiKey: input.KRONOS_GMGN_API_KEY ?? "",
    rpcUrl: input.KRONOS_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  };
}
export const settingsSchema = z
  .object({
    maxAgeSeconds: z.number().positive().default(3600),
    trendingMaxAgeSeconds: z.number().positive().default(2592000),
    minLiquidityUsd: z.number().nonnegative().default(10000),
    criticalRugRatio: z.number().min(0).max(1).default(0.8),
    warningRugRatio: z.number().min(0).max(1).default(0.3),
    maxTaxPercent: z.number().min(0).max(100).default(20),
    maxSnapshotAgeMs: z.number().int().positive().default(45000),
    flowMeaningfulChangePercent: z.number().positive().default(10),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export function defaultSettings(): Settings {
  return settingsSchema.parse(
    JSON.parse(readFileSync(join(ROOT, "config/eligibility.json"), "utf8")),
  );
}
