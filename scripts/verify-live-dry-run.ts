import { writeFile, appendFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import {
  recoverTransactionAddress,
  type Address,
  type TransactionSerialized,
} from "viem";
import {
  loadEnv,
  loadRealConfig,
  chainsFromEnv,
  applyRpcConfiguration,
  defaultSettings,
  productionPriceAllowed,
} from "@sniper/config";
import {
  JsonRpcClient,
  RpcQuoteUsdPriceProvider,
  EvmTokenAnalyzer,
  SolanaTokenAnalyzer,
  RpcHolderDataProvider,
} from "@sniper/chains";
import {
  TradingWallet,
  RpcWalletBalanceReader,
  LocalEvmSigner,
  LocalSolanaSigner,
} from "@sniper/wallet";
import { EvmRouterSwapProvider, JupiterSwapProvider } from "@sniper/dex";
import { AtomicRouteEngine } from "@sniper/routing";
import {
  EvmRoundTripSimulator,
  SolanaRoundTripSimulator,
} from "@sniper/execution";
import { JevAIProvider } from "@sniper/ai";
import { tokenStateSchema } from "@sniper/core";
import { hardFilter } from "@sniper/risk";
import { formatUnitsSafe } from "@sniper/shared";
import { sizeEntry } from "../packages/engine/src/position-sizing";
import {
  deriveReadiness,
  type Capability,
} from "../packages/execution/src/readiness";
import { liquidNativeCandidate } from "./preflight-candidate";

// No executor/intent authority; this is not a strategy-approved trading decision.
const env = loadEnv();
if (env.TRADING_MODE !== "live_dry_run" || env.LIVE_TRADING_ACK)
  throw Error("DRY_RUN_MODE_REQUIRED");
const config = await loadRealConfig(env.REAL_CONFIG_PATH);
const chains = applyRpcConfiguration(chainsFromEnv(env), env).filter(
  (c) => c.enabled,
);
const wallets = new TradingWallet(chains, process.env);
const clients = new Map(
  chains
    .filter((c) => c.rpcHttpUrl)
    .map((c) => [
      c.id,
      new JsonRpcClient(`execution-preflight-${c.id}`, c.rpcHttpUrl!, {
        rps: 5,
        concurrency: 3,
        timeoutMs: 15000,
        readOnly: true,
      }),
    ]),
);
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
const report: Record<string, unknown>[] = [];
const ai = new JevAIProvider({
  apiKey: env.TYPESAFE_API_KEY,
  model: env.JEV_MODEL,
  timeoutMs: env.JEV_TIMEOUT_MS,
});
const jev = await ai.verify();
const selected = process.argv[2];
try {
  for (const chain of chains.filter((c) => !selected || c.id === selected)) {
    const capabilities: Partial<Record<Capability, boolean>> = {
      CONFIG_READY: true,
      JEV_READY: jev.status === "READY",
    };
    const reasons: string[] = [];
    const row: Record<string, unknown> = {
      checkedAt: new Date().toISOString(),
      kind: "EXECUTION_PREFLIGHT",
      chain: chain.id,
      strategyApproved: false,
      broadcast: "LOCKED",
      confirmation: "CANARY_REQUIRED",
      capabilities,
      reasons,
    };
    const rpc = clients.get(chain.id)!;
    let closeProvider: () => void = () => {};
    try {
      const wallet = (await wallets.list()).find((w) =>
        w.chains.includes(chain.id),
      );
      if (!wallet) throw Error("WALLET_UNAVAILABLE");
      capabilities.WALLET_READY = true;
      const identity = await rpc.request(
        chain.type === "evm" ? "eth_chainId" : "getGenesisHash",
        [],
        z.string(),
      );
      if (
        chain.type === "evm"
          ? BigInt(identity) !== BigInt(chain.evmChainId!)
          : identity !== chain.expectedGenesisHash
      )
        throw Error("RPC_IDENTITY_MISMATCH");
      capabilities.RPC_READY = true;
      const signer = await wallets.signer(wallet.id, chain.id);
      capabilities.SIGNER_READY =
        (await wallets.health(wallet.id, chain.id)).status === "READY";
      let balance = await new RpcWalletBalanceReader(clients).read(
        wallet,
        chain.id,
        [],
      );
      if (balance.quality !== "REAL") throw Error("BALANCE_UNKNOWN");
      capabilities.BALANCE_READY = true;
      const wrapped = config.quotes[chain.id]?.find(
        (q) => q.type === "WRAPPED_NATIVE",
      );
      const configured =
        chain.type === "solana"
          ? config.quotes.solana?.find((q) => q.type === "NATIVE")
          : config.quotes[chain.id]?.find((q) => q.type === "NATIVE");
      if (!configured) throw Error("NATIVE_ASSET_UNCONFIGURED");
      let priced = await prices.resolve(chain.id, configured);
      if (!priced?.usdPrice || !productionPriceAllowed(chain.id, priced))
        throw Error("PRICE_REFERENCE_INVALID");
      capabilities.PRICE_READY = true;
      row.price = priced.priceObservation;
      const reserve = config.execution.nativeFeeReserveByChain[chain.id];
      if (!reserve) throw Error("NATIVE_RESERVE_NOT_CONFIGURED");
      row.nativeBalanceRaw = balance.nativeAmount;
      row.nativeFeeReserveRaw = reserve;
      const settings = defaultSettings();
      const sizingInput = {
        percent: settings.positionSizePercent,
        tokenIn: configured.address,
        balanceRaw: BigInt(balance.nativeAmount),
        reservedRaw: 0n,
        nativeBalanceRaw: BigInt(balance.nativeAmount),
        nativeReserveRaw: BigInt(reserve),
        spendsNative: true,
        decimals: configured.decimals,
        quoteUsd: priced.usdPrice,
        observedAt: balance.observedAt,
        maxTradeUsd: settings.maxTradeUsd,
        maxTokenExposureUsd: settings.maxTokenExposureUsd,
      };
      let sizing = sizeEntry(sizingInput);
      capabilities.SIZING_READY = true;
      capabilities.FEE_RESERVE_READY = true;
      row.sizing = sizing;
      let candidate:
        | { address: string; symbol: string; decimals: number; pool?: string }
        | undefined = config.quotes[chain.id]?.find(
        (q) =>
          q.type !== "NATIVE" &&
          q.type !== "WRAPPED_NATIVE" &&
          q.address !== configured.address &&
          (q.symbol === "USDC" || q.symbol === "USDT" || q.symbol === "USDG"),
      );
      if (chain.id === "robinhood" && wrapped) {
        const d = config.deployments.find(
          (d) =>
            d.chainId === chain.id &&
            d.routerAddress &&
            d.enabled &&
            !d.discoveryOnly,
        );
        if (d?.factoryAddress)
          candidate = await liquidNativeCandidate(
            rpc,
            d.factoryAddress as Address,
            wrapped.address as Address,
            BigInt(sizing.amountIn),
            z.coerce
              .number()
              .int()
              .min(0)
              .max(4)
              .parse(process.argv[3] ?? 0),
            process.argv.find((a) => a.startsWith("--token="))?.slice(8) as
              Address | undefined,
          );
      }
      if (!candidate) throw Error("PREFLIGHT_LIQUID_ASSET_UNCONFIGURED");
      row.candidate = {
        ...candidate,
        token: candidate.address,
        symbol: candidate.symbol,
        purpose: "EXECUTION_PREFLIGHT",
      };
      const provider =
        chain.type === "solana"
          ? new JupiterSwapProvider(rpc, {
              apiKey: env.JUPITER_API_KEY,
              allowedPrograms: config.solana.allowedPrograms,
              dexes: config.solana.allowedDexes,
              maxPriorityFeeLamports: config.solana.maxPriorityFeeLamports,
              quoteTtlMs: config.quoteTtlMs,
            })
          : (() => {
              const d = config.deployments.find(
                (d) =>
                  d.chainId === chain.id &&
                  d.enabled &&
                  !d.discoveryOnly &&
                  d.routerAddress &&
                  d.factoryAddress &&
                  (d.family === "pancakeswap" || d.family === "uniswap-v2"),
              );
              if (!d || !wrapped) throw Error("NATIVE_VENUE_NOT_VERIFIED");
              return new EvmRouterSwapProvider(rpc, {
                id: d.id,
                chainId: chain.id,
                evmChainId: chain.evmChainId!,
                family: "v2",
                router: d.routerAddress as Address,
                factory: d.factoryAddress as Address,
                wrappedNative: wrapped.address as Address,
                quoteTtlMs: config.quoteTtlMs,
              });
            })();
      if (provider instanceof JupiterSwapProvider)
        closeProvider = () => provider.close();
      if ((await provider.healthCheck()).status !== "READY")
        throw Error("NATIVE_VENUE_NOT_VERIFIED");
      capabilities.NATIVE_ROUTE_READY = true;
      balance = await new RpcWalletBalanceReader(clients).read(
        wallet,
        chain.id,
        [],
      );
      priced = await prices.resolve(chain.id, configured);
      if (
        balance.quality !== "REAL" ||
        !priced?.usdPrice ||
        !productionPriceAllowed(chain.id, priced)
      )
        throw Error("CAPITAL_OR_PRICE_STALE");
      sizing = sizeEntry({
        ...sizingInput,
        balanceRaw: BigInt(balance.nativeAmount),
        nativeBalanceRaw: BigInt(balance.nativeAmount),
        quoteUsd: priced.usdPrice,
        observedAt: balance.observedAt,
      });
      row.sizing = sizing;
      row.price = priced.priceObservation;
      const routes = new AtomicRouteEngine([provider]);
      let trip = await routes.roundTrip(
        {
          chainId: chain.id,
          tokenIn: configured.address,
          tokenOut: candidate.address,
          amountIn: sizing.amountIn,
          decimalsIn: configured.decimals,
          decimalsOut: candidate.decimals,
          slippageBps: config.maxSlippageBps,
          nativeInput: true,
          walletAddress: wallet.address,
        },
        settings.maxPriceImpactPct,
      );
      capabilities.QUOTE_READY = true;
      capabilities.REVERSE_QUOTE_READY = !!trip.sell;
      row.quotes = { buy: trip.buy, sell: trip.sell };
      if (!trip.sell) throw Error("REVERSE_ROUTE_UNAVAILABLE");
      const tx = await provider.buildSwap(trip.buy, wallet.address);
      capabilities.BUILD_TX_READY = true;
      if (chain.type === "solana") {
        if (
          !config.execution.solanaMaxFeeLamports ||
          !config.execution.solanaMaxNativeDebitLamports
        )
          throw Error("SOLANA_FEE_POLICY_MISSING");
        trip = await new SolanaRoundTripSimulator(rpc, {
          genesisHash: chain.expectedGenesisHash!,
          allowedPrograms: config.solana.allowedPrograms,
          allowedAccountOwners: config.execution.solanaAllowedAccountOwners,
          maxFeeLamports: BigInt(config.execution.solanaMaxFeeLamports),
          maxNativeDebitLamports: BigInt(
            config.execution.solanaMaxNativeDebitLamports,
          ),
        }).simulate(trip, wallet.address, provider, provider, {
          nativeUsd: priced.usdPrice,
          quoteUsd: priced.usdPrice,
        });
      } else
        trip = await new EvmRoundTripSimulator(rpc, chain.evmChainId!).simulate(
          trip,
          wallet.address as Address,
          provider,
          provider,
          { nativeUsd: priced.usdPrice, quoteUsd: priced.usdPrice },
        );
      row.roundTrip = trip;
      capabilities.ROUND_TRIP_READY =
        trip.evidence === "TRANSACTION_SIMULATION" &&
        trip.sellability === "SELLABLE";
      capabilities.SIMULATION_READY = capabilities.ROUND_TRIP_READY;
      // Do not sign a funded wallet swap until simulation has proved the route.
      if (!capabilities.SIMULATION_READY)
        throw Error(trip.reasons[0] ?? "SIMULATION_FAILED");
      const currentBalance = await new RpcWalletBalanceReader(clients).read(
        wallet,
        chain.id,
        [],
      );
      if (
        currentBalance.quality !== "REAL" ||
        currentBalance.nativeAmount !== sizing.balanceRaw
      )
        throw Error("CAPITAL_CHANGED_REQUOTE_REQUIRED");
      if (tx.validUntil <= Date.now())
        throw Error("PREFLIGHT_TRANSACTION_EXPIRED");
      if (tx.family === "solana" && signer instanceof LocalSolanaSigner) {
        const unsigned = VersionedTransaction.deserialize(
          Buffer.from(tx.transactionBase64, "base64"),
        );
        signer.sign(unsigned);
        const publicKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            new PublicKey(wallet.address).toBuffer(),
          ]),
          format: "der",
          type: "spki",
        });
        capabilities.SIGNING_READY = verify(
          null,
          unsigned.message.serialize(),
          publicKey,
          unsigned.signatures[0]!,
        );
      } else if (tx.family === "evm" && signer instanceof LocalEvmSigner) {
        const gasPrice = BigInt(
          await rpc.request("eth_gasPrice", [], z.string()),
        );
        const maxGas = config.execution.maxGasWeiByChain[chain.id];
        if (!maxGas) throw Error("GAS_CAP_MISSING");
        const estimated = BigInt(
          await rpc.request(
            "eth_estimateGas",
            [
              {
                from: wallet.address,
                to: tx.to,
                data: tx.data,
                value: `0x${BigInt(tx.value).toString(16)}`,
              },
            ],
            z.string(),
          ),
        );
        const gas = (estimated * 120n + 99n) / 100n;
        if (gas * gasPrice > BigInt(maxGas)) throw Error("GAS_BUDGET_EXCEEDED");
        const nonce = Number(
          BigInt(
            await rpc.request(
              "eth_getTransactionCount",
              [wallet.address, "pending"],
              z.string(),
            ),
          ),
        );
        const raw = await signer.sign({
          type: "legacy",
          chainId: chain.evmChainId!,
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          gas,
          gasPrice,
          nonce,
        });
        capabilities.SIGNING_READY =
          (
            await recoverTransactionAddress({
              serializedTransaction: raw as TransactionSerialized,
            })
          ).toLowerCase() === wallet.address.toLowerCase();
      }
      capabilities.JEV_READY = jev.status === "READY";
      row.jev = {
        model: env.JEV_MODEL,
        status: jev.status,
        reasons: jev.reasons,
      };
      // Preflight is deliberately not a security/risk approval for a discovered token.
      const security =
        chain.type === "solana"
          ? await new SolanaTokenAnalyzer(rpc).analyze(candidate.address)
          : await new EvmTokenAnalyzer(rpc).analyze(candidate.address);
      row.security = security;
      const holderProvider = new RpcHolderDataProvider(
        new Map([
          [
            chain.id,
            {
              type: chain.type,
              rpc,
              solana:
                chain.type === "solana"
                  ? new SolanaTokenAnalyzer(rpc)
                  : undefined,
            },
          ],
        ]),
      );
      const holders = await holderProvider
        .getHolderAnalysis(chain.id, candidate.address)
        .catch(() => {
          row.holderStatus = "UNKNOWN_RPC_UNAVAILABLE";
          return {};
        });
      const tokenUnits = Number(
        formatUnitsSafe(BigInt(trip.buy.expectedAmountOut), candidate.decimals),
      );
      const quotePrice = Number(sizing.costUsd) / tokenUnits;
      const state = tokenStateSchema.parse({
        identity: {
          chainId: chain.id,
          address: candidate.address,
          symbol: candidate.symbol,
          source: "RPC",
        },
        observedAt: Date.now(),
        market: {
          ...(Number.isFinite(quotePrice) && quotePrice > 0
            ? { priceUsd: quotePrice }
            : {}),
        },
        holders,
        creator: {},
        security: security.security,
        quality: {
          "market.priceUsd": {
            quality: "REAL",
            source: "EXECUTION_PREFLIGHT_BUY_QUOTE",
            observedAt: trip.buy.quotedAt,
          },
        },
      });
      const hard = hardFilter(state, settings);
      row.risk = {
        hardFilter: hard,
        portfolio: "NOT_EVALUATED",
        strategyApproved: false,
      };
      row.holders = holders;
      const candidateAI = await ai.classify(state);
      row.jev = {
        provider: "jev",
        model: candidateAI.model,
        action: candidateAI.action,
        latencyMs: candidateAI.latencyMs,
        purpose: "EXECUTION_PREFLIGHT",
        health: ai.healthCheck(),
      };
      capabilities.JEV_READY = ai.healthCheck().status === "READY";
      capabilities.SECURITY_READY = hard.passed;
      capabilities.RISK_READY = false;
      reasons.push("STRATEGY_SECURITY_AND_RISK_APPROVAL_REQUIRED");
      if (
        trip.roundTripLossPct === undefined ||
        trip.roundTripLossPct > config.maxRoundTripLossPct
      )
        reasons.push("ROUND_TRIP_LOSS_EXCEEDS_POLICY_OR_UNKNOWN");
    } catch (e) {
      reasons.push(
        e instanceof Error && /^[A-Z0-9_:-]+$/.test(e.message)
          ? e.message
          : "EXECUTION_PREFLIGHT_FAILED",
      );
    } finally {
      capabilities.JEV_READY = ai.healthCheck().status === "READY";
      closeProvider();
    }
    row.completedAt = new Date().toISOString();
    row.readiness = deriveReadiness(capabilities);
    report.push(row);
    await appendFile(
      "data/execution-preflight-history.jsonl",
      JSON.stringify(row) + "\n",
    );
    await writeFile(
      `data/execution-preflight-${chain.id}.json`,
      JSON.stringify(row, null, 2),
    );
    console.log(
      JSON.stringify({ chain: chain.id, readiness: row.readiness, reasons }),
    );
  }
  process.exitCode = report.some(
    (r) =>
      !(r.readiness as ReturnType<typeof deriveReadiness>)
        .executionPreflightReady,
  )
    ? 2
    : 0;
  await writeFile(
    "data/execution-preflight.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        kind: "EXECUTION_PREFLIGHT",
        mode: "LIVE_DRY_RUN",
        broadcasts: 0,
        report,
      },
      null,
      2,
    ),
  );
} finally {
  for (const rpc of clients.values()) rpc.close();
}
