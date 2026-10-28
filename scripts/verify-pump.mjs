import { loadEnvFile } from "node:process";
import { writeFile } from "node:fs/promises";
import { loadEnv, loadRealConfig } from "@sniper/config";
import { JsonRpcClient, RpcQuoteUsdPriceProvider } from "@sniper/chains";
import { JupiterSwapProvider } from "@sniper/dex";
import { quoteUnitsForUsd } from "@sniper/shared";
loadEnvFile(".env");
const env = loadEnv();
if (
  env.DATA_MODE !== "real" ||
  env.TRADING_MODE !== "paper" ||
  !env.OBSERVATION_ONLY
)
  throw new Error("REAL_PAPER_OBSERVATION_REQUIRED");
const base = `http://127.0.0.1:${env.PORT}`;
const snapshot = await fetch(base + "/api/snapshot").then((response) =>
  response.json(),
);
if (
  snapshot.liveEnabled ||
  snapshot.executions.length ||
  snapshot.observation?.budgetUsd !== "5"
)
  throw new Error("EXECUTION_MUST_REMAIN_DISABLED");
const history = await fetch(base + "/api/history?limit=200").then((response) =>
  response.json(),
);
const config = await loadRealConfig(env.REAL_CONFIG_PATH);
const solana = env.SOLANA_RPC_HTTP
  ? new JsonRpcClient("pump-verify-solana", env.SOLANA_RPC_HTTP, {
      rps: 1,
      concurrency: 1,
    })
  : undefined;
const bnb = env.BNB_RPC_HTTP
  ? new JsonRpcClient("pump-verify-bnb", env.BNB_RPC_HTTP, {
      rps: 2,
      concurrency: 1,
    })
  : undefined;
const provider = solana
  ? new JupiterSwapProvider(solana, {
      apiKey: env.JUPITER_API_KEY,
      allowedPrograms: config.solana.allowedPrograms,
      maxPriorityFeeLamports: config.solana.maxPriorityFeeLamports,
    })
  : undefined;
const oracle = bnb
  ? new RpcQuoteUsdPriceProvider(
      new Map([["bnb", { rpc: bnb, evmChainId: 56 }]]),
    )
  : undefined;
const result = {
  checkedAt: new Date().toISOString(),
  mode: snapshot.mode,
  liveEnabled: snapshot.liveEnabled,
  budgetUsd: snapshot.observation.budgetUsd,
  executions: snapshot.executions.length,
  discovery: snapshot.discovery,
  solana: snapshot.chains.find((chain) => chain.id === "solana"),
  quotes: {},
};
const safeReason = (error) =>
  error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
    ? error.message
    : "VERIFY_REQUEST_FAILED";
try {
  for (const source of ["pump-fun", "pump-swap"]) {
    const sample = history.records.find(
      (record) =>
        record.event.dexId === source &&
        record.event.pairClassification === "TRUSTED_QUOTE",
    );
    if (!sample) {
      result.quotes[source] = {
        status: "NOT_OBSERVED",
        reason: "Chưa có candidate quote tin cậy trong 200 bản ghi gần nhất.",
      };
      continue;
    }
    const quoteAsset = config.quotes.solana?.find(
      (asset) => asset.address === sample.event.quoteTokenAddress,
    );
    let stage = "QUOTE_USD_PRICE";
    try {
      const priced =
        oracle && quoteAsset
          ? await oracle.resolve("solana", quoteAsset)
          : undefined;
      if (!priced?.usdPrice || !provider || !solana)
        throw new Error("QUOTE_USD_OR_PROVIDER_UNAVAILABLE");
      const { SolanaTokenAnalyzer } = await import("@sniper/chains");
      stage = "TOKEN_INFO";
      const token = await new SolanaTokenAnalyzer(solana).analyze(
        sample.event.tokenAddress,
      );
      if (token.info.decimals === undefined)
        throw new Error("TOKEN_DECIMALS_UNKNOWN");
      stage = "BUY_QUOTE";
      const buy = await provider.getQuote({
        chainId: "solana",
        tokenIn: priced.address,
        tokenOut: sample.event.tokenAddress,
        amountIn: quoteUnitsForUsd(
          snapshot.observation.budgetUsd,
          priced.usdPrice,
          priced.decimals,
        ).toString(),
        decimalsIn: priced.decimals,
        decimalsOut: token.info.decimals,
        slippageBps: config.maxSlippageBps,
      });
      stage = "SELL_QUOTE";
      const sell = await provider.getQuote({
        chainId: "solana",
        tokenIn: sample.event.tokenAddress,
        tokenOut: priced.address,
        amountIn: buy.minimumAmountOut,
        decimalsIn: token.info.decimals,
        decimalsOut: priced.decimals,
        slippageBps: config.maxSlippageBps,
      });
      result.quotes[source] = {
        status: "BUY_AND_SELL_QUOTED",
        token: sample.event.tokenAddress,
        provider: buy.providerId,
        slippageBps: config.maxSlippageBps,
        buyAmountIn: buy.amountIn,
        buyMinimumOut: buy.minimumAmountOut,
        sellMinimumOut: sell.minimumAmountOut,
        buyImpactPct: buy.priceImpactPct ?? null,
        sellImpactPct: sell.priceImpactPct ?? null,
        sellability: "UNKNOWN",
        note: "Chỉ báo giá; không build, ký, mô phỏng stateful hoặc broadcast transaction.",
      };
    } catch (error) {
      result.quotes[source] = {
        status: "UNAVAILABLE",
        token: sample.event.tokenAddress,
        reason: `${stage}:${error?.name === "ZodError" ? "SCHEMA_VALIDATION_FAILED" : safeReason(error)}`,
        ...(error?.name === "ZodError"
          ? {
              issues: error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path,
              })),
            }
          : {}),
        sellability: "UNKNOWN",
      };
    }
  }
} finally {
  provider?.close();
  solana?.close();
  bnb?.close();
}
await writeFile(
  "data/pump-paper-verification.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
