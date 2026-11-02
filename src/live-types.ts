import type { ExecutionQuote } from "./execution-provider.js";
import type { FillAccounting } from "./fill-accounting.js";
export type ExecutionState =
  | "CREATED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "UNKNOWN"
  | "RECONCILED"
  | "FAILED"
  | "DRY_RUN";
export interface LiveExecution {
  id: string;
  trialId: string;
  wallet: string;
  mint: string;
  intent: {
    mode: "live";
    side: "BUY" | "SELL";
    amount: string;
    decisionAt: number;
  };
  state: ExecutionState;
  at: number;
  signature?: string;
  before?: { sol: string; tokens: string };
  quote?: ExecutionQuote;
  accounting?: FillAccounting;
  slot?: number;
  error?: string;
  failedFeeLamports?: string;
}
export interface LivePosition {
  id: string;
  mode: "LIVE";
  mint: string;
  wallet: string;
  state: "OPEN" | "CLOSED";
  quantity: string;
  decimals: number;
  entry: FillAccounting;
  exit?: FillAccounting;
  buyDecisionAt: number;
  sellDecisionAt?: number;
  requestedPrincipal: string;
  grossPnlLamports: string | null;
  feesLamports: string | null;
  netPnlLamports: string | null;
  feesPrincipalPct: number | null;
  marketPnlPct: number | null;
  mfePct: number | null;
  maePct: number | null;
  markUsd?: number;
  markAt?: number;
}
