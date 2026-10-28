import { randomUUID } from "node:crypto";
import {
  DiscoveryMonitor,
  hasRecordedTokenEntry,
  latestUniqueCandidates,
} from "./discovery-monitor";
import { ObservationBook } from "./observation-book";
import { analyzeObservation } from "./observation-analysis";
import { z } from "zod";
import {
  EventBus,
  tokenDiscoveryEventSchema,
  type CandidateRecord,
  type ChainConfig,
  type DashboardSnapshot,
  type DomainEvent,
  type TokenDiscoveryEvent,
  type LiveReadiness,
  type SwapProvider,
  type ApprovedTradeIntent,
  type RoundTripResult,
  type RugCheckSnapshot,
  type TokenSecurityProvider,
  rugPolicySchema,
  rugSnapshotSchema,
  securityRequestSchema,
} from "@sniper/core";
import {
  defaultSettings,
  settingsSchema,
  operationalMode,
  productionPriceAllowed,
  type Settings,
  type RealConfig,
  type RuntimeEnv,
  type TrustedQuoteAsset,
} from "@sniper/config";
import {
  ProductionChainAdapter,
  JournalCursorStore,
  RpcHolderDataProvider,
  SolanaTokenAnalyzer,
  RpcQuoteUsdPriceProvider,
  OnChainSecurityProvider,
  OnChainHolderSecurityProvider,
  OnChainLiquiditySecurityProvider,
  SolanaLiquiditySecurityProvider,
} from "@sniper/chains";
import {
  InternalCreatorHistoryProvider,
  CompositeHolderDataProvider,
  RugCheckEngine,
  ExternalSecurityProvider,
  CreatorIntelligenceProvider,
  InternalHolderClusterProvider,
  refreshRugSnapshot,
  measured,
  applyRugTrading,
} from "@sniper/features";
import { JevAIProvider, JevRiskClassifier } from "@sniper/ai";
import { EvmRouterSwapProvider, JupiterSwapProvider } from "@sniper/dex";
import { AtomicRouteEngine } from "@sniper/routing";
import { TradeIntentAuthority, hardFilter, decideRugCheck } from "@sniper/risk";
import {
  DurableExecutionStore,
  RealPaperExecutor,
  EvmLiveExecutor,
  EvmRoundTripSimulator,
  SolanaLiveExecutor,
  SolanaRoundTripSimulator,
} from "@sniper/execution";
import { AtomicPositionManager, evaluateAtomicExit } from "@sniper/positions";
import {
  LocalWalletManager,
  RpcWalletBalanceReader,
  TradingWallet,
} from "@sniper/wallet";
import {
  quoteUnitsForUsd,
  ratioToNumber,
  formatUnitsSafe,
  KeyedLock,
} from "@sniper/shared";
import type { Repository } from "@sniper/storage";
import { BoundedQueue, SerialQueue } from "./queue";
import { sizeEntry } from "./position-sizing";
import { candidateSchema } from "./schemas";
import { analyzeCandidate } from "./analyzer";
import { ProductionFeatureEngine } from "./real-features";
import { valuePortfolio } from "./real-accounting";
import { RealObservationService } from "./real-observations";
import { strategyAnalytics } from "./analytics";
import { TokenSecurityWorkflow } from "./rug-workflow";
import { rugAnalytics, securityReadiness } from "./rug-analytics";
const controlSchema = z
  .object({
    settings: settingsSchema,
    entryDisabled: z.boolean(),
    allTradingDisabled: z.boolean(),
    entrySafetyReason: z
      .string()
      .regex(/^[A-Z_]+$/)
      .optional(),
  })
  .strict();
export interface RealEngineOptions {
  repository: Repository;
  chains: ChainConfig[];
  env: RuntimeEnv;
  config: RealConfig;
  wallets: LocalWalletManager;
  configurationLoaded: boolean;
}
export class RealTradingEngine {
  readonly bus = new EventBus();
  private readonly commits = new SerialQueue();
  private readonly entryCapital = new SerialQueue();
  private readonly queue = new BoundedQueue(3, 48);
  private readonly adapters = new Map<string, ProductionChainAdapter>();
  private readonly cursors: JournalCursorStore;
  private readonly virtualBook: ObservationBook;
  private observationAiAt = 0;
  private observationStartedAt = Date.now();
  private observationScanners = new Map<
    string,
    {
      chainId: string;
      status: "SCANNING" | "CONNECTING" | "ERROR" | "STOPPED";
      reason?: string;
    }
  >();
  private observationWatches = new Map<string, () => Promise<void>>();
  private readonly creators: InternalCreatorHistoryProvider;
  private readonly ai: JevAIProvider;
  private readonly features: ProductionFeatureEngine;
  private readonly rugEngine: RugCheckEngine;
  private readonly rugHistory: CreatorIntelligenceProvider;
  private readonly rugAI: JevRiskClassifier;
  private readonly holderClusters: InternalHolderClusterProvider;
  private readonly securityProviders: TokenSecurityProvider[];
  private rugSnapshots = new Map<string, RugCheckSnapshot>();
  private rugMonitored = new Map<string, number>();
  private readonly routes: AtomicRouteEngine;
  private readonly providers: SwapProvider[] = [];
  private readonly executions: DurableExecutionStore;
  private readonly positions: AtomicPositionManager;
  private readonly authority: TradeIntentAuthority;
  private readonly paper: RealPaperExecutor;
  private readonly prices: RpcQuoteUsdPriceProvider;
  private readonly observations: RealObservationService;
  private lastAnalysis = new Map<string, number>();
  private readonly evmExecutors = new Map<string, EvmLiveExecutor>();
  private solanaExecutor?: SolanaLiveExecutor;
  private settings = defaultSettings();
  private running = false;
  private entryDisabled = false;
  private allTradingDisabled = false;
  private entrySafetyReason?: string;
  private generation = 0;
  private candidates: CandidateRecord[] = [];
  private seen = new Set<string>();
  private readonly discovery: DiscoveryMonitor;
  private discoveryTurn = 0;
  private inFlight = new Set<string>();
  private events: DomainEvent[] = [];
  private off?: () => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private observationTimer?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private readonly closingPositions = new KeyedLock();
  private portfolioRevision = 0;
  private readonly closeJobs = new Set<Promise<unknown>>();
  private readonly pendingAutomaticExits = new Set<string>();
  private readonly positionSamples = new BoundedQueue(3, 128);
  private inbox = new Map<string, TokenDiscoveryEvent>();
  private readonly discoveryWrites = new KeyedLock();
  private detectedCount = 0;
  private totals = { analyzed: 0, rejected: 0, aiCalls: 0 };
  private accepting = new Map<string, Promise<void>>();
  private processingDiscovery = new Set<string>();
  private processedRevision = new Map<string, string>();
  private inboxTimer?: ReturnType<typeof setInterval>;
  private monitoring = false;
  private reconciling = false;
  private closing = false;
  constructor(private readonly options: RealEngineOptions) {
    if (options.env.DATA_MODE !== "real" || options.env.AI_PROVIDER !== "jev")
      throw new Error("REAL_MODE_REQUIRES_JEV");
    this.discovery = new DiscoveryMonitor(
      options.config.maxPools * 20,
      options.config.deployments,
    );
    this.cursors = new JournalCursorStore(options.repository);
    this.virtualBook = new ObservationBook(options.repository);
    if (options.env.OBSERVATION_ONLY)
      this.settings = { ...this.settings, tradeSizeUsd: 5 };
    this.creators = new InternalCreatorHistoryProvider(options.repository);
    const analyzers = new Map<string, SolanaTokenAnalyzer>();
    for (const chain of options.chains) {
      const adapter = new ProductionChainAdapter(
        chain,
        options.config,
        options.env,
        this.cursors,
        undefined,
        async (event, address) => {
          if (event.transactionId)
            await this.creators.record({
              chainId: event.chainId,
              tokenAddress: event.tokenAddress,
              creatorAddress: address,
              transactionId: event.transactionId,
              observedAt: Date.now(),
              evidence: "PROGRAM_POOL_CREATOR",
              outcome: "OBSERVED",
            });
        },
      );
      this.adapters.set(chain.id, adapter);
      if (adapter.solana) analyzers.set(chain.id, adapter.solana);
    }
    this.prices = new RpcQuoteUsdPriceProvider(
      new Map(
        [...this.adapters].flatMap(([id, a]) =>
          a.rpc && a.config.evmChainId
            ? [[id, { rpc: a.rpc, evmChainId: a.config.evmChainId }] as const]
            : [],
        ),
      ),
    );
    for (const adapter of this.adapters.values())
      adapter.useQuotePrices(this.prices);
    const rpcHolders = new RpcHolderDataProvider(
      new Map(
        [...this.adapters].flatMap(([id, a]) =>
          a.rpc
            ? [
                [
                  id,
                  { type: a.type, rpc: a.rpc, solana: analyzers.get(id) },
                ] as const,
              ]
            : [],
        ),
      ),
    );
    const holders = new CompositeHolderDataProvider([rpcHolders]);
    this.features = new ProductionFeatureEngine(
      this.adapters,
      holders,
      this.creators,
    );
    this.ai = new JevAIProvider({
      apiKey: options.env.TYPESAFE_API_KEY,
      model: options.env.JEV_MODEL,
      timeoutMs: options.env.JEV_TIMEOUT_MS,
      onTelemetry: (event) => this.append("ai.telemetry", event, event.chainId),
    });
    for (const d of options.config.deployments) {
      const adapter = this.adapters.get(d.chainId);
      if (
        !d.enabled ||
        d.discoveryOnly ||
        !adapter?.rpc ||
        !adapter.config.evmChainId ||
        !d.routerAddress ||
        !d.factoryAddress ||
        !["uniswap-v2", "pancakeswap", "uniswap-v3"].includes(d.family)
      )
        continue;
      const router = z
          .string()
          .regex(/^0x[\da-fA-F]{40}$/)
          .parse(d.routerAddress) as `0x${string}`,
        factory = z
          .string()
          .regex(/^0x[\da-fA-F]{40}$/)
          .parse(d.factoryAddress);
      this.providers.push(
        new EvmRouterSwapProvider(adapter.rpc, {
          id: d.id,
          chainId: d.chainId,
          evmChainId: adapter.config.evmChainId,
          router,
          factory: factory as `0x${string}`,
          family: d.family === "uniswap-v3" ? "v3" : "v2",
          quoter: d.quoterAddress as `0x${string}` | undefined,
          quoteTtlMs: options.config.quoteTtlMs,
          wrappedNative:
            d.family === "uniswap-v3"
              ? undefined
              : (options.config.quotes[d.chainId]?.find(
                  (q) => q.type === "WRAPPED_NATIVE",
                )?.address as `0x${string}` | undefined),
        }),
      );
    }
    const solana = this.adapters.get("solana");
    if (solana?.rpc)
      this.providers.push(
        new JupiterSwapProvider(solana.rpc, {
          apiKey: options.env.JUPITER_API_KEY,
          allowedPrograms: options.config.solana.allowedPrograms,
          dexes: options.config.solana.allowedDexes,
          quoteTtlMs: options.config.quoteTtlMs,
          maxPriorityFeeLamports: options.config.solana.maxPriorityFeeLamports,
        }),
      );
    this.routes = new AtomicRouteEngine(this.providers);
    this.rugHistory = new CreatorIntelligenceProvider(
      options.repository,
      this.creators,
    );
    const evmChains = new Map(
      options.chains.flatMap((c) =>
        c.evmChainId ? [[c.id, c.evmChainId] as const] : [],
      ),
    );
    this.securityProviders = [
      new OnChainSecurityProvider(
        new Map(
          [...this.adapters].map(([id, a]) => [
            id,
            (address: string) => a.analyzeSecurity(address),
          ]),
        ),
        new Map(
          [...this.adapters].map(([id, a]) => [
            id,
            (address: string) => {
              a.evm?.invalidate(address);
              a.solana?.invalidate(address);
            },
          ]),
        ),
      ),
      new OnChainHolderSecurityProvider(
        rpcHolders,
        options.config.rugCheck.exclusions,
      ),
      new OnChainLiquiditySecurityProvider(
        new Map(
          [...this.adapters].flatMap(([id, a]) =>
            a.rpc && a.config.type === "evm"
              ? [
                  [
                    id,
                    {
                      rpc: a.rpc,
                      factories: options.config.deployments
                        .filter(
                          (d) =>
                            d.enabled &&
                            d.chainId === id &&
                            ["uniswap-v2", "pancakeswap"].includes(d.family) &&
                            d.factoryAddress,
                        )
                        .map((d) => d.factoryAddress!),
                    },
                  ] as const,
                ]
              : [],
          ),
        ),
        async (request) =>
          (
            await this.creators.getCreatorAnalysis(
              request.chainId,
              request.tokenAddress,
            )
          ).address,
      ),
      this.rugHistory,
      ...(solana?.rpc
        ? [
            new SolanaLiquiditySecurityProvider(
              solana.rpc,
              options.config.deployments,
              rpcHolders,
            ),
          ]
        : []),
      ...(["goplus", "honeypot", "rugcheck"] as const).map(
        (id) =>
          new ExternalSecurityProvider(id, {
            enabled: options.config.rugCheck.external[id],
            evmChains,
            timeoutMs: options.config.rugCheck.providerTimeoutMs,
          }),
      ),
    ];
    this.holderClusters = new InternalHolderClusterProvider(options.repository);
    this.rugEngine = new RugCheckEngine(
      this.securityProviders,
      options.config.rugCheck.providerTimeoutMs + 100,
      this.holderClusters,
    );
    this.rugAI = new JevRiskClassifier({
      apiKey: options.env.TYPESAFE_API_KEY,
      model: options.env.JEV_MODEL,
      timeoutMs: options.env.JEV_TIMEOUT_MS,
    });
    this.executions = new DurableExecutionStore(options.repository);
    this.positions = new AtomicPositionManager(options.repository);
    this.authority = new TradeIntentAuthority(
      (intent) =>
        intent.mode === operationalMode(options.env) &&
        !this.closing &&
        !this.allTradingDisabled &&
        (intent.side === "SELL" ||
          (this.running &&
            !this.entryDisabled &&
            (intent.mode !== "LIVE" ||
              options.config.execution.liveChains.includes(
                intent.chainId as "solana" | "bnb" | "robinhood",
              )) &&
            intent.chainId === this.settings.activeChain)),
    );
    this.paper = new RealPaperExecutor(this.executions, (intent) =>
      this.authority.accepts(intent),
    );
    this.observations = new RealObservationService(
      options.repository,
      this.adapters,
      options.config.maxPools,
      async (event) => {
        const last = this.lastAnalysis.get(event.id) ?? 0;
        if (
          this.running &&
          !this.entryDisabled &&
          (this.options.env.OBSERVATION_ONLY ||
            event.chainId === this.settings.activeChain) &&
          Date.now() - event.timestamp <= 300000 &&
          Date.now() - last >= 15000
        ) {
          this.lastAnalysis.set(event.id, Date.now());
          await this.ingest(event, true);
        }
      },
    );
    for (const [id, adapter] of this.adapters) {
      const maxGas = options.config.execution.maxGasWeiByChain[id];
      if (adapter.rpc && adapter.config.evmChainId && maxGas)
        this.evmExecutors.set(
          id,
          new EvmLiveExecutor(
            adapter.rpc,
            options.wallets,
            this.executions,
            {
              chainId: id,
              evmChainId: adapter.config.evmChainId,
              maxGasWei: BigInt(maxGas),
              confirmationDepth: Math.max(
                2,
                ...options.config.deployments
                  .filter((d) => d.chainId === id)
                  .map((d) => d.confirmationDepth),
              ),
              liveAcknowledged: options.env.LIVE_TRADING_ACK,
            },
            (intent) => this.authority.accepts(intent),
          ),
        );
    }
    if (
      solana?.rpc &&
      solana.config.expectedGenesisHash &&
      options.config.execution.solanaMaxFeeLamports &&
      options.config.execution.solanaMaxNativeDebitLamports &&
      options.config.solana.allowedPrograms.length > 0 &&
      options.config.execution.solanaAllowedAccountOwners.length > 0
    )
      this.solanaExecutor = new SolanaLiveExecutor(
        solana.rpc,
        options.wallets,
        this.executions,
        {
          expectedGenesisHash: solana.config.expectedGenesisHash,
          allowedPrograms: options.config.solana.allowedPrograms,
          allowedAccountOwners:
            options.config.execution.solanaAllowedAccountOwners,
          maxNetworkFeeLamports: BigInt(
            options.config.execution.solanaMaxFeeLamports,
          ),
          maxNativeDebitLamports: BigInt(
            options.config.execution.solanaMaxNativeDebitLamports,
          ),
          liveAcknowledged: options.env.LIVE_TRADING_ACK,
        },
        (intent) => this.authority.accepts(intent),
      );
  }
  private async append(kind: string, payload: unknown, chainId?: string) {
    await this.options.repository.append({
      id: randomUUID(),
      kind,
      payload,
      chainId,
      createdAt: Date.now(),
    });
  }
  private emit(type: string, data: unknown, chainId?: string) {
    const event: DomainEvent = {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      chainId,
      tokenAddress:
        data &&
        typeof data === "object" &&
        "tokenAddress" in data &&
        typeof data.tokenAddress === "string"
          ? data.tokenAddress
          : undefined,
      data,
    };
    this.events = [event, ...this.events].slice(0, 300);
    this.bus.publish(event);
  }
  async initialize() {
    await this.ai.verify();
    const rows = await this.options.repository.read();
    if (this.options.env.OBSERVATION_ONLY) await this.virtualBook.restore();
    for (const row of rows) {
      if (row.kind === "real.pool") {
        this.detectedCount++;
        this.discovery.observe(
          tokenDiscoveryEventSchema.parse(row.payload),
          true,
        );
      }
      if (row.kind === "real.discovery" || row.kind === "real.pool") {
        const event = tokenDiscoveryEventSchema.parse(row.payload);
        this.discovery.attach(event);
        if (event.source !== "RPC")
          throw new Error("REAL_JOURNAL_SOURCE_MISMATCH");
        this.inbox.set(this.key(event), event);
      }
      if (row.kind === "real.control") {
        const legacy = z.record(z.string(), z.unknown()).parse(row.payload);
        const oldSettings = z
          .record(z.string(), z.unknown())
          .parse(legacy.settings);
        const settings = { ...oldSettings };
        delete settings.activeWalletByChain;
        const control = controlSchema.parse({ ...legacy, settings });
        this.settings = control.settings;
        this.entryDisabled = control.entryDisabled;
        this.allTradingDisabled = control.allTradingDisabled;
        this.entrySafetyReason = control.entrySafetyReason;
      }
      if (row.kind === "real.candidate") {
        const record = candidateSchema.parse(row.payload);
        if (record.event.source !== "RPC")
          throw new Error("REAL_JOURNAL_SOURCE_MISMATCH");
        this.candidates.push(record);
        this.discovery.analyzed(record, true);
        if (record.state) this.totals.analyzed++;
        if (record.action === "REJECT") this.totals.rejected++;
        if (record.aiAttempted) this.totals.aiCalls++;
        this.seen.add(this.key(record.event));
        this.rememberRevision(record.event);
        this.candidates.splice(
          0,
          Math.max(
            0,
            this.candidates.length - this.options.config.maxPools * 20,
          ),
        );
        if (
          this.revision(
            this.inbox.get(this.key(record.event)) ?? record.event,
          ) === this.revision(record.event)
        )
          this.inbox.delete(this.key(record.event));
      }
    }
    if (this.options.env.OBSERVATION_ONLY)
      this.settings = { ...this.settings, tradeSizeUsd: 5 };
    await this.cursors.restore();
    await this.creators.restore();
    await this.rugHistory.restore();
    await this.holderClusters.restore();
    for (const row of await this.options.repository.read())
      if (row.kind === "rug.snapshot") {
        const snapshot = rugSnapshotSchema.parse(row.payload);
        this.rememberRug(snapshot);
      }
    await this.executions.restore();
    await this.positions.restore();
    await this.observations.restore();

    for (const candidate of this.candidates.slice(
      -this.options.config.maxPools * 20,
    )) {
      this.lastAnalysis.set(candidate.event.id, candidate.createdAt);
      await this.observations.track(candidate);
    }
    for (const record of this.executions.all()) {
      const intent = this.executions.intent(record.intentId);
      if (
        !record.transactionId &&
        ["APPROVED", "BUILDING", "SIMULATING"].includes(record.state)
      )
        await this.executions.put({
          ...record,
          state: "FAILED",
          reasons: ["RESTART_BEFORE_BROADCAST_CANCELLED"],
          updatedAt: Date.now(),
        });
      if (
        record.state === "CONFIRMED" &&
        record.operation !== "APPROVAL" &&
        intent
      )
        await this.positions.applyFill(record, intent, this.settings);
    }
    this.emit("real_ready", {
      mode: operationalMode(this.options.env),
      source: "RPC",
    });
  }
  private key(e: TokenDiscoveryEvent) {
    return e.chainId === "solana"
      ? `${e.chainId}:${e.dexId}:${e.poolAddress}`
      : `${e.chainId}:token:${e.tokenAddress.toLowerCase()}`;
  }
  getSettings() {
    return structuredClone(this.settings);
  }
  private revision(e: TokenDiscoveryEvent) {
    const raw = z
      .object({ blockHash: z.string().optional() })
      .safeParse(e.rawEvent);
    const base = `${e.transactionId ?? e.id}:${raw.success ? (raw.data.blockHash ?? "") : ""}`;
    return e.chainId === "solana"
      ? base
      : `${e.dexId}:${e.poolAddress}:${String((e.rawEvent as Record<string, unknown> | undefined)?.stage ?? "")}:${base}`;
  }
  private rememberRevision(event: TokenDiscoveryEvent) {
    const key = this.key(event);
    this.processedRevision.delete(key);
    this.processedRevision.set(key, this.revision(event));
    this.seen.delete(key);
    this.seen.add(key);
    if (this.processedRevision.size > this.options.config.maxPools * 20) {
      this.processedRevision.delete(
        this.processedRevision.keys().next().value!,
      );
      this.seen.delete(this.seen.keys().next().value!);
    }
  }
  private async acceptDiscovery(input: TokenDiscoveryEvent) {
    const event = tokenDiscoveryEventSchema.parse(input);
    this.rugEngine.invalidate(event.chainId, event.tokenAddress);
    if (event.source !== "RPC") throw new Error("REAL_SOURCE_REQUIRED");
    const key = this.key(event),
      revision = this.revision(event),
      acceptKey = `${event.chainId}:${event.dexId}:${key}:${revision}`;
    const waiting = this.accepting.get(acceptKey);
    if (waiting) {
      this.discovery.duplicates++;
      return waiting;
    }
    if (
      this.processedRevision.get(key) === revision ||
      (this.inbox.has(key) && this.revision(this.inbox.get(key)!) === revision)
    ) {
      this.discovery.duplicates++;
      return;
    }
    if (this.accepting.size >= 60) {
      this.discovery.backpressure++;
      throw new Error("DISCOVERY_PERSISTENCE_BACKPRESSURE");
    }
    let deferReason: string | undefined;
    if (
      !this.inbox.has(key) &&
      this.inbox.size + this.accepting.size >= this.options.config.maxPools
    ) {
      this.discovery.backpressure++;
      if (event.chainId === "solana") throw new Error("DISCOVERY_BACKPRESSURE");
      deferReason = "DISCOVERY_ANALYSIS_BACKPRESSURE";
    }
    if (
      !deferReason &&
      !this.inbox.has(key) &&
      (event.chainId !== "solana" ||
        ["pump-fun", "pump-swap"].includes(event.dexId)) &&
      [...this.inbox.values()].filter(
        (item) => item.dexId === event.dexId && item.chainId === event.chainId,
      ).length +
        [...this.accepting.keys()].filter((pending) =>
          pending.startsWith(`${event.chainId}:${event.dexId}:`),
        ).length >=
        Math.max(1, Math.floor(this.options.config.maxPools / 6))
    ) {
      this.discovery.backpressure++;
      if (event.chainId === "solana")
        throw new Error("DISCOVERY_SOURCE_BACKPRESSURE");
      deferReason = "DISCOVERY_ANALYSIS_SOURCE_CAP";
    }
    const task = this.discoveryWrites
      .run(key, async () => {
        const has = async (id: string) =>
          this.options.repository.has
            ? this.options.repository.has(id)
            : (await this.options.repository.read()).some(
                (row) => row.id === id,
              );
        const observationKey =
          event.chainId === "solana"
            ? key
            : `${event.chainId}:${event.dexId}:${event.poolAddress.toLowerCase()}:${event.tokenAddress.toLowerCase()}`;
        const id = `discovery:${observationKey}:${revision}`;
        const alreadyStored = await has(id);
        const legacyPoolKey = `${event.chainId}:${event.dexId}:${event.chainId === "solana" ? event.poolAddress : event.poolAddress.toLowerCase()}`;
        const poolId = `pool:${legacyPoolKey}`;
        if (!(await has(poolId))) {
          await this.options.repository.append({
            id: poolId,
            kind: "real.pool",
            chainId: event.chainId,
            tokenAddress: event.tokenAddress,
            payload: event,
            createdAt: Date.now(),
          });
          this.detectedCount++;
          this.discovery.observe(event);
        }
        if (!alreadyStored)
          await this.options.repository.append({
            id,
            kind: "real.discovery",
            chainId: event.chainId,
            tokenAddress: event.tokenAddress,
            payload: event,
            createdAt: Date.now(),
          });
        this.discovery.attach(event);
        if (deferReason) {
          await this.persistDeferredDiscovery(event, deferReason);
          this.emit(
            "token_detected",
            {
              discoveryId: event.id,
              tokenAddress: event.tokenAddress,
              analysis: "DEFERRED",
            },
            event.chainId,
          );
          return;
        }
        const queued = this.inbox.get(key);
        const isPool = (e: TokenDiscoveryEvent) =>
          ["DEX_POOL", "SINGLETON_POOL"].includes(
            String(
              (e.rawEvent as Record<string, unknown> | undefined)?.marketKind,
            ),
          );
        if (!queued || !isPool(queued) || isPool(event))
          this.inbox.set(key, event);
        this.emit(
          "token_detected",
          { discoveryId: event.id, tokenAddress: event.tokenAddress },
          event.chainId,
        );
        this.pumpInbox();
      })
      .finally(() => this.accepting.delete(acceptKey));
    this.accepting.set(acceptKey, task);
    return task;
  }
  private async persistDeferredDiscovery(
    event: TokenDiscoveryEvent,
    reason: string,
  ) {
    const record: CandidateRecord = {
      id: randomUUID(),
      strategyId: this.settings.strategy,
      event,
      createdAt: Date.now(),
      action: "SKIP",
      reasons: [reason],
      lifecycle: this.discovery.lifecycle(event),
      discoveryGuard: {
        passed: false,
        deferred: true,
        reasons: [reason],
        latencyMs: 0,
      },
      observation: this.options.env.OBSERVATION_ONLY
        ? {
            stage: "DISCOVERY_DEFERRED",
            virtualAction: "WATCH",
            budgetUsd: "5",
            sellability: "UNKNOWN",
            liveBlockingReasons: ["OBSERVATION_ONLY", reason],
          }
        : undefined,
    };
    await this.commits.run(async () => {
      await this.append("real.candidate", record, event.chainId);
      this.candidates.push(record);
      this.candidates = this.candidates.slice(
        -this.options.config.maxPools * 20,
      );
      this.discovery.analyzed(record);
      this.rememberRevision(event);
    });
  }
  private pumpInbox() {
    if (!this.running || this.closing) return;
    const groups = new Map<string, [string, TokenDiscoveryEvent][]>();
    for (const row of this.inbox) {
      const source = row[1].chainId + ":" + row[1].dexId;
      const group = groups.get(source) ?? [];
      group.push(row);
      groups.set(source, group);
    }
    const sources = [...groups.keys()];
    const ordered: [string, TokenDiscoveryEvent][] = [];
    for (let turn = 0; turn < sources.length; turn++) {
      const source = sources[(this.discoveryTurn + turn) % sources.length]!;
      const group = groups.get(source)!;
      if (group[0]) ordered.push(group[0]);
    }
    this.discoveryTurn = (this.discoveryTurn + 1) % Math.max(1, sources.length);
    for (const [key, event] of ordered) {
      if (this.processingDiscovery.size >= 3) break;
      if (
        (!this.options.env.OBSERVATION_ONLY &&
          event.chainId !== this.settings.activeChain) ||
        this.processingDiscovery.has(key)
      )
        continue;
      this.processingDiscovery.add(key);
      void this.ingest(event, true)
        .catch(() =>
          this.emit(
            "discovery_retry",
            { discoveryId: event.id },
            event.chainId,
          ),
        )
        .finally(() => {
          this.processingDiscovery.delete(key);
          if (
            this.processedRevision.get(key) === this.revision(event) &&
            this.inbox.get(key) &&
            this.revision(this.inbox.get(key)!) === this.revision(event)
          )
            this.inbox.delete(key);
        });
    }
  }
  async updateSettings(input: unknown) {
    if (
      this.options.env.OBSERVATION_ONLY &&
      typeof input === "object" &&
      input &&
      "tradeSizeUsd" in input &&
      input.tradeSizeUsd !== 5
    )
      throw new Error("OBSERVATION_BUDGET_FIXED_AT_5_USD");
    const next = settingsSchema.parse({
      ...this.settings,
      ...z.record(z.string(), z.unknown()).parse(input),
    });
    this.authority.invalidate();
    const switched = next.activeChain !== this.settings.activeChain;
    await this.commits.run(async () => {
      await this.append("real.control", {
        settings: next,
        entryDisabled: this.entryDisabled,
        allTradingDisabled: this.allTradingDisabled,
        entrySafetyReason: this.entrySafetyReason,
      });
      this.generation++;
      this.settings = next;
    });
    if (switched && this.running && !this.options.env.OBSERVATION_ONLY) {
      await this.off?.();
      this.off = undefined;
      try {
        this.off = await this.adapters
          .get(next.activeChain)!
          .watchNewTokens((e) => this.acceptDiscovery(e));
      } catch {
        this.running = false;
        this.emit(
          "scanner_error",
          { reason: "CHAIN_SWITCH_NOT_READY" },
          next.activeChain,
        );
      }
    }
    return this.getSettings();
  }
  async setRunning(running: boolean) {
    if (this.options.env.OBSERVATION_ONLY)
      return this.setObservationRunning(running);
    this.generation++;
    this.authority.invalidate();
    if (!running) {
      this.running = false;
      await this.off?.();
      this.off = undefined;
      this.emit("scanner_paused", {});
      return;
    }
    if (this.closing || this.entryDisabled || this.allTradingDisabled)
      throw new Error("ENTRY_DISABLED");
    const adapter = this.adapters.get(this.settings.activeChain);
    if (!adapter?.config.enabled) throw new Error("CHAIN_NOT_ENABLED");
    await this.off?.();
    this.off = undefined;
    this.running = true;
    try {
      this.off = await adapter.watchNewTokens((e) => this.acceptDiscovery(e));
      this.pumpInbox();
      this.emit("scanner_started", {}, adapter.chainId);
    } catch {
      this.running = false;
      throw new Error("REAL_SCANNER_NOT_READY");
    }
  }
  async setKillSwitch(active: boolean) {
    if (!active) this.entrySafetyReason = undefined;
    if (active) {
      this.entryDisabled = true;
      this.generation++;
      this.authority.invalidate();
    }
    await this.commits.run(async () => {
      await this.append("real.control", {
        settings: this.settings,
        entryDisabled: active,
        allTradingDisabled: this.allTradingDisabled,
        entrySafetyReason: this.entrySafetyReason,
      });
      this.entryDisabled = active;
      this.generation++;
      this.emit(active ? "kill_switch" : "kill_switch_reset", {
        scope: "ENTRY_DISABLED",
      });
    });
  }
  async setAllTradingDisabled(active: boolean) {
    if (active) {
      this.allTradingDisabled = true;
      this.generation++;
      this.authority.invalidate();
    }
    await this.commits.run(async () => {
      await this.append("real.control", {
        settings: this.settings,
        entryDisabled: this.entryDisabled,
        allTradingDisabled: active,
      });
      this.allTradingDisabled = active;
      this.generation++;
      this.emit("kill_switch", { scope: "ALL_TRADING_DISABLED", active });
    });
  }
  private guardDiscovery(event: TokenDiscoveryEvent) {
    if (
      event.chainId === "solana" &&
      !["pump-fun", "pump-swap"].includes(event.dexId)
    )
      return undefined;
    return async () => {
      const guard = await this.adapters
        .get(event.chainId)!
        .discoveryGuard(event);
      if (guard.passed) {
        const creator = z
          .object({
            creator: z.string(),
            creatorRole: z.enum(["TOKEN_CREATOR", "POOL_CREATOR"]),
          })
          .safeParse(event.rawEvent);
        if (creator.success && event.transactionId)
          await this.creators.record({
            chainId: event.chainId,
            tokenAddress: event.tokenAddress,
            creatorAddress: creator.data.creator,
            transactionId: event.transactionId,
            observedAt: Date.now(),
            evidence:
              creator.data.creatorRole === "TOKEN_CREATOR"
                ? "PROGRAM_TOKEN_CREATOR"
                : "PROGRAM_POOL_CREATOR",
            outcome: "OBSERVED",
          });
      }
      return guard;
    };
  }
  async ingest(event: TokenDiscoveryEvent, reanalysis = false) {
    if (
      event.source !== "RPC" ||
      !this.running ||
      (!this.options.env.OBSERVATION_ONLY &&
        event.chainId !== this.settings.activeChain) ||
      this.closing
    )
      return;
    const key = this.key(event);
    if ((!reanalysis && this.seen.has(key)) || this.inFlight.has(key)) return;
    if (this.options.env.OBSERVATION_ONLY) return this.ingestObservation(event);
    this.lastAnalysis.set(event.id, Date.now());
    this.inFlight.add(key);
    const generation = this.generation;
    try {
      await this.queue.submit(async () => {
        const policy = this.getSettings();
        const record = await analyzeCandidate(
          event,
          this.features,
          this.ai,
          policy,
          Date.now(),
          30000,
          this.options.env.JEV_TIMEOUT_MS + 100,
          new TokenSecurityWorkflow({
            engine: this.rugEngine,
            enabled: this.options.config.rugCheck.enabled,
            policy: this.rugPolicy(event.chainId),
            mode: operationalMode(this.options.env),
            prepare: async (candidate) => {
              if (
                generation !== this.generation ||
                this.entryDisabled ||
                this.allTradingDisabled ||
                !this.running
              )
                throw new Error("ENTRY_GENERATION_CHANGED");
              return this.prepareSecurityTrading(candidate, policy);
            },
            classify: async (snapshot) => {
              const result = await this.rugAI.classify(snapshot);
              await this.append(
                "rug.jev-risk",
                {
                  ...result,
                  chainId: snapshot.chainId,
                  tokenAddress: snapshot.tokenAddress,
                },
                snapshot.chainId,
              );
              this.rememberRug(snapshot);
              return result;
            },
          }),
          this.guardDiscovery(event),
        );
        if (record.reasons.includes("AI_UNAVAILABLE"))
          record.reasons = ["AI_FAILED"];
        {
          if (record.state && record.strategy?.passed) {
            await this.entryCapital.run(async () => {
              try {
                if (
                  generation !== this.generation ||
                  !this.running ||
                  this.entryDisabled ||
                  this.allTradingDisabled
                )
                  throw new Error("ENTRY_GENERATION_CHANGED");
                const gate = await this.entryRisk(record, policy);
                if (record.timing) record.timing.riskComplete = Date.now();
                record.risk = gate;
                if (!gate.passed) {
                  record.reasons = gate.reasons;
                } else {
                  const validation = await this.prepareSecurityTrading(
                    record,
                    policy,
                  );
                  const {
                    trip,
                    quoteAsset,
                    nativePrice,
                    mode,
                    walletId,
                    walletAddress,
                  } = validation;
                  // Báo giá sau AI luôn mới; bằng chứng AI cũ không cấp quyền dùng snapshot khác.
                  if (
                    !record.rugCheck ||
                    record.rugCheck.decision?.decision !== "ALLOW"
                  )
                    throw new Error("RUG_SECURITY_NOT_APPROVED");
                  const fresh = applyRugTrading(
                    structuredClone(record.rugCheck),
                    validation,
                  );
                  const freshGate = decideRugCheck(
                    fresh,
                    this.rugPolicy(event.chainId),
                    mode,
                    "HARD_FILTER",
                  );
                  await this.append(
                    "rug.trade-validation",
                    {
                      snapshotId: record.rugCheck.id,
                      chainId: event.chainId,
                      tokenAddress: event.tokenAddress,
                      checkedAt: new Date().toISOString(),
                      trading: fresh.trading,
                      decision: freshGate,
                    },
                    event.chainId,
                  );
                  if (freshGate.decision !== "ALLOW")
                    throw new Error(
                      freshGate.reasonCodes[0] ?? "RUG_SECURITY_NOT_APPROVED",
                    );
                  if (mode !== "PAPER" && !(await this.readiness()).ready)
                    throw new Error("LIVE_READINESS_INCOMPLETE");
                  const approvedQuoteUsd = quoteAsset.usdPrice;
                  const revision = this.portfolioRevision;
                  const finalGate = await this.entryRisk(record, policy);
                  record.risk = finalGate;
                  if (!finalGate.passed)
                    throw new Error(finalGate.reasons[0] ?? "RISK_REJECTED");
                  const intent = await this.commits.run(async () => {
                    if (
                      revision !== this.portfolioRevision ||
                      generation !== this.generation ||
                      this.hasPendingExecution()
                    )
                      throw new Error("RISK_STATE_CHANGED");
                    if (mode !== "PAPER") {
                      const current = await this.entrySizing(
                        event,
                        quoteAsset,
                        policy,
                      );
                      if (current.amountIn !== trip.buy.amountIn)
                        throw new Error(
                          "POSITION_SIZE_CHANGED_REQUOTE_REQUIRED",
                        );
                      record.entrySizing = current;
                      const capitalGate = await this.entryRisk(record, policy);
                      if (!capitalGate.passed)
                        throw new Error(
                          capitalGate.reasons[0] ?? "RISK_REJECTED",
                        );
                    }
                    const intent = this.authority.approve({
                      decisionId: record.id,
                      risk: finalGate,
                      entrySizing: record.entrySizing,
                      walletId,
                      walletAddress,
                      side: "BUY",
                      mode,
                      roundTrip: trip,
                      maxSlippageBps: this.options.config.maxSlippageBps,
                      maxPriceImpactPct: policy.maxPriceImpactPct,
                      maxRoundTripLossPct:
                        this.options.config.maxRoundTripLossPct,
                      idempotencyKey: `entry:${key}`,
                      allowQuoteOnlyPaper:
                        !this.options.config.requireSellSimulation,
                      entryLiquidityUsd: record.state?.market.liquidityUsd,
                      valuation: {
                        quoteUsdPrice: approvedQuoteUsd,
                        nativeUsdPrice: nativePrice?.usdPrice,
                        nativeDecimals: event.chainId === "solana" ? 9 : 18,
                      },
                      positionPolicy: {
                        stopLossPct: policy.stopLossPct,
                        trailingStopPct: policy.trailingStopPct,
                        maxHoldingSec: policy.maxHoldingSec,
                        liquidityCollapsePct: policy.liquidityCollapsePct,
                        takeProfit: policy.takeProfit,
                      },
                    });
                    await this.executions.begin(intent);
                    return intent;
                  });
                  if (generation !== this.generation)
                    throw new Error("ENTRY_GENERATION_CHANGED");
                  const execution = await this.execute(intent);
                  if (record.timing) {
                    record.timing.broadcast = execution.stages?.PENDING;
                    record.timing.confirmation = execution.stages?.CONFIRMED;
                  }
                  if (execution.state === "CONFIRMED") {
                    await this.commits.run(async () => {
                      await this.positions.applyFill(execution, intent, policy);
                      this.portfolioRevision++;
                      this.authority.invalidate();
                    });
                    record.action = "BUY";
                    record.reasons = [
                      mode === "PAPER"
                        ? "REAL_QUOTE_PAPER_FILL"
                        : "LIVE_FILL_CONFIRMED",
                    ];
                  } else {
                    record.reasons = execution.reasons;
                  }
                }
              } catch (error) {
                const pending = this.executions.get(`entry:${key}`);
                if (
                  pending?.state === "APPROVED" &&
                  this.executions.intent(pending.intentId)?.decisionId ===
                    record.id
                )
                  await this.executions.put({
                    ...pending,
                    state: "FAILED",
                    updatedAt: Date.now(),
                    reasons: ["INTENT_CANCELLED_BEFORE_EXECUTION"],
                  });
                record.action = "SKIP";
                record.reasons = [this.reason(error)];
              }
            });
          }
          await this.commits.run(async () => {
            if (record.rugCheck) {
              if (
                record.hardFilter?.passed === false ||
                record.risk?.passed === false
              )
                record.rugCheck.decision = {
                  decision: "REJECT",
                  reasonCodes: record.reasons,
                  stage: "FINAL",
                  decidedAt: new Date().toISOString(),
                };
              record.rugCheck.reasonCodes =
                record.rugCheck.decision?.reasonCodes ?? record.reasons;
              record.rugCheck = refreshRugSnapshot(record.rugCheck);
              await this.append("rug.snapshot", record.rugCheck, event.chainId);
              await this.rugHistory.observe(record.rugCheck);
              this.rememberRug(record.rugCheck);
            }
            record.lifecycle = this.discovery.lifecycle(event);
            record.analysisLatencyMs = Date.now() - record.createdAt;
            await this.append("real.candidate", record, event.chainId);
            this.discovery.analyzed(record);
            this.candidates.push(record);
            if (record.state) this.totals.analyzed++;
            if (record.action === "REJECT") this.totals.rejected++;
            if (record.aiAttempted) this.totals.aiCalls++;
            this.seen.add(key);
            this.rememberRevision(record.event);
            this.candidates.splice(
              0,
              Math.max(
                0,
                this.candidates.length - this.options.config.maxPools * 20,
              ),
            );
            if (!record.discoveryGuard || record.discoveryGuard.passed)
              await this.observations.track(record);
            this.emit(
              "candidate_analyzed",
              {
                candidateId: record.id,
                action: record.action,
                reasons: record.reasons,
              },
              event.chainId,
            );
          });
        }
      });
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async setObservationRunning(running: boolean) {
    this.generation++;
    this.authority.invalidate();
    this.running = running;
    for (const [chainId, stop] of this.observationWatches) {
      await stop();
      this.observationScanners.set(chainId, { chainId, status: "STOPPED" });
    }
    this.observationWatches.clear();
    if (!running) {
      this.emit("scanner_paused", {});
      return;
    }
    if (this.entryDisabled || this.allTradingDisabled) {
      this.running = false;
      throw new Error("ENTRY_DISABLED");
    }
    const generation = this.generation;
    await Promise.allSettled(
      [...this.adapters.values()]
        .filter((a) => a.config.enabled)
        .map(async (adapter) => {
          this.observationScanners.set(adapter.chainId, {
            chainId: adapter.chainId,
            status: "CONNECTING",
          });
          this.emit(
            "observation_scanner",
            { stage: "CONNECTING" },
            adapter.chainId,
          );
          try {
            const stop = await adapter.watchNewTokens((e) =>
              this.acceptDiscovery(e),
            );
            if (!this.running || generation !== this.generation) {
              await stop();
              return;
            }
            this.observationWatches.set(adapter.chainId, stop);
            this.observationScanners.set(adapter.chainId, {
              chainId: adapter.chainId,
              status: "SCANNING",
            });
            this.emit("scanner_started", {}, adapter.chainId);
          } catch {
            this.observationScanners.set(adapter.chainId, {
              chainId: adapter.chainId,
              status: "ERROR",
              reason: "RPC_OR_DEPLOYMENT_UNAVAILABLE",
            });
            this.emit(
              "scanner_error",
              { reason: "RPC_OR_DEPLOYMENT_UNAVAILABLE" },
              adapter.chainId,
            );
          }
        }),
    );
    this.pumpInbox();
  }
  private async ingestObservation(event: TokenDiscoveryEvent) {
    const key = this.key(event);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.lastAnalysis.set(event.id, Date.now());
    try {
      await this.queue.submit(async () => {
        const policy = this.getSettings();
        const record = await analyzeObservation(event, {
          features: this.features,
          ai: this.ai,
          rug: this.rugEngine,
          settings: policy,
          policy: this.rugPolicy(event.chainId),
          aiTimeoutMs: this.options.env.JEV_TIMEOUT_MS + 100,
          discoveryGuard: this.guardDiscovery(event),
          claimAiSlot: () => {
            if (
              Date.now() - this.observationAiAt <
              this.options.env.OBSERVATION_AI_INTERVAL_MS
            )
              return false;
            this.observationAiAt = Date.now();
            return true;
          },
          stage: (stage) =>
            this.emit(
              "observation_stage",
              { tokenAddress: event.tokenAddress, stage },
              event.chainId,
            ),
        });
        if (
          record.observation?.virtualAction === "BUY" &&
          !this.entryDisabled &&
          !this.allTradingDisabled &&
          this.running
        ) {
          try {
            const asset = this.options.config.quotes[event.chainId]?.find(
                (q) => q.address === event.quoteTokenAddress,
              ),
              priced = asset
                ? await this.prices.resolve(event.chainId, asset)
                : undefined;
            if (!priced?.usdPrice)
              throw new Error("QUOTE_USD_PRICE_UNKNOWN_OR_STALE");
            const info = await this.adapters
              .get(event.chainId)!
              .getTokenInfo(event.tokenAddress);
            if (info.decimals === undefined)
              throw new Error("TOKEN_DECIMALS_UNKNOWN");
            const trip = await this.routes.roundTrip(
              {
                chainId: event.chainId,
                tokenIn: priced.address,
                tokenOut: event.tokenAddress,
                amountIn: quoteUnitsForUsd(
                  "5",
                  priced.usdPrice,
                  priced.decimals,
                ).toString(),
                decimalsIn: priced.decimals,
                decimalsOut: info.decimals,
                slippageBps: this.options.config.maxSlippageBps,
              },
              policy.maxPriceImpactPct,
            );
            if (
              !trip.sell ||
              trip.roundTripLossPct === undefined ||
              trip.roundTripLossPct > this.options.config.maxRoundTripLossPct
            )
              throw new Error("ROUND_TRIP_LOSS");
            await this.commits.run(async () => {
              if (
                !this.running ||
                this.entryDisabled ||
                this.allTradingDisabled ||
                this.closing
              )
                throw new Error("ENTRY_DISABLED");
              const opened = await this.virtualBook.open(
                record,
                trip.buy,
                priced.usdPrice!,
                policy,
              );
              if (opened) {
                record.observation!.stage = "VIRTUAL_OPEN";
                this.emit(
                  "observation_buy",
                  {
                    tokenAddress: event.tokenAddress,
                    symbol: opened.symbol,
                    budgetUsd: "5",
                    execution: "SIMULATED",
                    sellability: "UNKNOWN",
                  },
                  event.chainId,
                );
              }
            });
          } catch (error) {
            record.observation.virtualAction = "WATCH";
            record.reasons = [this.reason(error)];
          }
        }
        await this.commits.run(async () => {
          if (record.rugCheck) {
            await this.append("rug.snapshot", record.rugCheck, event.chainId);
            this.rememberRug(record.rugCheck);
            await this.rugHistory.observe(record.rugCheck);
          }
          record.lifecycle = this.discovery.lifecycle(event);
          record.analysisLatencyMs = Date.now() - record.createdAt;
          await this.append("real.candidate", record, event.chainId);
          this.discovery.analyzed(record);
          this.candidates.push(record);
          this.candidates = this.candidates.slice(
            -this.options.config.maxPools * 20,
          );
          if (record.state) this.totals.analyzed++;
          if (record.action === "REJECT") this.totals.rejected++;
          if (record.aiAttempted) this.totals.aiCalls++;
          this.seen.add(key);
          this.rememberRevision(event);
          if (!record.discoveryGuard || record.discoveryGuard.passed)
            await this.observations.track(record);
          this.emit(
            "candidate_analyzed",
            {
              tokenAddress: event.tokenAddress,
              candidateId: record.id,
              action: record.observation?.virtualAction ?? "WATCH",
              execution: "NONE",
            },
            event.chainId,
          );
        });
      });
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async monitorObservation() {
    if (this.allTradingDisabled) return;
    await Promise.allSettled(
      this.virtualBook.openTrades().map((trade) =>
        this.positionSamples.submit(async () => {
          try {
            const quote = await this.routes.quote(
              {
                chainId: trade.chainId,
                tokenIn: trade.tokenAddress,
                tokenOut: trade.quoteToken,
                amountIn: trade.remainingQuantity,
                decimalsIn: trade.tokenDecimals,
                decimalsOut: trade.quoteDecimals,
                slippageBps: this.options.config.maxSlippageBps,
              },
              this.settings.maxPriceImpactPct,
            );
            await this.commits.run(async () => {
              if (this.allTradingDisabled || this.closing) return;
              const exited = await this.virtualBook.mark(
                trade.id,
                quote,
                this.settings,
              );
              if (exited)
                this.emit(
                  "observation_sell",
                  {
                    tokenAddress: trade.tokenAddress,
                    symbol: trade.symbol,
                    reason: exited.exitReason,
                    state: exited.state,
                    execution: "SIMULATED",
                  },
                  trade.chainId,
                );
            });
          } catch {
            this.emit(
              "observation_quote_unavailable",
              { tokenAddress: trade.tokenAddress },
              trade.chainId,
            );
          }
        }),
      ),
    );
  }
  private async prepareSecurityTrading(
    record: CandidateRecord,
    policy: Settings,
  ) {
    const event = record.event;
    const mode = operationalMode(this.options.env);
    let configuredQuoteAsset = this.options.config.quotes[event.chainId]?.find(
      (q) => q.address === event.quoteTokenAddress,
    );
    if (mode !== "PAPER" && configuredQuoteAsset?.type === "WRAPPED_NATIVE")
      configuredQuoteAsset =
        this.options.config.quotes[event.chainId]?.find(
          (q) => q.type === "NATIVE",
        ) ?? configuredQuoteAsset;
    const quoteAsset = configuredQuoteAsset
      ? await this.prices.resolve(event.chainId, configuredQuoteAsset)
      : undefined;
    if (
      !quoteAsset?.usdPrice ||
      !quoteAsset.priceVerifiedAt ||
      Date.now() - quoteAsset.priceVerifiedAt > 60000
    )
      throw new Error("QUOTE_USD_PRICE_UNKNOWN_OR_STALE");
    if (mode !== "PAPER" && !productionPriceAllowed(event.chainId, quoteAsset))
      throw new Error("LIVE_QUOTE_ORACLE_CHAIN_UNVERIFIED");
    if (mode !== "PAPER")
      record.entrySizing = await this.entrySizing(
        event,
        { ...quoteAsset, usdPrice: quoteAsset.usdPrice },
        policy,
      );
    const info = await this.adapters
      .get(event.chainId)!
      .getTokenInfo(event.tokenAddress);
    if (info.decimals === undefined) throw new Error("TOKEN_DECIMALS_UNKNOWN");
    const quoteStart = Date.now();
    let trip = await this.routes.roundTrip(
      {
        chainId: event.chainId,
        tokenIn: quoteAsset.address,
        tokenOut: event.tokenAddress,
        nativeInput: quoteAsset.type === "NATIVE",
        walletAddress:
          mode === "PAPER"
            ? undefined
            : (await this.fixedWallet(event.chainId))?.address,
        amountIn:
          record.entrySizing?.amountIn ??
          quoteUnitsForUsd(
            String(policy.tradeSizeUsd),
            quoteAsset.usdPrice,
            quoteAsset.decimals,
          ).toString(),
        decimalsIn: quoteAsset.decimals,
        decimalsOut: info.decimals,
        slippageBps: this.options.config.maxSlippageBps,
      },
      policy.maxPriceImpactPct,
    );
    const quoteLatencyMs = Date.now() - quoteStart;
    const simulationStart = Date.now();
    if (record.timing) record.timing.quoteReady = Date.now();
    const walletId =
      mode === "PAPER" ? "paper" : (await this.fixedWallet(event.chainId))?.id;
    if (!walletId) throw new Error("WALLET_UNAVAILABLE");
    const walletAddress =
      mode === "PAPER"
        ? undefined
        : (await this.options.wallets.publicWallet(walletId)).address;
    const nativeAsset = this.options.config.quotes[event.chainId]?.find(
      (q) =>
        q.address ===
        this.options.config.execution.nativeUsdQuoteByChain[event.chainId],
    );
    const nativePrice = nativeAsset
      ? await this.prices.resolve(event.chainId, nativeAsset)
      : undefined;
    if (mode !== "PAPER" || this.options.config.requireSellSimulation) {
      const simulationWallet = await this.fixedWallet(event.chainId);
      if (!simulationWallet)
        throw new Error("ROUND_TRIP_SIMULATION_WALLET_REQUIRED");
      const adapter = this.adapters.get(event.chainId)!;
      if (adapter.rpc && adapter.config.evmChainId && trip.sell)
        trip = await new EvmRoundTripSimulator(
          adapter.rpc,
          adapter.config.evmChainId,
        ).simulate(
          trip,
          simulationWallet.address as `0x${string}`,
          this.routes.provider(trip.buy.providerId, event.chainId),
          this.routes.provider(trip.sell.providerId, event.chainId),
          {
            nativeUsd: nativePrice?.usdPrice,
            quoteUsd: quoteAsset.usdPrice,
          },
        );
      if (
        adapter.rpc &&
        event.chainId === "solana" &&
        trip.sell &&
        adapter.config.expectedGenesisHash &&
        this.options.config.execution.solanaMaxFeeLamports &&
        this.options.config.execution.solanaMaxNativeDebitLamports
      )
        trip = await new SolanaRoundTripSimulator(adapter.rpc, {
          genesisHash: adapter.config.expectedGenesisHash,
          allowedPrograms: this.options.config.solana.allowedPrograms,
          allowedAccountOwners:
            this.options.config.execution.solanaAllowedAccountOwners,
          maxFeeLamports: BigInt(
            this.options.config.execution.solanaMaxFeeLamports,
          ),
          maxNativeDebitLamports: BigInt(
            this.options.config.execution.solanaMaxNativeDebitLamports,
          ),
        }).simulate(
          trip,
          simulationWallet.address,
          this.routes.provider(trip.buy.providerId, event.chainId),
          this.routes.provider(trip.sell.providerId, event.chainId),
          {
            nativeUsd: nativePrice?.usdPrice,
            quoteUsd: quoteAsset.usdPrice,
          },
        );
    }
    if (record.timing && trip.evidence === "TRANSACTION_SIMULATION")
      record.timing.simulationComplete = Date.now();

    return {
      trip,
      quoteAsset: { ...quoteAsset, usdPrice: quoteAsset.usdPrice! },
      nativePrice,
      mode,
      walletId,
      walletAddress,
      quoteLatencyMs,
      sellSimulationLatencyMs: Date.now() - simulationStart,
    };
  }
  private reason(error: unknown) {
    return error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "REAL_PIPELINE_FAILED";
  }
  private rugPolicy(chainId: string) {
    return rugPolicySchema.parse({
      ...this.options.config.rugCheck.policy,
      ...this.options.config.rugCheck.policyByChain[chainId],
    });
  }
  async verifySecurity(input: unknown) {
    const request = securityRequestSchema.parse(input),
      adapter = this.adapters.get(request.chainId);
    if (!adapter || (await adapter.healthCheck()).status !== "healthy")
      throw new Error("RPC_IDENTITY_NOT_READY");
    const snapshot = await this.rugEngine.collect(request, {
      identity: {
        chainId: request.chainId,
        address: request.tokenAddress,
        poolAddress: request.poolAddress,
        source: "RPC",
      },
      observedAt: Date.now(),
      market: {},
      holders: {},
      creator: {},
      security: { evidence: [] },
    });
    snapshot.decision = decideRugCheck(
      snapshot,
      this.rugPolicy(request.chainId),
      "PAPER",
      "HARD_FILTER",
    );
    snapshot.reasonCodes = snapshot.decision.reasonCodes;
    return refreshRugSnapshot(snapshot);
  }
  private rememberRug(snapshot: RugCheckSnapshot) {
    const key = `${snapshot.chainId}:${snapshot.tokenAddress}`;
    this.rugSnapshots.delete(key);
    this.rugSnapshots.set(key, snapshot);
    if (this.rugSnapshots.size > this.options.config.maxPools * 20)
      this.rugSnapshots.delete(this.rugSnapshots.keys().next().value!);
  }
  private async exitValuation(
    chainId: string,
    quoteAddress: string,
  ): Promise<ApprovedTradeIntent["valuation"]> {
    const quote = this.options.config.quotes[chainId]?.find(
      (q) => q.address === quoteAddress,
    );
    const current = quote
      ? await this.prices.resolve(chainId, quote)
      : undefined;
    if (!current?.usdPrice) return;
    const native = this.options.config.quotes[chainId]?.find(
      (q) =>
        q.address ===
        this.options.config.execution.nativeUsdQuoteByChain[chainId],
    );
    const nativePrice = native
      ? await this.prices.resolve(chainId, native)
      : undefined;
    return {
      quoteUsdPrice: current.usdPrice,
      nativeUsdPrice: nativePrice?.usdPrice,
      nativeDecimals: chainId === "solana" ? 9 : 18,
    };
  }
  private async portfolioValuation() {
    const positions = this.positions.all();
    const prices = new Map<string, string>();
    for (const position of positions) {
      if (position.state === "CLOSED" || position.state === "FAILED") continue;
      const key = `${position.chainId}:${position.quoteTokenAddress}`;
      if (prices.has(key)) continue;
      const value = await this.exitValuation(
        position.chainId,
        position.quoteTokenAddress,
      );
      if (value) prices.set(key, value.quoteUsdPrice);
    }
    return valuePortfolio(
      this.executions.all(),
      (id) => this.executions.intent(id),
      positions,
      prices,
    );
  }
  private async entrySizing(
    event: TokenDiscoveryEvent,
    quote: TrustedQuoteAsset & { usdPrice: string },
    policy: Settings,
  ) {
    const chainId = event.chainId;
    if (this.hasPendingExecution())
      throw new Error("PENDING_EXECUTION_RECONCILIATION_REQUIRED");
    const wallet = await this.fixedWallet(chainId);
    if (!wallet) throw new Error("WALLET_UNAVAILABLE");
    const clients = new Map(
      [...this.adapters].flatMap(([id, a]) =>
        a.rpc ? [[id, a.rpc] as const] : [],
      ),
    );
    const balance = await new RpcWalletBalanceReader(clients).read(
      wallet,
      chainId,
      quote.type === "NATIVE"
        ? []
        : [{ address: quote.address, decimals: quote.decimals }],
    );
    if (balance.quality !== "REAL" || Date.now() - balance.observedAt > 10000)
      throw new Error("CAPITAL_BALANCE_UNKNOWN");
    const config = this.options.config.execution;
    const reserve = config.nativeFeeReserveByChain[chainId];
    if (!reserve) throw new Error("NATIVE_RESERVE_NOT_CONFIGURED");
    const nativeRequired = BigInt(reserve);
    const amount =
      quote.type === "NATIVE"
        ? balance.nativeAmount
        : balance.tokens.find(
            (t) => t.address.toLowerCase() === quote.address.toLowerCase(),
          )?.amount;
    if (amount === undefined) throw new Error("CAPITAL_BALANCE_UNKNOWN");
    return sizeEntry({
      percent: policy.positionSizePercent,
      tokenIn: quote.address,
      balanceRaw: BigInt(amount),
      reservedRaw: 0n,
      nativeBalanceRaw: BigInt(balance.nativeAmount),
      nativeReserveRaw: nativeRequired,
      spendsNative: quote.type === "NATIVE",
      decimals: quote.decimals,
      quoteUsd: quote.usdPrice,
      observedAt: balance.observedAt,
      maxTradeUsd: policy.maxTradeUsd,
      maxTokenExposureUsd: policy.maxTokenExposureUsd,
    });
  }
  private async entryRisk(record: CandidateRecord, policy: Settings) {
    const reasons = hardFilter(record.state!, policy).reasons;
    if (operationalMode(this.options.env) !== "PAPER") {
      if (!record.entrySizing) reasons.push("POSITION_SIZE_UNKNOWN");
      else
        policy = {
          ...policy,
          tradeSizeUsd: Number(record.entrySizing.costUsd),
        };
    }
    if (
      (record.event.chainId !== "solana" ||
        this.discovery
          .lifecycle(record.event)
          ?.sources.some(
            (source) => source === "pump-fun" || source === "pump-swap",
          )) &&
      hasRecordedTokenEntry(record.event, this.executions.all(), (id) => {
        const intent = this.executions.intent(id);
        return intent
          ? {
              side: intent.side,
              chainId: intent.chainId,
              tokenOut: intent.route.quote.tokenOut,
            }
          : undefined;
      })
    )
      reasons.push("ENTRY_ALREADY_RECORDED");
    if (this.executions.get(`entry:${this.key(record.event)}`))
      reasons.push("ENTRY_ALREADY_RECORDED");
    const marketAt = record.state?.quality?.["market.priceUsd"]?.observedAt;
    if (marketAt === undefined || Date.now() - marketAt > 10000)
      reasons.push("STALE_FEATURES");
    const open = this.positions
      .all()
      .filter((p) => p.state !== "CLOSED" && p.state !== "FAILED");
    if (open.length >= policy.maxPositions) reasons.push("MAX_POSITIONS");
    if (policy.tradeSizeUsd > policy.maxTradeUsd) reasons.push("MAX_TRADE_USD");
    if (policy.tradeSizeUsd > policy.maxTokenExposureUsd)
      reasons.push("TOKEN_EXPOSURE");
    if (
      open.some(
        (p) =>
          p.chainId === record.event.chainId &&
          p.tokenAddress === record.event.tokenAddress,
      )
    )
      reasons.push("TOKEN_EXPOSURE");
    const today = new Date().toISOString().slice(0, 10);
    const trades = this.executions
      .all()
      .filter(
        (e) =>
          e.state === "CONFIRMED" &&
          e.operation !== "APPROVAL" &&
          this.executions.intent(e.intentId)?.side === "BUY" &&
          new Date(e.updatedAt).toISOString().startsWith(today),
      );
    if (trades.length >= policy.maxTradesPerDay) reasons.push("DAILY_TRADES");
    const valuation = await this.portfolioValuation();
    reasons.push(...valuation.reasons);
    if (
      valuation.exposureUsd === undefined ||
      valuation.exposureUsd + policy.tradeSizeUsd >
        policy.maxPortfolioExposureUsd
    )
      reasons.push("PORTFOLIO_EXPOSURE");
    const chainLimit = policy.maxChainExposureUsd[record.event.chainId];
    const chainValue =
      valuation.chainExposureUsd[record.event.chainId] ??
      (open.some((p) => p.chainId === record.event.chainId) ? undefined : 0);
    if (
      chainLimit === undefined ||
      chainValue === undefined ||
      chainValue + policy.tradeSizeUsd > chainLimit
    )
      reasons.push("CHAIN_EXPOSURE");
    if (
      valuation.dailyPnlUsd === undefined ||
      valuation.dailyPnlUsd <= -policy.maxDailyLossUsd
    )
      reasons.push("DAILY_LOSS");
    if (record.score === undefined || record.score.total < policy.minScore)
      reasons.push("LOW_SCORE");
    if (this.ai.healthCheck().status !== "READY") reasons.push("AI_FAILED");
    if (!(await this.options.repository.health()))
      reasons.push("STORAGE_UNHEALTHY");
    const attempts = this.executions
      .all()
      .filter((e) => e.operation !== "APPROVAL")
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const failures = attempts.findIndex((e) => e.state !== "FAILED");
    if (
      (failures < 0 ? attempts.length : failures) >=
      policy.maxFailedTransactions
    )
      reasons.push("FAILED_TRANSACTIONS");
    if (this.hasPendingExecution())
      reasons.push("PENDING_EXECUTION_RECONCILIATION_REQUIRED");
    return { passed: reasons.length === 0, reasons };
  }
  private hasPendingExecution() {
    return this.executions
      .all()
      .some(
        (e) =>
          [
            "APPROVED",
            "BUILDING",
            "SIMULATING",
            "UNKNOWN",
            "SUBMITTING",
            "PENDING",
          ].includes(e.state) ||
          (e.state === "CONFIRMED" &&
            e.operation !== "APPROVAL" &&
            !this.positions.hasApplied(e.id)),
      );
  }
  private async execute(intent: ApprovedTradeIntent) {
    if (this.options.env.OBSERVATION_ONLY)
      throw new Error("OBSERVATION_EXECUTION_DISABLED");
    if (intent.mode === "PAPER") return this.paper.execute(intent);
    if (
      intent.mode === "LIVE" &&
      !this.options.config.execution.liveChains.includes(
        intent.chainId as "solana" | "bnb" | "robinhood",
      )
    )
      throw new Error("LIVE_CHAIN_NOT_ACTIVATED");
    if (intent.chainId === "solana") {
      if (!this.solanaExecutor) throw new Error("LIVE_EXECUTOR_NOT_READY");
      const result = await this.solanaExecutor.execute(
        intent,
        this.routes.provider(intent.route.providerId, intent.chainId),
      );
      await this.checkExecutionSafety(result);
      return result;
    }
    const executor = this.evmExecutors.get(intent.chainId);
    if (!executor) throw new Error("LIVE_EXECUTOR_NOT_READY");
    const result = await executor.execute(
      intent,
      this.routes.provider(intent.route.providerId, intent.chainId),
    );
    await this.checkExecutionSafety(result);
    return result;
  }
  private async tripEntrySafety(reason: string) {
    this.entrySafetyReason = reason;
    await this.setKillSwitch(true);
    this.emit("kill_switch", { scope: "ENTRY_DISABLED", active: true, reason });
  }
  private async checkExecutionSafety(
    record: import("@sniper/core").ExecutionRecord,
  ) {
    if (record.mode !== "LIVE") return;
    if (["UNKNOWN", "SUBMITTING", "PENDING"].includes(record.state)) {
      await this.tripEntrySafety("AMBIGUOUS_EXECUTION");
      return;
    }
    if (record.state === "FAILED") {
      const recent = this.executions
        .all()
        .filter((r) => r.operation !== "APPROVAL")
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const n = recent.findIndex((r) => r.state !== "FAILED");
      if (
        record.reasons.some((r) => /NONCE|RECEIPT|BALANCE.*MISMATCH/.test(r)) ||
        (n < 0 ? recent.length : n) >= this.settings.maxFailedTransactions
      )
        await this.tripEntrySafety("EXECUTION_FAILURE_THRESHOLD");
    }
  }
  async closePosition(
    id: string,
    reason = "MANUAL_CLOSE",
    fractionBps = 10000,
    exactAmount?: string,
    level?: number,
  ) {
    if (this.options.env.OBSERVATION_ONLY)
      throw new Error("OBSERVATION_EXECUTION_DISABLED");
    const job = this.closingPositions.run(id, async () => {
      const position = this.positions.get(id);
      if (
        !position ||
        position.state === "CLOSED" ||
        position.state === "FAILED" ||
        this.allTradingDisabled
      )
        throw new Error("POSITION_EXIT_UNAVAILABLE");
      if (position.mode === "LIVE" && !this.options.env.LIVE_TRADING_ACK)
        throw new Error("LIVE_ACK_REQUIRED");
      if (
        !Number.isInteger(fractionBps) ||
        fractionBps <= 0 ||
        fractionBps > 10000
      )
        throw new Error("EXIT_FRACTION_INVALID");
      if (level !== undefined && position.takenLevels.includes(level))
        throw new Error("TAKE_PROFIT_ALREADY_APPLIED");
      const amount =
        exactAmount === undefined
          ? (BigInt(position.remainingQuantity) * BigInt(fractionBps)) / 10000n
          : BigInt(exactAmount);
      if (amount > BigInt(position.remainingQuantity))
        throw new Error("EXIT_OVERSELL");
      if (amount === 0n) throw new Error("EXIT_AMOUNT_TOO_SMALL");
      const previous = this.executions.all().filter((record) => {
        const intent = this.executions.intent(record.intentId);
        return intent?.side === "SELL" && intent.positionId === id;
      });
      if (
        previous.some(
          (record) =>
            !["FAILED", "CONFIRMED", "DRY_RUN_SUCCEEDED"].includes(
              record.state,
            ),
        )
      )
        throw new Error("PENDING_EXIT_RECONCILIATION_REQUIRED");
      const quote = await this.routes.quote(
        {
          chainId: position.chainId,
          tokenIn: position.tokenAddress,
          tokenOut: position.quoteTokenAddress,
          nativeOutput:
            this.options.config.quotes[position.chainId]?.find(
              (q) => q.address === position.quoteTokenAddress,
            )?.type === "NATIVE",
          walletAddress: position.walletAddress,
          amountIn: amount.toString(),
          decimalsIn: position.decimals,
          decimalsOut: position.quoteDecimals,
          slippageBps: this.options.config.maxSlippageBps,
        },
        this.settings.maxPriceImpactPct,
      );
      const trip: RoundTripResult = {
        buy: quote,
        sellability: "UNKNOWN",
        evidence: "QUOTE_ONLY",
        reasons: [],
      };
      const valuation = await this.exitValuation(
        position.chainId,
        position.quoteTokenAddress,
      );
      const intent = await this.commits.run(async () => {
        const current = this.positions.get(id);
        if (
          !current ||
          current.remainingQuantity !== position.remainingQuantity
        )
          throw new Error("EXIT_POSITION_CHANGED");
        const intent = this.authority.approve({
          decisionId: randomUUID(),
          risk: { passed: true, reasons: [reason] },
          walletId: position.walletId,
          walletAddress: position.walletAddress,
          side: "SELL",
          mode: position.mode,
          roundTrip: trip,
          maxSlippageBps: this.options.config.maxSlippageBps,
          maxPriceImpactPct: this.settings.maxPriceImpactPct,
          maxRoundTripLossPct: this.options.config.maxRoundTripLossPct,
          idempotencyKey: `exit:${position.id}:${position.remainingQuantity}:${previous.length}`,
          positionId: position.id,
          exitLevel: level,
          valuation,
        });
        await this.executions.begin(intent);
        return intent;
      });
      const execution = await this.execute(intent).catch(async () => {
        const record = this.executions.get(intent.idempotencyKey)!;
        return this.executions.put({
          ...record,
          state: record.transactionId ? "UNKNOWN" : "FAILED",
          reasons: ["EXIT_EXECUTION_FAILED"],
          updatedAt: Date.now(),
        });
      });
      if (execution.state === "CONFIRMED")
        await this.commits.run(async () => {
          await this.positions.applyFill(execution, intent, this.settings);
          this.portfolioRevision++;
          this.authority.invalidate();
        });
      this.emit(
        "position_exit",
        { positionId: id, reason, state: execution.state },
        position.chainId,
      );
      return execution;
    });
    this.closeJobs.add(job);
    void job.then(
      () => this.closeJobs.delete(job),
      () => this.closeJobs.delete(job),
    );
    return job;
  }
  async readiness(): Promise<LiveReadiness> {
    if (this.options.env.OBSERVATION_ONLY) {
      const ai = this.ai.healthCheck();
      return {
        mode: "PAPER",
        ready: false,
        checkedAt: Date.now(),
        items: [
          {
            component: "EXECUTOR",
            required: true,
            status: "FAIL",
            reasons: ["OBSERVATION_EXECUTION_DISABLED"],
          },
          {
            component: "JEV",
            required: false,
            status: ai.status === "READY" ? "READY" : "FAIL",
            reasons: ai.reasons,
          },
          {
            component: "RPC",
            required: false,
            status: [...this.adapters.values()].some(
              (a) => a.peekHealth().status === "healthy",
            )
              ? "READY"
              : "FAIL",
            reasons: [],
          },
          {
            component: "STORAGE",
            required: true,
            status: (await this.options.repository.health()) ? "READY" : "FAIL",
            reasons: [],
          },
        ],
      };
    }
    const mode = operationalMode(this.options.env);
    const active = this.adapters.get(this.settings.activeChain);
    const health = await active?.healthCheck();
    const ai = this.ai.healthCheck();
    const quoteResults = await Promise.all(
      (this.options.config.quotes[this.settings.activeChain] ?? []).map((q) =>
        this.prices.resolve(this.settings.activeChain, q),
      ),
    );
    const quotes = quoteResults
      .filter((q) => q !== undefined)
      .filter(
        (q) =>
          mode === "PAPER" ||
          productionPriceAllowed(this.settings.activeChain, q),
      );
    const walletId = (await this.fixedWallet(this.settings.activeChain))?.id;
    const walletHealth = walletId
      ? await this.options.wallets.health(walletId, this.settings.activeChain)
      : undefined;
    const wallet = (await this.options.wallets.list()).find(
      (w) => w.id === walletId && w.chains.includes(this.settings.activeChain),
    );
    const venueHealth = await Promise.all(
      this.providers
        .filter((p) => p.chainId === this.settings.activeChain)
        .map((p) => p.healthCheck()),
    );
    const providerReady = venueHealth.some((h) => h.status === "READY");
    const executorReady =
      this.settings.activeChain === "solana"
        ? !!this.solanaExecutor
        : this.evmExecutors.has(this.settings.activeChain);
    const portfolio = await this.portfolioValuation();
    const rugReady =
      this.options.config.rugCheck.enabled &&
      securityReadiness(
        [this.settings.activeChain],
        [...this.rugSnapshots.values()],
        this.rugPolicy(this.settings.activeChain).maxEvidenceAgeMs,
      ).some((r) => r.ready);
    const items: LiveReadiness["items"] = [
      {
        component: "CHAIN_ACTIVATION",
        required: mode === "LIVE",
        status:
          mode !== "LIVE" ||
          this.options.config.execution.liveChains.includes(
            this.settings.activeChain,
          )
            ? "READY"
            : "FAIL",
        reasons:
          mode === "LIVE" &&
          !this.options.config.execution.liveChains.includes(
            this.settings.activeChain,
          )
            ? ["LIVE_CHAIN_NOT_ACTIVATED"]
            : [],
      },
      {
        component: "RUG_CHECK",
        required: true,
        status: rugReady ? "READY" : "FAIL",
        reasons: rugReady
          ? []
          : this.options.config.rugCheck.enabled
            ? ["MANDATORY_SECURITY_COVERAGE_REQUIRED"]
            : ["RUG_CHECK_DISABLED"],
      },
      {
        component: "RPC",
        required: true,
        status: health?.status === "healthy" ? "READY" : "FAIL",
        reasons:
          health?.status === "healthy"
            ? []
            : [health?.detail ?? "CHAIN_MISSING"],
      },
      {
        component: "CONFIG",
        required: true,
        status: this.options.configurationLoaded ? "READY" : "FAIL",
        reasons: this.options.configurationLoaded
          ? []
          : ["REAL_CONFIG_MISSING"],
      },
      {
        component: "DEX_DISCOVERY",
        required: true,
        status: this.options.config.deployments.some(
          (d) => d.enabled && d.chainId === this.settings.activeChain,
        )
          ? "READY"
          : "FAIL",
        reasons: this.options.config.deployments.some(
          (d) => d.enabled && d.chainId === this.settings.activeChain,
        )
          ? []
          : ["VERIFIED_DEPLOYMENT_MISSING"],
      },
      {
        component: "QUOTE_USD_PRICE",
        required: true,
        status: quotes.some(
          (q) =>
            q.usdPrice &&
            q.priceSource &&
            q.priceVerifiedAt &&
            Date.now() - q.priceVerifiedAt <= 60000,
        )
          ? "READY"
          : "FAIL",
        reasons: quotes.some(
          (q) =>
            q.usdPrice &&
            q.priceSource &&
            q.priceVerifiedAt &&
            Date.now() - q.priceVerifiedAt <= 60000,
        )
          ? []
          : ["FRESH_QUOTE_USD_PRICE_REQUIRED"],
      },
      {
        component: "JEV",
        required: true,
        status: ai.status === "READY" ? "READY" : "FAIL",
        reasons: ai.reasons,
      },
      {
        component: "STORAGE",
        required: true,
        status: (await this.options.repository.health()) ? "READY" : "FAIL",
        reasons: [],
      },
      {
        component: "WEBSOCKET",
        required:
          mode !== "PAPER" &&
          this.options.config.execution.requireWebsocketForLive,
        status: !this.running
          ? "NOT_STARTED"
          : active?.socketHealth().status === "READY"
            ? "READY"
            : this.options.config.execution.requireWebsocketForLive
              ? "FAIL"
              : "DEGRADED",
        reasons: !this.running
          ? ["WS_NOT_STARTED"]
          : (active?.socketHealth().reasons ?? ["CHAIN_MISSING"]),
      },
      {
        component: "SWAP_PROVIDER",
        required: true,
        status: providerReady ? "READY" : "FAIL",
        reasons: providerReady
          ? []
          : venueHealth.length
            ? venueHealth.flatMap((h) => h.reasons)
            : ["VERIFIED_SWAP_PROVIDER_MISSING"],
      },
      {
        component: "QUOTE_ENGINE",
        required: true,
        status: providerReady && quotes.length > 0 ? "READY" : "FAIL",
        reasons:
          providerReady && quotes.length > 0 ? [] : ["QUOTE_ENGINE_NOT_READY"],
      },
      {
        component: "WALLET",
        required: mode !== "PAPER" || this.options.config.requireSellSimulation,
        status: wallet ? "READY" : "FAIL",
        reasons: wallet ? [] : ["FIXED_WALLET_NOT_CONFIGURED"],
      },
      {
        component: "SIGNER",
        required: mode !== "PAPER",
        status: walletHealth?.status === "READY" ? "READY" : "FAIL",
        reasons: walletHealth?.reasons ?? ["SIGNER_UNAVAILABLE"],
      },
      {
        component: "RISK_ENGINE",
        required: true,
        status: portfolio.reasons.length === 0 ? "READY" : "FAIL",
        reasons: portfolio.reasons,
      },
      {
        component: "KILL_SWITCH",
        required: true,
        status:
          this.entryDisabled || this.allTradingDisabled ? "FAIL" : "READY",
        reasons: this.allTradingDisabled
          ? ["ALL_TRADING_DISABLED"]
          : this.entryDisabled
            ? ["ENTRY_DISABLED"]
            : [],
      },
      {
        component: "EXECUTOR",
        required: mode !== "PAPER",
        status: executorReady ? "READY" : "FAIL",
        reasons: executorReady
          ? []
          : ["EXECUTION_FEE_OR_PROGRAM_POLICY_MISSING"],
      },
      {
        component: "LIVE_AUTHORIZATION",
        required: mode === "LIVE",
        status: this.options.env.LIVE_TRADING_ACK ? "READY" : "FAIL",
        reasons: this.options.env.LIVE_TRADING_ACK ? [] : ["LIVE_ACK_REQUIRED"],
      },
    ];
    const recentDryRun = this.executions
      .all()
      .some(
        (r) =>
          r.chainId === this.settings.activeChain &&
          r.state === "DRY_RUN_SUCCEEDED" &&
          r.simulation?.evidence === "BALANCE_DELTA" &&
          Date.now() - r.updatedAt < 60000,
      );
    const liveDryRunReady =
      recentDryRun && items.every((i) => !i.required || i.status === "READY");
    return {
      mode,
      ready: items.every((i) => !i.required || i.status === "READY"),
      liveDryRunReady,
      liveReady: false,
      capabilities: {
        CONFIG_READY: this.options.configurationLoaded ? "READY" : "BLOCKED",
        RPC_READY: health?.status === "healthy" ? "READY" : "BLOCKED",
        SIGNER_READY: walletHealth?.status === "READY" ? "READY" : "BLOCKED",
        QUOTE_READY: recentDryRun ? "READY" : "PARTIAL",
        ROUND_TRIP_READY: recentDryRun ? "READY" : "BLOCKED",
        SECURITY_READY: rugReady ? "READY" : "BLOCKED",
        RISK_READY: liveDryRunReady ? "READY" : "BLOCKED",
        BUILD_TX_READY: recentDryRun ? "READY" : "BLOCKED",
        SIMULATION_READY: recentDryRun ? "READY" : "BLOCKED",
        SIGNING_READY: "PARTIAL",
        BROADCAST_READY: "LOCKED",
        CONFIRMATION_READY: "CANARY_REQUIRED",
      },
      items,
      checkedAt: Date.now(),
    };
  }
  async snapshot(): Promise<DashboardSnapshot> {
    const chains = await Promise.all(
      this.options.chains.map(async (chain) => ({
        id: chain.id,
        name: chain.name,
        enabled: chain.enabled,
        websocket: this.adapters.get(chain.id)!.socketHealth(),
        health: this.options.env.OBSERVATION_ONLY
          ? this.adapters.get(chain.id)!.peekHealth()
          : await this.adapters.get(chain.id)!.healthCheck(),
      })),
    );
    const ai = this.ai.healthCheck();
    const positions = this.positions.all();
    const readiness = await this.readiness();
    const accounting = await this.portfolioValuation();
    const healthy = (detail: string) => ({
      status: "healthy" as const,
      detail,
      checkedAt: Date.now(),
    });
    return {
      mode: operationalMode(this.options.env),
      source: "RPC",
      liveAcknowledged: this.options.env.LIVE_TRADING_ACK,
      liveEntryChains:
        operationalMode(this.options.env) === "LIVE"
          ? this.options.config.execution.liveChains
          : [],
      liveEnabled:
        !this.options.env.OBSERVATION_ONLY &&
        operationalMode(this.options.env) === "LIVE" &&
        readiness.ready,
      observation: this.options.env.OBSERVATION_ONLY
        ? {
            enabled: true,
            budgetUsd: "5",
            futurePositionSizePercent: 10,
            scanners: [...this.observationScanners.values()].map((scanner) => {
              const health = chains.find(
                (c) => c.id === scanner.chainId,
              )?.health;
              return health?.status === "unhealthy"
                ? {
                    ...scanner,
                    status: "ERROR" as const,
                    reason: health.detail,
                  }
                : scanner;
            }),
            trades: this.virtualBook.all(),
            startedAt: this.observationStartedAt,
            noWalletRequired: true,
            executionDisabled: true,
          }
        : undefined,
      running: this.running,
      activeChain: this.settings.activeChain,
      strategy: this.settings.strategy,
      chains,
      health: {
        scanner: chains.find((c) => c.id === this.settings.activeChain)!.health,
        ai:
          ai.status === "READY"
            ? healthy("Jev đã cấu hình; chưa chứng minh yêu cầu API thành công")
            : {
                status: "unhealthy",
                detail: ai.reasons.join(", "),
                checkedAt: ai.checkedAt,
              },
        database: (await this.options.repository.health())
          ? healthy("Nhật ký bền vững")
          : {
              status: "unhealthy",
              detail: "Lưu trữ lỗi",
              checkedAt: Date.now(),
            },
      },
      killSwitch: {
        active: this.entryDisabled || this.allTradingDisabled,
        reasons: this.allTradingDisabled
          ? ["ALL_TRADING_DISABLED"]
          : this.entryDisabled
            ? [
                "ENTRY_DISABLED",
                ...(this.entrySafetyReason ? [this.entrySafetyReason] : []),
              ]
            : [],
      },
      metrics: {
        detected: this.detectedCount || this.seen.size,
        analyzed: this.totals.analyzed,
        rejected: this.totals.rejected,
        aiCalls: this.totals.aiCalls,
        trades: this.executions
          .all()
          .filter(
            (e) =>
              e.state === "CONFIRMED" &&
              e.operation !== "APPROVAL" &&
              this.executions.intent(e.intentId)?.side === "BUY",
          ).length,
        dailyPnlUsd: accounting.dailyPnlUsd ?? null,
        winRate: accounting.winRate ?? null,
        exposureUsd: accounting.exposureUsd ?? null,
        openPositions: positions.filter(
          (p) => p.state !== "CLOSED" && p.state !== "FAILED",
        ).length,
      },
      discovery: {
        ...this.discovery.summary(),
        evmSources: Object.assign(
          {},
          ...[...this.adapters.values()].map((adapter) =>
            adapter.evmDiscoveryStats(),
          ),
        ),
        watchers: this.adapters.get("solana")?.discoveryStats(),
        queueDepth: this.inbox.size,
        activeAnalysis: this.processingDiscovery.size,
        rpc: Object.fromEntries(
          [...this.adapters].flatMap(([id, adapter]) => [
            ...(adapter.rpc ? [[id, adapter.rpc.stats()]] : []),
            ...(adapter.archiveRpcStats()
              ? [[`${id}-discovery-archive`, adapter.archiveRpcStats()!]]
              : []),
          ]),
        ),
      },
      candidates: latestUniqueCandidates(this.candidates).map((record) => ({
        ...record,
        lifecycle: this.discovery.lifecycle(record.event) ?? record.lifecycle,
      })),
      analytics: strategyAnalytics(
        this.candidates,
        accounting,
        this.executions
          .all()
          .filter(
            (e) =>
              e.state === "CONFIRMED" &&
              e.operation !== "APPROVAL" &&
              this.executions.intent(e.intentId)?.side === "BUY",
          ).length,
        this.detectedCount || this.seen.size,
      ),
      positions: [],
      events: this.events,
      outcomes: this.observations.all().slice(-300),
      managedPositions: positions,
      executions: this.executions.all(),
      readiness,
      rugAnalytics: rugAnalytics(
        [...this.rugSnapshots.values()],
        this.observations.all(),
        new Map(
          this.candidates.flatMap((c) =>
            c.rugCheck ? [[c.id, c.rugCheck] as const] : [],
          ),
        ),
      ),
      securityReadiness: securityReadiness(
        this.options.chains.filter((c) => c.enabled).map((c) => c.id),
        [...this.rugSnapshots.values()],
        this.options.config.rugCheck.policy.maxEvidenceAgeMs,
      ),
      tradingWallet: await this.tradingWalletStatus(),
    };
  }
  history() {
    return [...this.candidates].reverse();
  }
  async historyPage(offset: number, limit: number) {
    if (this.options.repository.page) {
      const result = await this.options.repository.page(
        "real.candidate",
        offset,
        limit,
      );
      return {
        total: result.total,
        records: result.entries.map((e) => candidateSchema.parse(e.payload)),
      };
    }
    const records = this.history();
    return {
      total: records.length,
      records: records.slice(offset, offset + limit),
    };
  }
  private async fixedWallet(chainId: string) {
    const matches = (await this.options.wallets.list()).filter((w) =>
      w.chains.includes(chainId),
    );
    if (matches.length > 1) throw new Error("FIXED_WALLET_AMBIGUOUS");
    return matches[0];
  }
  private async tradingWalletStatus() {
    if (this.options.wallets instanceof TradingWallet)
      return this.options.wallets.publicStatus();
    const status = async (family: "evm" | "solana") => {
      const chain = this.options.chains.find((c) => c.type === family);
      const wallet = chain ? await this.fixedWallet(chain.id) : undefined;
      if (!wallet || !chain) return { signerStatus: "NOT_CONFIGURED" as const };
      const health = await this.options.wallets.health(wallet.id, chain.id);
      return {
        address: wallet.address,
        signerStatus:
          wallet.signerType === "watch-only"
            ? ("WATCH_ONLY" as const)
            : health.status === "READY"
              ? ("READY" as const)
              : ("UNAVAILABLE" as const),
      };
    };
    return { evm: await status("evm"), solana: await status("solana") };
  }
  async balances(chainId: string) {
    const wallet = await this.fixedWallet(chainId);
    if (!wallet) throw new Error("WALLET_UNAVAILABLE");
    const clients = new Map(
      [...this.adapters].flatMap(([id, a]) =>
        a.rpc ? [[id, a.rpc] as const] : [],
      ),
    );
    const balance = await new RpcWalletBalanceReader(clients).read(
      wallet,
      chainId,
    );
    return { ...balance, walletId: undefined };
  }
  startTimers() {
    if (this.timer) return;
    this.inboxTimer = setInterval(() => this.pumpInbox(), 1000);
    this.timer = setInterval(() => {
      void this.reconcilePending().catch(async () => {
        if (operationalMode(this.options.env) === "LIVE")
          await this.tripEntrySafety("RECONCILIATION_UNAVAILABLE");
        this.emit("reconciliation_error", {
          reason: "READ_ONLY_RECONCILIATION_FAILED",
        });
      });
      void this.monitor().catch(() =>
        this.emit("monitor_error", { reason: "REAL_MONITOR_FAILED" }),
      );
    }, 5000);
    this.observationTimer = setInterval(() => {
      void this.observations
        .sample()
        .catch(() =>
          this.emit("observation_error", { reason: "REAL_OBSERVATION_FAILED" }),
        );
    }, 3000);
    this.leaseTimer = setInterval(() => {
      if (this.options.env.OBSERVATION_ONLY)
        for (const adapter of this.adapters.values())
          if (adapter.config.enabled)
            void adapter.healthCheck(false).catch(() => undefined);
      void this.options.repository
        .health()
        .then((ok) => {
          if (!ok) {
            this.entryDisabled = true;
            this.generation++;
            this.authority.invalidate();
            this.emit("storage_unhealthy", { reason: "DATABASE_UNHEALTHY" });
          }
        })
        .catch(() => {
          this.entryDisabled = true;
          this.authority.invalidate();
        });
    }, 30000);
  }
  private async reconcilePending() {
    if (this.reconciling || this.closing) return;
    this.reconciling = true;
    try {
      const wallets = await this.options.wallets.list();
      for (const record of this.executions.all()) {
        if (this.closing) break;
        if (
          !record.transactionId ||
          !["UNKNOWN", "SUBMITTING", "PENDING"].includes(record.state)
        )
          continue;
        const intent = this.executions.intent(record.intentId);
        const wallet = wallets.find(
          (w) => w.id === record.walletId && w.chains.includes(record.chainId),
        );
        const address = intent?.walletAddress ?? wallet?.address;
        if (!intent || !address || record.mode !== "LIVE") continue;
        const updated =
          record.chainId === "solana"
            ? await this.solanaExecutor?.confirm(record, intent, address, false)
            : await this.evmExecutors
                .get(record.chainId)
                ?.confirm(record, intent, address as `0x${string}`, false);
        if (updated?.state === "CONFIRMED" && updated.operation !== "APPROVAL")
          await this.commits.run(async () => {
            await this.positions.applyFill(updated, intent, this.settings);
            this.portfolioRevision++;
            this.authority.invalidate();
          });
      }
    } finally {
      this.reconciling = false;
    }
  }
  private async monitor() {
    if (this.monitoring || this.closing) return;
    if (this.options.env.OBSERVATION_ONLY) {
      this.monitoring = true;
      try {
        await this.monitorObservation();
      } finally {
        this.monitoring = false;
      }
      return;
    }
    this.monitoring = true;
    try {
      await Promise.allSettled(
        this.positions.all().map((position) =>
          this.positionSamples.submit(async () => {
            if (
              position.state === "CLOSED" ||
              position.state === "FAILED" ||
              this.allTradingDisabled
            )
              return;
            try {
              const quote = await this.routes.quote(
                {
                  chainId: position.chainId,
                  tokenIn: position.tokenAddress,
                  tokenOut: position.quoteTokenAddress,
                  amountIn: position.remainingQuantity,
                  decimalsIn: position.decimals,
                  decimalsOut: position.quoteDecimals,
                  slippageBps: this.options.config.maxSlippageBps,
                },
                this.settings.maxPriceImpactPct,
              );
              const gain = ratioToNumber(
                BigInt(quote.minimumAmountOut) * 100n,
                BigInt(position.remainingCostQuoteAmount),
              );
              if (gain === undefined) return;
              await this.commits.run(async () => {
                await this.positions.observeExitQuote(
                  position.id,
                  quote.minimumAmountOut,
                  position.remainingQuantity,
                );
                this.portfolioRevision++;
              });
              const latest = this.positions.get(position.id);
              if (
                !latest ||
                latest.remainingQuantity !== position.remainingQuantity
              )
                return;
              const candidate = [...this.candidates]
                .reverse()
                .find(
                  (c) =>
                    c.event.chainId === position.chainId &&
                    c.event.tokenAddress === position.tokenAddress,
                );
              const market = candidate
                ? this.adapters
                    .get(position.chainId)
                    ?.book.features(candidate.event.id)
                : undefined;
              const state =
                candidate?.state && market
                  ? { ...candidate.state, market, observedAt: Date.now() }
                  : undefined;
              let securityExit = false;
              if (
                candidate &&
                Date.now() - (this.rugMonitored.get(position.id) ?? 0) >=
                  this.options.config.rugCheck.monitorIntervalMs
              ) {
                this.rugMonitored.set(position.id, Date.now());
                try {
                  this.rugEngine.invalidate(
                    position.chainId,
                    position.tokenAddress,
                  );
                  const securityState = await this.features.collect(
                    candidate.event,
                  );
                  const snapshot = await this.rugEngine.collect(
                    {
                      chainId: position.chainId,
                      tokenAddress: position.tokenAddress,
                      poolAddress: candidate.event.poolAddress,
                    },
                    securityState,
                  );
                  const previous = this.rugSnapshots.get(
                    `${position.chainId}:${position.tokenAddress}`,
                  );
                  const prior = previous?.liquidity.usd?.value,
                    current = snapshot.liquidity.usd?.value;
                  if (
                    typeof prior === "number" &&
                    prior > 0 &&
                    typeof current === "number" &&
                    current < prior
                  ) {
                    snapshot.liquidity.recentRemovalPct = measured(
                      ((prior - current) / prior) * 100,
                      "liquidity-observation",
                      "ESTIMATED",
                      ((prior - current) / prior) * 100 >=
                        this.settings.liquidityCollapsePct
                        ? "RISK"
                        : "SAFE",
                    );
                    snapshot.liquidity.recentRemovalPct.reasonCodes = [
                      "LIQUIDITY_DROP_OBSERVED_NOT_PROVEN_LP_REMOVAL",
                    ];
                  }
                  snapshot.decision = decideRugCheck(
                    snapshot,
                    this.rugPolicy(position.chainId),
                    position.mode,
                    "MONITOR",
                  );
                  securityExit = snapshot.decision.decision === "REJECT";
                  await this.append(
                    "rug.monitor",
                    {
                      positionId: position.id,
                      snapshot: refreshRugSnapshot(snapshot),
                    },
                    position.chainId,
                  );
                  // Không thay snapshot entry/AI bằng snapshot monitor chưa phân loại.
                } catch {
                  this.emit(
                    "security_monitor_error",
                    {
                      positionId: position.id,
                      reason: "SECURITY_RECHECK_UNAVAILABLE",
                    },
                    position.chainId,
                  );
                }
              }
              const exit = securityExit
                ? {
                    reason: "SECURITY_DETERIORATION",
                    amount: position.remainingQuantity,
                    level: undefined,
                  }
                : evaluateAtomicExit(
                    latest,
                    quote.minimumAmountOut,
                    Date.now(),
                    state,
                  );
              if (exit && !this.pendingAutomaticExits.has(position.id)) {
                this.pendingAutomaticExits.add(position.id);
                void this.closePosition(
                  position.id,
                  exit.reason,
                  10000,
                  exit.amount,
                  exit.level,
                )
                  .catch(() =>
                    this.emit(
                      "exit_retry",
                      {
                        positionId: position.id,
                        reason: "EXIT_EXECUTION_FAILED",
                      },
                      position.chainId,
                    ),
                  )
                  .finally(() =>
                    this.pendingAutomaticExits.delete(position.id),
                  );
              }
              this.emit("position_mark", {
                positionId: position.id,
                executableQuotePnl: (
                  BigInt(quote.minimumAmountOut) -
                  BigInt(position.remainingCostQuoteAmount)
                ).toString(),
                quoteDecimals: position.quoteDecimals,
                displayQuotePnl: formatUnitsSafe(
                  BigInt(quote.minimumAmountOut) -
                    BigInt(position.remainingCostQuoteAmount),
                  position.quoteDecimals,
                ),
                gainPct: gain - 100,
                source: "RPC",
                networkFees: "UNKNOWN",
              });
            } catch {
              if (position.mode === "LIVE")
                await this.tripEntrySafety("SELL_PATH_UNAVAILABLE");
              this.emit(
                "exit_retry",
                {
                  positionId: position.id,
                  reason: "REAL_SELL_QUOTE_UNAVAILABLE",
                },
                position.chainId,
              );
            }
          }),
        ),
      );
    } finally {
      this.monitoring = false;
    }
  }
  async shutdown() {
    this.closing = true;
    this.running = false;
    this.generation++;
    clearInterval(this.timer);
    clearInterval(this.observationTimer);
    clearInterval(this.leaseTimer);
    clearInterval(this.inboxTimer);
    await Promise.allSettled([...this.accepting.values()]);
    await this.off?.();
    await Promise.allSettled(
      [...this.observationWatches.values()].map((stop) => stop()),
    );
    this.observationWatches.clear();
    await this.observations.stop();
    await this.queue.drain();
    while (this.monitoring || this.reconciling)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await Promise.allSettled([...this.closeJobs]);
    await this.commits.drain();
    for (const adapter of this.adapters.values()) await adapter.disconnect();
    for (const provider of this.providers)
      if (provider instanceof JupiterSwapProvider) provider.close();
    await this.options.repository.close();
  }
}
