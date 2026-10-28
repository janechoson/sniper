import { z } from "zod";
import type {
  ChainConfig,
  ChainAdapter,
  TokenDiscoveryEvent,
  HealthStatus,
  Unsubscribe,
} from "@sniper/core";
import type { RealConfig, RuntimeEnv } from "@sniper/config";
import type { HolderDataProvider } from "@sniper/features";
import { JsonRpcClient } from "../rpc/http";
import { RecoveringRpcSocket } from "../rpc/ws";
import { SolanaTransactionReader } from "./solana-transaction";
import { PumpMarketReader } from "./pump-market";
import { pumpFamily } from "./pump-discovery";
import { EvmTokenAnalyzer, hexSchema } from "../security/evm";
import { SolanaTokenAnalyzer } from "../security/solana";
import type { DiscoveryCursorStore } from "./evm-discovery";
import { EvmDiscoveryReader } from "./evm-discovery-reader";
import { EvmLaunchDiscovery } from "./evm-launch-discovery";
import { verifyEvmDiscoveryAbis } from "./evm-abi-verification";
import {
  SolanaProgramDiscovery,
  type SolanaSwapObservation,
} from "./solana-discovery";
import { RollingMarketBook, EvmV2MarketReader } from "./market";
import { SolanaPoolMarketReader } from "./solana-market";
import type { QuoteUsdPriceProvider } from "./prices";
import { EvmV3MarketReader } from "./evm-v3-market";
import { EvmSwapObserver } from "./evm-swaps";
import { parseUnitsSafe, toDisplayNumber } from "@sniper/shared";
export class ProductionChainAdapter implements ChainAdapter {
  readonly chainId: string;
  readonly type: "evm" | "solana";
  readonly rpc?: JsonRpcClient;
  private archiveRpc?: JsonRpcClient;
  archiveRpcStats() {
    return this.archiveRpc?.stats();
  }
  readonly evm?: EvmTokenAnalyzer;
  readonly solana?: SolanaTokenAnalyzer;
  private socket?: RecoveringRpcSocket;
  private stopWatch?: Unsubscribe;
  private scannerReasons: string[] = [];
  private readonly solanaWatchers = new Map<string, SolanaProgramDiscovery>();
  private readonly evmWatchers = new Map<string, EvmLaunchDiscovery>();
  evmDiscoveryStats() {
    return Object.fromEntries(
      [...this.evmWatchers].map(([source, watcher]) => [
        `${this.chainId}:${source}`,
        watcher.stats(),
      ]),
    );
  }
  discoveryStats() {
    return Object.fromEntries(
      [...this.solanaWatchers].map(([source, watcher]) => [
        source,
        watcher.stats(),
      ]),
    );
  }
  private subscriptionFailures = new Set<string>();
  private lastHealth: HealthStatus = {
    status: "unconfigured",
    detail: "Chưa kiểm tra kết nối RPC",
    checkedAt: 0,
  };
  peekHealth(): HealthStatus {
    if (this.scannerReasons.length)
      return {
        status: "unhealthy",
        detail: this.scannerReasons.join(", "),
        checkedAt: Date.now(),
      };
    if (
      this.lastHealth.status === "healthy" &&
      Date.now() - this.lastHealth.checkedAt > 60000
    )
      return {
        status: "unhealthy",
        detail: "Đang chờ làm mới trạng thái RPC",
        checkedAt: this.lastHealth.checkedAt,
      };
    return { ...this.lastHealth };
  }
  private readonly observationOnly: boolean;
  readonly book: RollingMarketBook;
  private prices?: QuoteUsdPriceProvider;
  private pumpMarkets?: PumpMarketReader;
  private swaps?: EvmSwapObserver;
  private trackedPools = new Map<string, TokenDiscoveryEvent>();
  private track(event: TokenDiscoveryEvent) {
    if (!this.trackedPools.has(event.poolAddress)) {
      if (this.trackedPools.size >= this.real.maxPools)
        this.trackedPools.delete(this.trackedPools.keys().next().value!);
      this.book.startCompleteStream(
        event.id,
        Math.max(Date.now(), event.chainTimestamp ?? 0),
      );
    }
    this.trackedPools.set(event.poolAddress, event);
  }
  private async observeSolanaSwap(value: SolanaSwapObservation) {
    const event = this.trackedPools.get(value.poolAddress);
    if (!event) return;
    const pair = z
      .object({ mintA: z.string(), mintB: z.string() })
      .parse(event.rawEvent);
    const input = value.inputMint ?? (value.swapForY ? pair.mintA : pair.mintB),
      output = value.outputMint ?? (value.swapForY ? pair.mintB : pair.mintA);
    let side: "BUY" | "SELL", quoteRaw: string;
    if (output === event.tokenAddress && input === event.quoteTokenAddress) {
      side = "BUY";
      quoteRaw = value.amountIn;
    } else if (
      input === event.tokenAddress &&
      output === event.quoteTokenAddress
    ) {
      side = "SELL";
      quoteRaw = value.amountOut;
    } else throw new Error("SWAP_POOL_MINT_MISMATCH");
    const configured = this.real.quotes[this.chainId]?.find(
      (q) => q.address === event.quoteTokenAddress,
    );
    const quote =
      configured && this.prices
        ? await this.prices.resolve(this.chainId, configured)
        : configured;
    const volumeUsd = quote?.usdPrice
      ? toDisplayNumber(
          BigInt(quoteRaw) * parseUnitsSafe(quote.usdPrice, 18),
          quote.decimals + 18,
        )
      : undefined;
    this.book.observe(event.id, {
      at: value.at,
      trade: { id: value.id, side, volumeUsd, quoteAmount: quoteRaw },
    });
  }
  private coverage(dexId: string, through: number, complete: boolean) {
    for (const event of this.trackedPools.values()) {
      if (event.dexId !== dexId) continue;
      if (!complete || !this.book.hasCompleteStream(event.id)) {
        this.book.invalidateStream(event.id);
        this.book.startCompleteStream(event.id, through);
      }
      this.book.advanceStream(event.id, through);
    }
  }
  useQuotePrices(provider: QuoteUsdPriceProvider) {
    this.prices = provider;
    if (this.solana && this.rpc)
      this.pumpMarkets = new PumpMarketReader(
        this.rpc,
        this.real.quotes[this.chainId] ?? [],
        this.book,
        provider,
      );
  }
  async discoveryGuard(event: TokenDiscoveryEvent) {
    const deployment = this.real.deployments.find(
      (d) => d.chainId === event.chainId && d.id === event.dexId && d.enabled,
    );
    if (this.type === "evm") {
      const started = Date.now();
      const fail = (reason: string) => ({
        passed: false,
        reasons: [reason],
        latencyMs: Date.now() - started,
        deferred: true,
      });
      if (!deployment) return fail("DISCOVERY_SOURCE_UNCONFIGURED");
      if (event.pairClassification !== "TRUSTED_QUOTE")
        return fail("DISCOVERY_QUOTE_UNTRUSTED");
      if (
        !["uniswap-v2", "pancakeswap", "uniswap-v3"].includes(deployment.family)
      )
        return fail("DISCOVERY_MARKET_ADAPTER_UNAVAILABLE");
      const quote = this.real.quotes[this.chainId]?.find(
        (q) =>
          q.address.toLowerCase() === event.quoteTokenAddress?.toLowerCase(),
      );
      if (!quote?.usdOracle && !quote?.coinbaseOracle && !quote?.usdPrice)
        return fail("DISCOVERY_QUOTE_USD_UNKNOWN");
      if (
        !/^0x[\da-fA-F]{40}$/.test(event.tokenAddress) ||
        !/^0x[\da-fA-F]{40}$/.test(event.poolAddress)
      )
        return fail("DISCOVERY_MARKET_IDENTITY_INVALID");
      return { passed: true, reasons: [], latencyMs: Date.now() - started };
    }
    if (!deployment || !pumpFamily(deployment.family))
      throw new Error("PUMP_DEPLOYMENT_NOT_CONFIGURED");
    if (!this.pumpMarkets && this.rpc)
      this.pumpMarkets = new PumpMarketReader(
        this.rpc,
        this.real.quotes[this.chainId] ?? [],
        this.book,
        this.prices,
      );
    if (!this.pumpMarkets) throw new Error("PUMP_RPC_UNAVAILABLE");
    return this.pumpMarkets.guard(event, deployment);
  }
  async protocolState(event: TokenDiscoveryEvent) {
    const deployment = this.real.deployments.find(
      (d) => d.chainId === event.chainId && d.id === event.dexId && d.enabled,
    );
    return deployment && pumpFamily(deployment.family) && this.pumpMarkets
      ? this.pumpMarkets.protocol(event, deployment)
      : undefined;
  }
  socketHealth() {
    const health = this.socket?.health() ?? {
      id: `${this.chainId}-ws`,
      status: this.config.rpcWsUrl
        ? ("NOT_STARTED" as const)
        : ("DEGRADED" as const),
      checkedAt: Date.now(),
      reasons: [this.config.rpcWsUrl ? "WS_NOT_STARTED" : "WS_UNCONFIGURED"],
    };
    return this.subscriptionFailures.size
      ? {
          ...health,
          status: "DEGRADED" as const,
          reasons: [
            ...new Set([...health.reasons, ...this.subscriptionFailures]),
          ],
        }
      : health;
  }
  constructor(
    readonly config: ChainConfig,
    private readonly real: RealConfig,
    env: RuntimeEnv,
    private readonly cursors: DiscoveryCursorStore,
    private readonly holders?: HolderDataProvider,
    private readonly onCreator?: (
      event: TokenDiscoveryEvent,
      address: string,
    ) => Promise<void>,
  ) {
    this.chainId = config.id;
    this.observationOnly = env.OBSERVATION_ONLY;
    this.type = config.type;
    this.book = new RollingMarketBook(
      real.maxPools,
      real.maxObservationsPerPool,
    );
    if (config.rpcHttpUrl) {
      this.rpc = new JsonRpcClient(config.id, config.rpcHttpUrl, {
        timeoutMs: env.RPC_TIMEOUT_MS,
        rps: env.RPC_REQUESTS_PER_SECOND,
        concurrency: env.RPC_MAX_CONCURRENCY,
        readOnly:
          env.TRADING_MODE !== "live" ||
          env.LIVE_DRY_RUN ||
          !env.LIVE_TRADING_ACK ||
          !real.execution.liveChains.includes(
            config.id as "solana" | "bnb" | "robinhood",
          ),
      });
      if (this.type === "evm")
        this.evm = new EvmTokenAnalyzer(this.rpc, 30000, env.OBSERVATION_ONLY);
      else this.solana = new SolanaTokenAnalyzer(this.rpc);
    }
  }
  async healthCheck(includeScanner = true): Promise<HealthStatus> {
    const result = await this.performHealthCheck(includeScanner);
    this.lastHealth = result;
    return result;
  }
  private async performHealthCheck(
    includeScanner = true,
  ): Promise<HealthStatus> {
    const at = Date.now();
    if (!this.rpc)
      return {
        status: "unconfigured",
        detail: "Thiếu RPC HTTP",
        checkedAt: at,
      };
    if (this.type === "solana" && !this.config.expectedGenesisHash)
      return {
        status: "unconfigured",
        detail: "Cần SOLANA_EXPECTED_GENESIS_HASH để xác minh mạng",
        checkedAt: at,
      };
    try {
      if (this.type === "evm") {
        const id = BigInt(await this.rpc.request("eth_chainId", [], hexSchema));
        if (id !== BigInt(this.config.evmChainId ?? 0)) throw new Error();
      } else {
        const genesis = await this.rpc.request(
          "getGenesisHash",
          [],
          z.string(),
        );
        if (genesis !== this.config.expectedGenesisHash) throw new Error();
        await this.rpc.request(
          "getSlot",
          [{ commitment: "confirmed" }],
          z.number().int().nonnegative(),
        );
      }
      return {
        status:
          includeScanner && this.scannerReasons.length
            ? "unhealthy"
            : "healthy",
        detail:
          this.scannerReasons.join(", ") ||
          "RPC đã xác minh mạng; dữ liệu thật",
        checkedAt: at,
      };
    } catch {
      return {
        status: "unhealthy",
        detail: "RPC lỗi hoặc danh tính mạng không khớp",
        checkedAt: at,
      };
    }
  }
  async connect() {
    if ((await this.healthCheck(false)).status !== "healthy")
      throw new Error("RPC_NOT_READY");
  }
  async disconnect() {
    await this.stopWatch?.();
    await this.socket?.close();
    this.rpc?.close();
    this.archiveRpc?.close();
  }
  async getTokenInfo(address: string) {
    return (await this.analyze(address)).info;
  }
  async analyzeSecurity(address: string) {
    return (await this.analyze(address)).security;
  }
  private async analyze(address: string) {
    if (this.evm) return this.evm.analyze(address);
    if (this.solana) return this.solana.analyze(address);
    throw new Error("RPC_UNCONFIGURED");
  }
  async getHolders(address: string) {
    return (await this.holders?.getHolderAnalysis(this.chainId, address)) ?? {};
  }
  async getLiquidity(_address: string) {
    return {};
  }
  async market(event: TokenDiscoveryEvent) {
    this.track(event);
    if (!this.rpc) throw new Error("RPC_UNCONFIGURED");
    const deployment = this.real.deployments.find(
      (d) => d.chainId === this.chainId && d.id === event.dexId && d.enabled,
    );
    if (!deployment) throw new Error("DEX_UNCONFIGURED");
    if (pumpFamily(deployment.family)) {
      if (!this.pumpMarkets && this.rpc)
        this.pumpMarkets = new PumpMarketReader(
          this.rpc,
          this.real.quotes[this.chainId] ?? [],
          this.book,
          this.prices,
        );
      if (!this.pumpMarkets) throw new Error("PUMP_RPC_UNAVAILABLE");
      return this.pumpMarkets.market(event, deployment);
    }
    if (this.evm) {
      this.swaps ??= new EvmSwapObserver(this.rpc, this.book, this.cursors);
      const configured = this.real.quotes[this.chainId]?.find(
        (q) =>
          q.address.toLowerCase() === event.quoteTokenAddress?.toLowerCase(),
      );
      const quote =
        configured && this.prices
          ? await this.prices.resolve(this.chainId, configured)
          : configured;
      if (quote?.usdPrice) {
        try {
          await this.swaps.poll(event, deployment, quote);
        } catch {
          this.book.invalidateStream(event.id);
        }
      } else this.book.invalidateStream(event.id);
    }
    if (
      this.evm &&
      (deployment.family === "uniswap-v2" ||
        deployment.family === "pancakeswap")
    )
      return new EvmV2MarketReader(
        this.rpc,
        this.evm,
        this.real.quotes[this.chainId] ?? [],
        this.book,
        this.prices,
      ).refresh(event);
    if (this.evm && deployment.family === "uniswap-v3")
      return new EvmV3MarketReader(
        this.rpc,
        this.evm,
        this.real.quotes[this.chainId] ?? [],
        this.book,
        this.prices,
      ).refresh(event);
    if (this.solana)
      return new SolanaPoolMarketReader(
        this.rpc,
        this.solana,
        deployment,
        this.real.quotes[this.chainId] ?? [],
        this.book,
        this.prices,
      ).refresh(event);
    return {};
  }
  async watchNewTokens(
    callback: (event: TokenDiscoveryEvent) => Promise<void>,
  ): Promise<Unsubscribe> {
    await this.connect();
    await this.stopWatch?.();
    const deployments = this.real.deployments.filter(
      (d) => d.chainId === this.chainId && d.enabled,
    );
    if (deployments.length === 0)
      throw new Error("DEX_DEPLOYMENT_NOT_CONFIGURED");
    const rpc = this.rpc!;
    if (this.evm) verifyEvmDiscoveryAbis();
    const quotes = this.real.quotes[this.chainId] ?? [];
    if (quotes.length === 0) throw new Error("TRUSTED_QUOTE_NOT_CONFIGURED");
    const transactionReader = this.solana
      ? new SolanaTransactionReader(rpc)
      : undefined;
    const archiveUrl = this.real.discoveryArchiveRpcByChain[this.chainId];
    if (this.evm && archiveUrl) {
      this.archiveRpc?.close();
      this.archiveRpc = new JsonRpcClient(
        `${this.chainId}-discovery-archive`,
        archiveUrl,
        { rps: 3, concurrency: 2, readOnly: true },
      );
    }
    const evmReader = this.evm
      ? new EvmDiscoveryReader(rpc, this.archiveRpc, this.config.evmChainId)
      : undefined;
    const scanners = deployments.map((d) =>
      this.type === "evm"
        ? new EvmLaunchDiscovery(
            this.chainId,
            d,
            quotes,
            this.cursors,
            evmReader!,
          )
        : new SolanaProgramDiscovery(
            this.chainId,
            rpc,
            d,
            quotes,
            this.cursors,
            this.onCreator,
            (value) => this.observeSolanaSwap(value),
            (through, complete) => this.coverage(d.id, through, complete),
            { observationOnly: this.observationOnly, transactionReader },
          ),
    );
    let stopped = false;
    this.solanaWatchers.clear();
    this.evmWatchers.clear();
    scanners.forEach((scanner, index) => {
      if (scanner instanceof SolanaProgramDiscovery)
        this.solanaWatchers.set(deployments[index]!.id, scanner);
      if (scanner instanceof EvmLaunchDiscovery)
        this.evmWatchers.set(deployments[index]!.id, scanner);
    });
    let polling = false;
    let subscribing = false;
    let nextSubscriptionAttempt = 0;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (stopped) return;
        const results = await Promise.allSettled(
          scanners.map((s) =>
            s.poll(async (event) => {
              this.track(event);
              await callback(event);
            }),
          ),
        );
        this.scannerReasons = results.flatMap((result, index) =>
          result.status === "rejected"
            ? [
                `DISCOVERY_ERROR:${deployments[index]!.id}:${result.reason instanceof Error && /^[A-Z0-9_:-]+$/.test(result.reason.message) ? result.reason.message : "SCANNER_VALIDATION_FAILED"}`,
              ]
            : [],
        );
        if (results.some((result) => result.status === "rejected"))
          for (const event of this.trackedPools.values())
            this.book.invalidateStream(event.id);
      } finally {
        polling = false;
      }
    };
    const ensureSubscriptions = async () => {
      if (
        stopped ||
        !this.socket ||
        subscribing ||
        Date.now() < nextSubscriptionAttempt
      )
        return;
      subscribing = true;
      nextSubscriptionAttempt = Date.now() + 30000;
      try {
        await Promise.allSettled(
          (this.type === "evm" ? [undefined] : deployments).map(
            async (deployment) => {
              const key = deployment?.id ?? "heads";
              if (subscriptions.has(key)) return;
              const failure = `WS_SUBSCRIPTION_UNAVAILABLE:${key}`;
              this.subscriptionFailures.add(failure);
              try {
                const off =
                  this.type === "evm"
                    ? await this.socket!.subscribe(
                        "eth_subscribe",
                        ["newHeads"],
                        "eth_subscription",
                        "eth_unsubscribe",
                        poll,
                      )
                    : await this.socket!.subscribe(
                        "logsSubscribe",
                        [
                          { mentions: [deployment!.programId] },
                          { commitment: "confirmed" },
                        ],
                        "logsNotification",
                        "logsUnsubscribe",
                        async (value) => {
                          const scanner =
                            scanners[deployments.indexOf(deployment!)];
                          if (scanner instanceof SolanaProgramDiscovery)
                            scanner.hint(value);
                          await poll();
                        },
                      );
                if (stopped) await off();
                else {
                  subscriptions.set(key, off);
                  this.subscriptionFailures.delete(failure);
                }
              } catch {
                /* HTTP vẫn hoạt động; thử đăng ký lại có giới hạn sau 30 giây. */
              }
            },
          ),
        );
      } finally {
        subscribing = false;
      }
    };
    const subscriptions = new Map<string, Unsubscribe>();
    this.subscriptionFailures.clear();
    if (this.config.rpcWsUrl) {
      this.socket = new RecoveringRpcSocket(
        `${this.chainId}-ws`,
        this.config.rpcWsUrl,
        7000,
        async () => {
          for (const scanner of this.evmWatchers.values()) scanner.reconnect();
          await poll();
        },
      );
      await ensureSubscriptions();
    }
    const timer = setInterval(() => {
      void ensureSubscriptions();
      void poll();
    }, 3000);
    await poll();
    const stop = async () => {
      stopped = true;
      clearInterval(timer);
      for (const scanner of scanners) scanner.stop();
      await this.socket?.close();
      this.archiveRpc?.close();
      this.archiveRpc = undefined;
    };
    this.stopWatch = stop;
    return stop;
  }
}
