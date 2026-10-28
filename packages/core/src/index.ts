import { z } from "zod";
import { securityFindingSchema } from "./rug-check";
export * from "./production";
export * from "./rug-check";

export type ChainType = "evm" | "solana";
export type Unsubscribe = () => Promise<void>;
export interface HealthStatus {
  status: "healthy" | "unhealthy" | "unconfigured";
  detail: string;
  checkedAt: number;
}
export interface ChainConfig {
  id: string;
  name: string;
  type: ChainType;
  nativeSymbol: string;
  rpcHttpUrl?: string;
  rpcWsUrl?: string;
  enabled: boolean;
  evmChainId?: number;
  expectedGenesisHash?: string;
}
const finite = z.number().finite();
const pct = finite.min(0).max(100);
const nonnegative = finite.nonnegative();
export const securitySchema = z.object({
  validToken: z.boolean().optional(),
  bytecodePresent: z.boolean().optional(),
  mintRisk: z.boolean().optional(),
  freezeRisk: z.boolean().optional(),
  blacklistRisk: z.boolean().optional(),
  upgradeRisk: z.boolean().optional(),
  pauseRisk: z.boolean().optional(),
  transferRestrictionRisk: z.boolean().optional(),
  sellRestrictionRisk: z.boolean().optional(),
  liquidityRisk: pct.optional(),
  creatorRisk: pct.optional(),
  overallRisk: pct.optional(),
  buyTaxPct: pct.optional(),
  sellTaxPct: pct.optional(),
  tokenProgram: z.string().optional(),
  onChainFindings: z.array(securityFindingSchema).max(100).optional(),
  evidence: z.array(z.string()).default([]),
});
export const tokenStateSchema = z.object({
  identity: z.object({
    chainId: z.string().min(1),
    address: z.string().min(1),
    poolAddress: z.string().optional(),
    dexId: z.string().optional(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    ageSec: nonnegative.optional(),
    source: z.enum(["MOCK", "RPC"]),
  }),
  observedAt: nonnegative,
  market: z.object({
    windowEndAt: nonnegative.optional(),
    priceUsd: nonnegative.optional(),
    liquidityUsd: nonnegative.optional(),
    volume5s: nonnegative.optional(),
    volume15s: nonnegative.optional(),
    volume60s: nonnegative.optional(),
    volume300s: nonnegative.optional(),
    buys5s: nonnegative.optional(),
    buys15s: nonnegative.optional(),
    sells5s: nonnegative.optional(),
    sells15s: nonnegative.optional(),
    uniqueBuyers: nonnegative.optional(),
    uniqueSellers: nonnegative.optional(),
    buyVolume15s: nonnegative.optional(),
    sellVolume15s: nonnegative.optional(),
    buySellRatio: nonnegative.optional(),
    priceChange5s: finite.optional(),
    priceChange15s: finite.optional(),
    priceChange60s: finite.optional(),
    liquidityChange15s: finite.optional(),
    whaleSell: z.boolean().optional(),
  }),
  holders: z.object({
    count: nonnegative.int().optional(),
    top1Pct: pct.optional(),
    top5Pct: pct.optional(),
    top10Pct: pct.optional(),
    creatorPct: pct.optional(),
    suspiciousClusterPct: pct.optional(),
    freshWalletPct: pct.optional(),
  }),
  creator: z.object({
    address: z.string().optional(),
    role: z
      .enum(["TOKEN_DEPLOYER", "POOL_CREATOR", "TOKEN_CREATOR"])
      .optional(),
    walletAgeDays: nonnegative.optional(),
    previousTokens: nonnegative.int().optional(),
    suspiciousLaunches: nonnegative.int().optional(),
    liquidityRemovals: nonnegative.int().optional(),
    successfulLaunches: nonnegative.int().optional(),
    // Informational only. Missing stays UNKNOWN; never an approval or exit gate.
    knownBadFunding: z.boolean().optional(),
    reputationScore: pct.optional(),
  }),
  security: securitySchema,
  protocol: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
  quality: z
    .record(
      z.string(),
      z.object({
        quality: z.enum(["REAL", "ESTIMATED", "UNKNOWN"]),
        source: z.string(),
        observedAt: nonnegative,
        detail: z.string().optional(),
      }),
    )
    .optional(),
});
export type NormalizedTokenState = z.infer<typeof tokenStateSchema>;
export type SecurityAnalysis = z.infer<typeof securitySchema>;
export type CreatorProfile = NormalizedTokenState["creator"];
export type HolderAnalysis = NormalizedTokenState["holders"];
export interface TokenInfo {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  totalSupply?: string;
  tokenProgram?: string;
}
export interface LiquidityInfo {
  liquidityUsd?: number;
}
export interface TokenDiscoveryEvent {
  id: string;
  chainId: string;
  tokenAddress: string;
  poolAddress: string;
  dexId: string;
  timestamp: number;
  source: "MOCK" | "RPC";
  quoteTokenAddress?: string;
  transactionId?: string;
  chainTimestamp?: number;
  detectedAt?: number;
  rawEvent?: unknown;
  pairClassification?: "TRUSTED_QUOTE" | "UNKNOWN_PAIR";
  quoteAsset?: {
    address?: string;
    symbol: string;
    type:
      | "NATIVE"
      | "WRAPPED_NATIVE"
      | "STABLECOIN"
      | "TOKENIZED_ASSET"
      | "ERC20"
      | "UNKNOWN";
    trusted: boolean;
  };
}
export interface ChainAdapter {
  readonly chainId: string;
  readonly type: ChainType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  watchNewTokens(
    callback: (event: TokenDiscoveryEvent) => Promise<void>,
  ): Promise<Unsubscribe>;
  getTokenInfo(address: string): Promise<TokenInfo>;
  getLiquidity(address: string): Promise<LiquidityInfo>;
  getHolders(address: string): Promise<HolderAnalysis>;
  analyzeSecurity(address: string): Promise<SecurityAnalysis>;
}
export const tokenDiscoveryEventSchema = z.object({
  id: z.string().min(1).max(400),
  chainId: z.string().min(1).max(64),
  tokenAddress: z.string().min(1).max(150),
  poolAddress: z.string().min(1).max(150),
  dexId: z.string().min(1).max(64),
  timestamp: nonnegative,
  source: z.enum(["MOCK", "RPC"]),
  quoteTokenAddress: z.string().max(150).optional(),
  transactionId: z.string().max(150).optional(),
  chainTimestamp: nonnegative.optional(),
  detectedAt: nonnegative.optional(),
  rawEvent: z.unknown().optional(),
  pairClassification: z.enum(["TRUSTED_QUOTE", "UNKNOWN_PAIR"]).optional(),
  quoteAsset: z
    .object({
      address: z.string().max(150).optional(),
      symbol: z.string().max(32),
      type: z.enum([
        "NATIVE",
        "WRAPPED_NATIVE",
        "STABLECOIN",
        "TOKENIZED_ASSET",
        "ERC20",
        "UNKNOWN",
      ]),
      trusted: z.boolean(),
    })
    .optional(),
});
export interface Decision {
  passed: boolean;
  reasons: string[];
}
export interface PoolEvent {
  chainId: string;
  poolAddress: string;
  tokenAddress: string;
  dexId: string;
  block?: string;
}
export interface PoolState {
  address: string;
  liquidityUsd?: number;
  priceUsd?: number;
}
export interface QuoteRequest {
  chainId: string;
  tokenAddress: string;
  side: "BUY" | "SELL";
  amount: number;
  slippageBps: number;
}
export interface TradeQuote {
  id: string;
  chainId: string;
  tokenAddress: string;
  dexId: string;
  side: "BUY" | "SELL";
  inputAmount: number;
  expectedOutput: number;
  priceUsd: number;
  priceImpactPct: number;
  feeUsd?: number;
  expiresAt: number;
  source: "MOCK" | "RPC";
}
export interface SimulationResult {
  success: boolean;
  receivedAmount?: number;
  reasons: string[];
  source: "MOCK" | "RPC";
}
export interface SwapRequest {
  quote: TradeQuote;
}
export interface SwapResult {
  transactionId: string;
}
export interface DexAdapter {
  readonly id: string;
  readonly chainId: string;
  watchPools(): AsyncIterable<PoolEvent>;
  getPoolState(address: string): Promise<PoolState>;
  getQuote(request: QuoteRequest): Promise<TradeQuote>;
  simulateSwap(request: SwapRequest): Promise<SimulationResult>;
  executeSwap?(request: SwapRequest): Promise<SwapResult>;
}
export const aiClassificationSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    action: z.enum(["BUY", "HOLD", "SKIP"]).optional(),
    suspiciousProbability: finite.min(0).max(1).optional(),
    insufficientDataProbability: finite.min(0).max(1).optional(),
    latencyMs: nonnegative.optional(),
    requestedAt: nonnegative.optional(),
    respondedAt: nonnegative.optional(),
    usage: z
      .object({
        inputTokens: nonnegative.int().optional(),
        outputTokens: nonnegative.int().optional(),
      })
      .optional(),
    questionTypes: z
      .record(z.string(), z.enum(["choice", "score", "noul"]))
      .optional(),
    signal: z.enum(["strong_buy", "buy", "neutral", "avoid"]),
    confidence: finite.min(0).max(1),
    momentumScore: pct.optional(),
    qualityScore: pct.optional(),
    riskScore: pct.optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type AIClassification = z.infer<typeof aiClassificationSchema>;
export interface AIProvider {
  readonly id: string;
  classify(state: NormalizedTokenState): Promise<AIClassification>;
}
export interface ScoreResult {
  total: number;
  components: Record<string, number>;
  weights: Record<string, number>;
}
export interface StrategyContext {
  state: NormalizedTokenState;
  ai: AIClassification;
  score: ScoreResult;
  minimumScore: number;
}
export interface StrategyDecision extends Decision {
  strategyId: string;
  action: "BUY" | "SKIP";
}
export interface TradingStrategy {
  readonly id: string;
  evaluate(context: StrategyContext): Promise<StrategyDecision>;
}
export interface Position {
  id: string;
  chainId: string;
  tokenAddress: string;
  symbol: string;
  dexId: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  investedUsd: number;
  remainingCostUsd: number;
  quantity: string;
  initialQuantity: string;
  openedAt: number;
  highestPriceUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  closedAt?: number;
  exitState: string;
  takenLevels: number[];
  initialLiquidityUsd?: number;
  source: "MOCK" | "RPC";
}
export interface CandidateRecord {
  entrySizing?: import("./production").EntrySizing;
  discoveryGuard?: Decision & { latencyMs: number; deferred?: boolean };
  analysisLatencyMs?: number;
  lifecycle?: {
    identity: string;
    firstSeenAt: number;
    launchedAt?: number;
    graduatedAt?: number;
    sources: string[];
    pools: string[];
    observations?: {
      source: string;
      stage: string;
      pool: string;
      transactionId?: string;
      creator?: string;
      observedAt: number;
      onchainAt: number;
      quoteAsset?: TokenDiscoveryEvent["quoteAsset"];
    }[];
  };
  observation?: {
    stage: string;
    liveBlockingReasons: string[];
    virtualAction?: "BUY" | "WATCH" | "SKIP";
    budgetUsd: "5";
    sellability: "SELLABLE" | "NOT_SELLABLE" | "UNKNOWN";
  };
  rugCheck?: import("./rug-check").RugCheckSnapshot;
  id: string;
  strategyId?: string;
  event: TokenDiscoveryEvent;
  state?: NormalizedTokenState;
  hardFilter?: Decision;
  ai?: AIClassification;
  score?: ScoreResult;
  strategy?: StrategyDecision;
  risk?: Decision;
  quote?: TradeQuote;
  aiAttempted?: boolean;
  simulation?: {
    buy: SimulationResult;
    sell: SimulationResult;
    sellQuote: TradeQuote;
  };
  action: "BUY" | "SKIP" | "REJECT";
  reasons: string[];
  createdAt: number;
  timing?: import("./production").PipelineTiming;
}
export interface DomainEvent {
  id: string;
  type: string;
  timestamp: number;
  chainId?: string;
  tokenAddress?: string;
  positionId?: string;
  data: unknown;
}
export interface OutcomeRecord {
  liquidityByHorizon?: Record<string, number>;
  candidateId: string;
  chainId: string;
  tokenAddress: string;
  createdAt: number;
  initialPriceUsd?: number;
  initialLiquidityUsd?: number;
  prices: Record<string, number>;
  maxGainPct?: number;
  maxDrawdownPct?: number;
  liquidityChangePct?: number;
  completedHorizons: number[];
  lastObservedAt?: number;
  sampledAt?: Record<string, number>;
  missedHorizons?: number[];
}
export interface DashboardSnapshot {
  discovery?: {
    evmSources?: Record<
      string,
      {
        chainId: string;
        source: string;
        status: string;
        detected: number;
        uniqueTokens: number;
        uniqueTokenWindow: number;
        duplicates: number;
        errors: number;
        reconnects: number;
        rpcRequests: number;
        candidates: number;
        invalidEvents: number;
        eventsPerSecond: number;
        candidatesPerSecond: number;
        latencyP50Ms: number | null;
        latencyP95Ms: number | null;
        latencySamples: number;
        lastBlock?: string;
        lastError?: string;
        metricsSince: number;
        latest?: {
          token: string;
          transactionHash: string;
          block: string;
          observedAt: number;
          onchainAt: number;
          normalizedAt: number;
          stage: string;
        };
      }
    >;
    watchers?: Record<
      string,
      {
        pendingSignatures: number;
        droppedHints: number;
        duplicates: number;
        validationFailures: number;
        expired: number;
      }
    >;
    sources: Record<
      string,
      {
        detected: number;
        cheapGuardPass: number;
        cheapRejected: number;
        cheapDeferred: number;
        deepAnalyzed: number;
        rugRejected: number;
        sellabilityPass: number;
        jevAnalyzed: number;
        riskApproved: number;
        paperBought: number;
        reasons: Record<string, number>;
      }
    >;
    queueDepth: number;
    activeAnalysis: number;
    duplicates: number;
    backpressure: number;
    eventsPerSecond: number;
    candidatesPerSecond: number;
    averageDiscoveryLatencyMs: number | null;
    averageAnalysisLatencyMs: number | null;
    rpc: Record<
      string,
      {
        requests: number;
        failures: number;
        requestsPerSecond: number;
        averageLatencyMs: number;
        queueDepth: number;
      }
    >;
  };
  observation?: {
    enabled: true;
    budgetUsd: "5";
    futurePositionSizePercent: 10;
    scanners: {
      chainId: string;
      status: "SCANNING" | "CONNECTING" | "ERROR" | "STOPPED";
      reason?: string;
    }[];
    trades: ObservationTrade[];
    startedAt: number;
    noWalletRequired: true;
    executionDisabled: true;
  };
  tradingWallet?: {
    evm: {
      address?: string;
      signerStatus: "READY" | "WATCH_ONLY" | "NOT_CONFIGURED" | "UNAVAILABLE";
    };
    solana: {
      address?: string;
      signerStatus: "READY" | "WATCH_ONLY" | "NOT_CONFIGURED" | "UNAVAILABLE";
    };
  };
  rugAnalytics?: import("./rug-check").RugAnalytics;
  securityReadiness?: import("./rug-check").SecurityReadinessRow[];
  analytics?: import("./production").StrategyAnalytics;
  mode: import("./production").ExecutionMode;
  source: "MOCK" | "RPC";
  liveEnabled: boolean;
  liveAcknowledged?: boolean;
  liveEntryChains?: string[];
  readiness?: import("./production").LiveReadiness;
  managedPositions?: import("./production").ManagedPosition[];
  executions?: import("./production").ExecutionRecord[];
  running: boolean;
  activeChain: string;
  strategy: string;
  chains: {
    id: string;
    name: string;
    enabled: boolean;
    health: HealthStatus;
    websocket?: import("./production").ProviderHealth;
  }[];
  health: { scanner: HealthStatus; ai: HealthStatus; database: HealthStatus };
  killSwitch: { active: boolean; reasons: string[] };
  metrics: {
    detected: number;
    analyzed: number;
    rejected: number;
    aiCalls: number;
    trades: number;
    dailyPnlUsd: number | null;
    winRate: number | null;
    exposureUsd: number | null;
    openPositions: number;
  };
  candidates: CandidateRecord[];
  positions: Position[];
  events: DomainEvent[];
  outcomes: OutcomeRecord[];
}
export interface ObservationTrade {
  id: string;
  candidateId: string;
  chainId: string;
  tokenAddress: string;
  symbol: string;
  quoteToken: string;
  quoteDecimals: number;
  tokenDecimals: number;
  amountIn: string;
  quantity: string;
  budgetUsd: "5";
  quoteUsdPrice: string;
  openedAt: number;
  closedAt?: number;
  exitQuoteAmount?: string;
  exitReason?: string;
  state: "OPEN" | "CLOSED";
  source: "RPC";
  execution: "SIMULATED";
  sellability: "UNKNOWN";
  liveBlockingReasons: string[];
}
export class DomainError extends Error {
  constructor(
    readonly code:
      | "RPC_ERROR"
      | "DEX_ERROR"
      | "AI_ERROR"
      | "RISK_REJECTION"
      | "SIMULATION_FAILURE"
      | "EXECUTION_FAILURE"
      | "CONFIGURATION_ERROR"
      | "DATABASE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = code;
  }
}
export class EventBus {
  private listeners = new Set<(event: DomainEvent) => void>();
  constructor(
    private readonly onListenerError: (error: unknown) => void = () => {},
  ) {}
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  publish(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
