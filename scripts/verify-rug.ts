import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import {
  loadEnv,
  chainsFromEnv,
  applyRpcConfiguration,
  loadRealConfig,
  realConfigSchema,
} from "@sniper/config";
import { RealTradingEngine } from "@sniper/engine";
import { MemoryRepository } from "@sniper/storage";
import { LocalWalletManager, EnvironmentSecretProvider } from "@sniper/wallet";
const { values } = parseArgs({
  options: {
    chain: { type: "string" },
    token: { type: "string" },
    pool: { type: "string" },
    external: { type: "boolean" },
    config: { type: "string" },
    save: { type: "string" },
  },
});
if (!values.chain || !values.token)
  throw new Error(
    "Dùng --chain --token, thêm --pool nếu có địa chỉ pool đã xác minh",
  );
const env = loadEnv({
  ...process.env,
  DATA_MODE: "real",
  DATA_SOURCE: "RPC",
  TRADING_MODE: "paper",
  MODE: "PAPER",
  AI_PROVIDER: "jev",
  LIVE_DRY_RUN: "false",
  LIVE_TRADING_ACK: "false",
});
const config = await loadRealConfig(
  values.config ?? env.REAL_CONFIG_PATH,
).catch((error) => {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  return realConfigSchema.parse({ version: 1 });
});
if (values.external)
  config.rugCheck.external = { goplus: true, honeypot: true, rugcheck: true };
const engine = new RealTradingEngine({
  repository: new MemoryRepository(),
  chains: applyRpcConfiguration(chainsFromEnv(env), env),
  env,
  config,
  wallets: new LocalWalletManager([], new EnvironmentSecretProvider([])),
  configurationLoaded: true,
});
try {
  const snapshot = await engine.verifySecurity({
    chainId: values.chain,
    tokenAddress: values.token,
    poolAddress: values.pool,
  });
  if (values.save) {
    if (!/^data[\\/][a-zA-Z0-9_-]+\.json$/.test(values.save))
      throw new Error(
        "Đường dẫn báo cáo phải nằm trong data và kết thúc .json",
      );
    await writeFile(values.save, JSON.stringify(snapshot, null, 2) + "\n");
  }
  process.stdout.write(
    JSON.stringify(
      {
        readOnly: true,
        broadcast: false,
        chainId: snapshot.chainId,
        tokenAddress: snapshot.tokenAddress,
        decision: snapshot.decision,
        completeness: snapshot.dataQuality.completeness,
        unknownFields: snapshot.dataQuality.unknownFields.length,
        providers: snapshot.externalProviders.map((p) => ({
          provider: p.provider,
          status: p.status,
          findings: p.findings.length,
          error: p.error,
        })),
        sources: snapshot.dataQuality.sources,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await engine.shutdown();
}
