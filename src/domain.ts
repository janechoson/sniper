export type Mode = "paper" | "live";

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

export type FailureScope = "CANDIDATE" | "POSITION" | "TRANSACTION" | "SYSTEM";

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
