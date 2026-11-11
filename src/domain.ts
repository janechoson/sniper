/** paper remains readable historical state; new sessions use demo or live. */
export type Mode = "paper" | "demo" | "live";
export type TradingMode = "DEMO" | "LIVE";
export type Strategy = "STANDARD" | "KRONOS";
export interface StrategyTrace {
  demoAccountId?: string;
  attemptId?: string;
  ownershipClaimId?: string;
  strategy?: Strategy;
  decisionSource?:
    | "JEV"
    | "KRONOS"
    | "CODEX"
    | "MANUAL"
    | "SECURITY"
    | "PROTECTIVE";
  decisionId?: string;
  decisionAt?: number;
}
export interface BuyOwnershipClaim {
  id: string;
  mode: Mode;
  mint: string;
  attemptId: string;
  strategy: Strategy;
  decisionId: string;
  decisionAt: number;
  claimedAt: number;
  active: boolean;
  reason: "FIRST_BUY_CLAIM";
  resolution?: "FAILED_UNSIGNED" | "CLOSED";
}
export type Evidence<T> =
  | { state: "KNOWN"; value: T }
  | { state: "UNKNOWN" | "NOT_APPLICABLE"; reason: string };
export const known = <T>(value: T): Evidence<T> => ({ state: "KNOWN", value });
export const unknown = <T>(
  reason = "GMGN did not supply this field",
): Evidence<T> => ({ state: "UNKNOWN", reason });
export interface Candidate {
  logo?: string | null;
  discovery?: import("./discovery.js").DiscoveryEvidence;
  mint: string;
  symbol?: string;
  name?: string;
  source: string;
  discoveredAt: number;
  createdAt?: number;
  listing?: Record<string, unknown>;
}
export interface Market {
  at: number;
  price: Evidence<number>;
  priceUsd?: string;
  decimals?: number;
  liquidity: Evidence<number>;
  marketCap: Evidence<number>;
  volume: Evidence<number>;
  buys: Evidence<number>;
  sells: Evidence<number>;
  windows: Record<string, unknown>;
}
export interface Finding {
  level: "CRITICAL" | "WARNING" | "INFO" | "UNKNOWN";
  code: string;
  reason: string;
}
export interface Security {
  at: number;
  findings: Finding[];
  mintRenounced: Evidence<boolean>;
  freezeRenounced: Evidence<boolean>;
  rugRatio: Evidence<number>;
  raw: Record<string, unknown>;
}
export interface Intelligence {
  riskEvidence?: {
    fetchedAt: number;
    freshness: string;
    authority: "BUY_AUTHORIZING";
  };
  holders: {
    count: Evidence<number>;
    top1: Evidence<number>;
    top10: Evidence<number>;
    rows: unknown[];
  };
  creator: {
    address?: string;
    holdPercent: Evidence<number>;
    history: Evidence<unknown>;
  };
  bundlePercent: Evidence<number>;
  sniperPercent: Evidence<number>;
  smartMoney: Evidence<number>;
  kol: Evidence<number>;
  dueDiligence: {
    source: string;
    score: Evidence<number>;
    findings: Finding[];
  };
}
export interface JevDecision {
  action: "BUY" | "SKIP";
  risk: "LOW" | "MEDIUM" | "HIGH";
  suspicious: boolean;
  insufficientData: boolean;
  model: string;
  latencyMs: number;
  at: number;
  inputHash: string;
  momentumScore?: number;
  confidence?: number;
  reasonCodes?: string[];
  positiveFactors?: string[];
  negativeFactors?: string[];
  historicalAssessment?: {
    supportsTrade: boolean;
    assessment: "SUPPORTS" | "OPPOSES" | "NEUTRAL" | "UNAVAILABLE";
    strength: "NONE" | "LOW" | "MEDIUM" | "HIGH";
    similarTradeCount: number;
    summary: string;
  };
}
export type Outcome =
  | "BUY"
  | "SKIP_RUG"
  | "SKIP_RISK"
  | "SKIP_JEV"
  | "SKIP_MARKET"
  | "SKIP_MISSING_CRITICAL_DATA";
export interface RiskResult {
  allowed: boolean;
  outcome: Outcome;
  reason: string;
  at: number;
}
export interface Snapshot extends StrategyTrace {
  kronos?: import("./kronos-strategy.js").KronosDecision;
  manipulationStructure?: import("./manipulation-structure.js").ManipulationStructure;
  attemptId?: string;
  marketHistory?: import("./market-history.js").MarketHistory;
  oneShotStructure?: ReturnType<
    typeof import("./market-history.js").oneShotStructure
  >;
  entryAuthority?: {
    revision: number;
    path: "SNIPER" | "TRENDING";
    policy?: "TRENDING_FINAL_STRUCTURE_V1" | "TRENDING_ONE_SHOT_V1";
    recoveryBypass?: import("./recovery-guard.js").RecoveryBypassMetadata;
  };
  entryDiscoverySource?: "SNIPER" | "TRENDING";
  sniperStructureAtEntry?: import("./sniper-structure.js").StructureWatch;
  gmgnQuality?: import("./gmgn-coordinator.js").SnapshotMeta;
  capitalFlow?: import("./capital-flow.js").CapitalFlowSummary;
  candidate: Candidate;
  market: Market;
  security: Security;
  intelligence: Intelligence;
  jev?: JevDecision;
  tokenExecution?: TokenExecutionReport;
}
export interface Intent extends StrategyTrace {
  positionSizeMode?: "PERCENT" | "SOL";
  positionSizePercent?: number;
  positionSizeSol?: number;
  entryAuthority?: Snapshot["entryAuthority"];
  id: string;
  key: string;
  provider: "GMGN" | "JUPITER";
  mint: string;
  side: "BUY" | "SELL";
  mode: Mode;
  amount: string;
  createdAt: number;
  expiresAt: number;
  snapshotHash: string;
  positionId: string;
  reason: string;
  takeProfitIndex?: number;
  manualRequestId?: string;
  exitOpportunityId?: string;
  jevExitDecisionId?: string;
  exitAuthority?:
    | "MANUAL"
    | "SECURITY"
    | "PROTECTIVE"
    | "JEV"
    | "KRONOS"
    | "CODEX";
}
export interface ManualExitRequest {
  id: string;
  positionId: string;
  mode: Mode;
  sellBps: number;
  createdAt: number;
  state:
    | "REQUESTED"
    | "CLAIMED"
    | "SUBMITTED"
    | "CONFIRMED"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL"
    | "REVIEW_REQUIRED"
    | "CANCELLED";
  baseQuantity?: string;
  amount?: string;
  executionId?: string;
  signature?: string;
  error?: string;
}
export interface ExitOpportunity {
  strategy?: Strategy;
  decisionSource?: "JEV" | "KRONOS" | "CODEX";
  protection?: import("./exit-safety.js").ProtectiveAuthority;
  lifecycle?:
    | "DETECTED"
    | "AUTHORIZED"
    | "WAITING_EXECUTION"
    | "BLOCKED"
    | "REVALIDATING"
    | "SUBMITTED"
    | "RECONCILING"
    | "COMPLETED"
    | "SUPERSEDED";
  retry?: import("./exit-safety.js").ExitRetry;
  id: string;
  kind: "PROTECTIVE" | "TAKE_PROFIT" | "TRAILING" | "STRATEGIC";
  reason: string;
  sellBps: number;
  takeProfitIndex?: number;
  triggeredAt: number;
  triggeredValueLamports?: string;
  decisionId?: string;
}
export interface JevExitDecision {
  exitLiquidityEvidence?: import("./exit-feasibility.js").ExitFeasibility;
  decisionState?:
    | "DECIDED_HOLD"
    | "DECIDED_PARTIAL_SELL"
    | "DECIDED_FULL_SELL"
    | "NO_DECISION_PROVIDER_FAILURE"
    | "NO_DECISION_TIMEOUT"
    | "NO_DECISION_INVALID_RESPONSE"
    | "NO_DECISION_SCHEMA_FAILURE"
    | "NO_DECISION_INSUFFICIENT_DATA"
    | "NO_DECISION_LOW_CONFIDENCE"
    | "SUPERSEDED";
  analystResponse?: unknown;
  evidenceKey?: string;
  inputPriceUsd?: number;
  positionRevision?: number;
  flowSignalKey?: string;
  thesis?: string;
  flowAssessment?: string;
  invalidationSignals?: string[];
  reevaluateOn?: string[];
  observedFlow?: import("./capital-flow.js").CapitalFlowSummary;
  inputAt?: number;
  id: string;
  positionId: string;
  mint: string;
  createdAt: number;
  model: "jev-1.14.0";
  action: "HOLD" | "PARTIAL_SELL" | "FULL_SELL" | "NO_DECISION";
  sellBps: number;
  confidence: number;
  reason: string;
  inputHash: string;
  quantity: string;
  inputValueLamports: string;
  status:
    | "DECIDED"
    | "QUEUED"
    | "EXECUTING"
    | "BACKOFF"
    | "CONFIRMED"
    | "SUPERSEDED"
    | "CANCELLED"
    | "FAILED";
  error?: string;
  latencyMs?: number;
  observed?: {
    smartMoneyObservedAt?: number | null;
    smartMoneyStatus?: string;
    grossPnlKnown?: boolean;
    exitLiquidityStatus?: string;
    trendingRank?: number;
    pnlPercent: number;
    mfePercent: number;
    retracementPercent: number;
    liquidityUsd: number | null;
    volume24h: number | null;
    buyPressure: number | null;
  };
}
export interface Position extends StrategyTrace {
  codexDecision?: import("./chart-store.js").ChartDecision;
  kronosDecision?: import("./kronos-strategy.js").KronosDecision & {
    quantity: string;
    inputTo: number;
    inputPriceUsd?: number;
  };
  logo?: string | null;
  name?: string;
  exitSafety?: import("./exit-safety.js").ExitSafetyEvidence;
  lastAnalystAttempt?: JevExitDecision;
  accountingVersion?: 1;
  accounting?: import("./trade-accounting.js").TradeAccounting;
  signalPriceUsd?: string;
  closedAt?: number;
  grossMfePercent?: number;
  grossMaePercent?: number;
  grossHighWaterLamports?: string;
  smartMoneySupport?: import("./smart-money.js").SmartMoneySupport;
  positionRevision?: number;
  quantityRevision?: number;
  marketRevision?: number;
  flowRevision?: number;
  updatedAt?: number;
  marketUpdatedAt?: number;
  flowUpdatedAt?: number;
  securityUpdatedAt?: number;
  dismissal?: {
    status: "MANUALLY_REMOVED";
    dismissedAt: number;
    dismissedBy: "USER";
    reason: "USER_MANUAL";
  };
  entryDiscoverySource?: "SNIPER" | "TRENDING";
  discoverySourcesAtEntry?: import("./discovery.js").DiscoverySource[];
  sniperStructureAtEntry?: import("./sniper-structure.js").StructureWatch;
  exitLiquidity?: import("./exit-feasibility.js").ExitFeasibility;
  decisionRevision?: number;
  flow?: import("./capital-flow.js").CapitalFlowSummary;
  runner?: import("./legacy-runner-types.js").RunnerSummary;
  lastStrategicExit?: {
    grossPnlKnown?: boolean;
    at: number;
    decisionId: string;
    flowSignalKey?: string;
    pnlPercent?: number;
  };
  id: string;
  provider?: "GMGN" | "JUPITER";
  mint: string;
  symbol?: string;
  source?: string;
  mode: Mode;
  state: "PENDING_ENTRY" | "OPEN" | "PENDING_EXIT" | "CLOSED" | "FAILED";
  quantity: string;
  originalQuantity: string;
  costLamports: string;
  remainingCostLamports: string;
  realizedLamports: string;
  entryAt: number;
  entryPriceUsd?: string;
  entryMarketCap?: number;
  decimals?: number;
  highWaterLamports: string;
  lastValueLamports?: string;
  lastQuoteAt?: number;
  valuationQuantity?: string;
  valuationStatus?: "OBSERVED" | "ESTIMATED_AFTER_FILL" | "STALE";
  mfePercent?: number;
  maePercent?: number;
  initialLiquidity?: number;
  takenProfits: number[];
  exitStatus?: string;
  signature?: string;
  sellSignature?: string;
  nativeActive?: boolean;
  tokenExecution?: TokenExecutionReport;
  pendingExits?: ExitOpportunity[];
  monitoring?: {
    status: "ACTIVE" | "DEGRADED";
    lastAttemptAt: number;
    lastSuccessAt?: number;
    nextCheckAt?: number;
    issue?: FailureInfo;
  };
  jevExit?: JevExitDecision;
  legacyExitReferences?: ExitOpportunity[];
  finalExitAction?: {
    authority:
      | "MANUAL"
      | "SECURITY"
      | "PROTECTIVE"
      | "JEV"
      | "KRONOS"
      | "CODEX";
    reason: string;
    sellBps: number;
    at: number;
    decisionId?: string;
  };
  attention?: {
    status:
      | "NEEDS_ATTENTION"
      | "MONITORING_DEGRADED"
      | "EXIT_PENDING"
      | "UNKNOWN";
    issue: FailureInfo;
    lastChecked: number;
    nextCheckAt: number;
    failureCount: number;
    protectiveExit: "ACTIVE" | "BACKOFF" | "MANUAL_REVIEW" | "RECONCILING";
  };
}
export type FailureScope = "CANDIDATE" | "POSITION" | "TRANSACTION" | "SYSTEM";
export type FailureStage =
  | "DISCOVERY"
  | "DEEP_CHECK"
  | "WATCH"
  | "QUALIFICATION"
  | "PRE_BUY"
  | "POSITION_MONITOR"
  | "PRE_SELL";
export interface FailureInfo {
  code: string;
  scope: FailureScope;
  mint?: string;
  symbol?: string;
  stage: FailureStage;
  reasonCode: string;
  retryable: boolean;
  detectedAt: number;
  details?: Record<string, unknown>;
}
export interface Execution {
  protectiveAuthority?: import("./exit-safety.js").ProtectiveAuthority;
  transactionValidity?: { blockhash?: string; lastValidBlockHeight?: number };
  investigation?: {
    checkedAt: number;
    checks: number;
    receiptAvailable: boolean;
    currentBlockHeight?: number;
    blockhashValid?: boolean;
    signatureStatus?: string;
    result: "CONFIRMED" | "FAILED" | "STILL_POSSIBLY_LIVE" | "UNRESOLVED";
    error?: string;
  };
  fx?: import("./trade-accounting.js").FxEvidence;
  accounting?: import("./trade-accounting.js").FillAccounting;
  exitFeasibility?: import("./exit-feasibility.js").ExitFeasibility;
  id: string;
  intent: Intent;
  state:
    | "CREATED"
    | "SUBMITTED"
    | "PENDING_CONFIRMATION"
    | "CONFIRMED"
    | "FAILED"
    | "UNKNOWN"
    | "AMBIGUOUS";
  before?: { sol: string; tokens: string };
  evidence?: {
    solDelta: string;
    tokenDelta: string;
    feeLamports: string;
    slot?: number;
    simulated?: true;
    quoteAt?: number;
    quoteId?: string;
    transactionBalances?: {
      beforeSol: string;
      afterSol: string;
      beforeTokens: string;
      afterTokens: string;
    };
  };
  signature?: string;
  at: number;
  submittedAt?: number;
  failedFeeLamports?: string;
  error?: string;
  errorDetails?: Record<string, unknown>;
}
export class Blocked extends Error {
  readonly scope: FailureScope = "SYSTEM";
  constructor(
    public code: string,
    public classification: string = "BLOCKED_INFRASTRUCTURE",
  ) {
    super(code);
  }
}
export type CandidateRejectReason =
  | "EXECUTION_UNSIGNED_TIMEOUT"
  | "TOKEN_DATA_INCOMPLETE"
  | "TOKEN_PROVIDER_UNAVAILABLE"
  | "TOKEN_MARKET_INVALID"
  | "TOKEN_ALREADY_OWNED"
  | "CANDIDATE_EXPIRED"
  | "TEMPORARY_RISK_CHANGE"
  | "UNSUPPORTED_TOKEN_PROGRAM"
  | "INVALID_MINT_LAYOUT"
  | "INVALID_TOKEN_ACCOUNT_LAYOUT"
  | "UNSUPPORTED_TOKEN_EXTENSION"
  | "CRITICAL_TOKEN_EXTENSION"
  | "NO_BUY_ROUTE"
  | "NO_PREBUY_EXIT_ROUTE"
  | "SNIPER_STRUCTURE_NOT_CONFIRMED"
  | "EXIT_LIQUIDITY_TOO_THIN"
  | "EXIT_FEASIBILITY_UNAVAILABLE"
  | "EXIT_FEASIBILITY_STALE"
  | "NO_SELL_ROUTE"
  | "TOKEN_SIMULATION_FAILED"
  | "TOKEN_EXECUTION_FAILED"
  | "TOKEN_SAFETY_FAILED"
  | "UNSUPPORTED_TRANSACTION_LAYOUT"
  | "QUOTE_STALE"
  | "TOKEN_DECIMALS_MISMATCH"
  | "CONTROLLED_PRINCIPAL_CAP";
export class CandidateRejected extends Blocked {
  override readonly scope: FailureScope = "CANDIDATE";
  constructor(
    reason: CandidateRejectReason,
    public details: Record<string, unknown> = {},
  ) {
    super(reason, "CANDIDATE_REJECTED");
  }
}
export class ProviderFailure extends Blocked {
  constructor(
    code: string,
    public provider: string,
    public retryable = true,
  ) {
    super(code, "PROVIDER_FAILURE");
  }
}
export interface TokenExtensionReport {
  typeId: number;
  type: string;
  policy:
    | "SUPPORTED_SAFE"
    | "SUPPORTED_WITH_VALIDATION"
    | "UNSUPPORTED"
    | "CRITICAL_RISK";
  reason: string;
  details?: Record<string, unknown>;
}
export interface TokenExecutionReport {
  mint: string;
  tokenProgram: "LEGACY_SPL" | "TOKEN_2022" | "UNSUPPORTED";
  programId: string;
  decimals: number | null;
  initialized: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: TokenExtensionReport[];
  unsupportedExtensions: string[];
  criticalExtensions: string[];
  extensionRisk: "LOW" | "UNSUPPORTED" | "CRITICAL";
  decision: "ALLOW" | "SKIP";
  at: number;
}
