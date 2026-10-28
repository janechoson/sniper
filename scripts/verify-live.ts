import { writeFile, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  loadEnv,
  loadRealConfig,
  chainsFromEnv,
  applyRpcConfiguration,
  productionPriceAllowed,
} from "@sniper/config";
import { TradingWallet, RpcWalletBalanceReader } from "@sniper/wallet";
import {
  JsonRpcClient,
  RpcQuoteUsdPriceProvider,
  RecoveringRpcSocket,
} from "@sniper/chains";
import { JevAIProvider } from "@sniper/ai";

// Chỉ RPC đọc và derive địa chỉ. Không import executor, không gọi sign/send/approve.
const env = loadEnv();
const config = await loadRealConfig(env.REAL_CONFIG_PATH);
const chains = applyRpcConfiguration(chainsFromEnv(env), env).filter(
  (c) => c.enabled,
);
const manager = new TradingWallet(chains, process.env);
const wallets = await manager.list();
const clients = new Map(
  chains.flatMap((c) =>
    c.rpcHttpUrl
      ? [
          [
            c.id,
            new JsonRpcClient(`preflight-${c.id}`, c.rpcHttpUrl, {
              rps: 2,
              concurrency: 1,
              readOnly: true,
            }),
          ] as const,
        ]
      : [],
  ),
);
const balances = new RpcWalletBalanceReader(clients);
const results: Record<string, unknown>[] = [];
const prices = new RpcQuoteUsdPriceProvider(
  new Map(
    chains.flatMap((c) =>
      c.evmChainId
        ? [
            [
              c.id,
              { rpc: clients.get(c.id)!, evmChainId: c.evmChainId },
            ] as const,
          ]
        : [],
    ),
  ),
);
const ai = new JevAIProvider({
  apiKey: env.TYPESAFE_API_KEY,
  model: env.JEV_MODEL,
  timeoutMs: env.JEV_TIMEOUT_MS,
});
const jev = await ai.verify();
const reason = (e: unknown) =>
  e instanceof Error && /^[A-Z0-9_:-]+$/.test(e.message)
    ? e.message
    : "PREFLIGHT_FAILED";
try {
  for (const chain of chains) {
    const rpc = clients.get(chain.id);
    const wallet = wallets.find((w) => w.chains.includes(chain.id));
    const blockers = new Set<string>();
    const item: Record<string, unknown> = {
      chain: chain.id,
      blockers: [],
      walletConfigured: !!wallet,
    };
    if (!wallet) blockers.add("WALLET_UNAVAILABLE");
    try {
      if (!rpc) throw new Error("RPC_UNCONFIGURED");
      const id = await rpc.request(
        chain.type === "evm" ? "eth_chainId" : "getGenesisHash",
        [],
        z.string(),
      );
      const matches =
        chain.type === "evm"
          ? Number(BigInt(id)) === chain.evmChainId
          : id === chain.expectedGenesisHash;
      item.identityMatches = matches;
      if (!matches) throw new Error("RPC_IDENTITY_MISMATCH");
      if (chain.rpcWsUrl) {
        const socket = new RecoveringRpcSocket(
          `preflight-${chain.id}-ws`,
          chain.rpcWsUrl,
          5000,
        );
        try {
          await socket.connect();
          item.websocket = "READY";
        } catch {
          item.websocket = "FAILED";
          if (config.execution.requireWebsocketForLive)
            blockers.add("WS_CONNECT_FAILED");
        } finally {
          await socket.close();
        }
      } else item.websocket = "NOT_CONFIGURED";
      if (wallet) {
        const health = await manager.health(wallet.id, chain.id);
        item.signerStatus = health.status;
        if (health.status !== "READY") blockers.add("SIGNER_UNAVAILABLE");
        const quotes = (config.quotes[chain.id] ?? []).filter(
          (q) => q.type !== "NATIVE",
        );
        try {
          const balance = await balances.read(wallet, chain.id, quotes);
          item.balance = {
            quality: balance.quality,
            nativeAmount: balance.nativeAmount,
            nativeDecimals: balance.nativeDecimals,
            tokens: balance.tokens.map((t) => ({
              symbol: quotes.find((q) => q.address === t.address)?.symbol,
              amount: t.amount,
              decimals: t.decimals,
            })),
          };
          if (balance.quality !== "REAL")
            blockers.add("CAPITAL_BALANCE_UNKNOWN");
          const reserve = config.execution.nativeFeeReserveByChain[chain.id];
          if (!reserve) blockers.add("NATIVE_RESERVE_NOT_CONFIGURED");
          else if (BigInt(balance.nativeAmount) <= BigInt(reserve))
            blockers.add("INSUFFICIENT_NATIVE_RESERVE");
        } catch (e) {
          blockers.add(`BALANCE_${reason(e)}`);
        }
        if (chain.type === "evm") {
          const suggested = BigInt(
            await rpc.request("eth_gasPrice", [], z.string()),
          );
          const gasPrice = `0x${((suggested * 120n + 99n) / 100n).toString(16)}`;
          item.gasPriceWei = BigInt(gasPrice).toString();
          try {
            const result = await rpc.request(
              "eth_simulateV1",
              [
                {
                  blockStateCalls: [
                    {
                      calls: [
                        {
                          from: wallet.address,
                          to: wallet.address,
                          gas: "0x5208",
                          gasPrice,
                          value: "0x0",
                          data: "0x",
                        },
                      ],
                    },
                  ],
                  validation: true,
                },
                "latest",
              ],
              z.array(
                z.object({ calls: z.array(z.object({ status: z.string() })) }),
              ),
            );
            const passed = result[0]?.calls[0]?.status === "0x1";
            item.simulationProbe = passed ? "SELF_CALL_ONLY" : "FAILED";
            if (!passed) blockers.add("STATEFUL_SIMULATION_PROBE_FAILED");
          } catch (e) {
            blockers.add(`SIMULATION_${reason(e)}`);
          }
        }
      }
    } catch (e) {
      blockers.add(reason(e));
    }
    if (chain.type === "evm" && !config.execution.maxGasWeiByChain[chain.id])
      blockers.add("NATIVE_RESERVE_NOT_CONFIGURED");
    if (
      chain.type === "solana" &&
      (!config.execution.solanaMaxFeeLamports ||
        !config.execution.solanaMaxNativeDebitLamports ||
        !config.execution.solanaAllowedAccountOwners.length)
    )
      blockers.add("SOLANA_EXECUTION_POLICY_MISSING");
    const priceResults = await Promise.all(
      (config.quotes[chain.id] ?? []).map((q) => prices.resolve(chain.id, q)),
    );
    item.prices = priceResults
      .filter((q) => q && productionPriceAllowed(chain.id, q))
      .map((q) => q!.priceObservation);
    if (!priceResults.some((q) => q && productionPriceAllowed(chain.id, q)))
      blockers.add("LIVE_QUOTE_ORACLE_CHAIN_UNVERIFIED");
    item.jev = {
      model: env.JEV_MODEL,
      status: jev.status,
      reasons: jev.reasons,
    };
    if (jev.status !== "READY") blockers.add("AI_FAILED");
    try {
      const proof = JSON.parse(
        await readFile(`data/execution-preflight-${chain.id}.json`, "utf8"),
      );
      item.executionPreflight = {
        checkedAt: proof.checkedAt,
        readiness: proof.readiness,
        reasons: proof.reasons,
        historicalEvidenceOnly: true,
      };
    } catch {
      item.executionPreflight = { status: "NOT_RUN" };
    }
    // Không dùng self-call thành bằng chứng sellability của token cần mua.
    blockers.add("CANDIDATE_TOKEN_ROUND_TRIP_REQUIRED");
    blockers.add("MANDATORY_SECURITY_COVERAGE_REQUIRED");
    item.blockers = [...blockers];
    results.push(item);
  }
  const report = {
    checkedAt: new Date().toISOString(),
    ready: results.every((r) => (r.blockers as string[]).length === 0),
    liveReady: false,
    broadcastReady: false,
    confirmationReady: "CANARY_REQUIRED",
    signing: false,
    broadcast: false,
    results,
  };
  await writeFile("data/live-preflight.json", JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = 2;
} finally {
  for (const rpc of clients.values()) rpc.close();
}
