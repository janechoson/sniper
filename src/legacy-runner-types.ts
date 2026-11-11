// Historical SQLite payload compatibility only; no workers or retrieval.
import type { JevExitDecision } from "./domain.js";
import type { FlowRegime } from "./capital-flow.js";
interface Review {
  decisionId: string;
  at: number;
  action: string;
  status: JevExitDecision["status"];
  reason: string;
  error?: string;
  sellBps: number;
  flowRegime: FlowRegime | null;
  priceUsd: number | null;
  pnlAtDecision: number | null;
  observedMfePercent: number | null;
  observedMaePercent: number | null;
  lastObservedAt?: number;
  checkpoints: Record<
    string,
    {
      state: "OBSERVED" | "UNAVAILABLE";
      observedAt?: number;
      priceChangePercent?: number;
      phase?: string;
      reason?: string;
    }
  >;
  transitions: Array<{ at: number; regime: FlowRegime }>;
}
interface PartialExit {
  executionId: string;
  decisionId?: string;
  at: number;
  tokensSold: string;
  remainingQuantity: string;
  remainingExposureBps: number;
  walletSolDelta: string;
  authority: string;
}
export interface RunnerSummary {
  positionId: string;
  mint: string;
  mode: string;
  entryAt: number;
  entryPriceUsd: number | null;
  lastPriceUsd: number | null;
  lastObservedAt: number | null;
  marketMultiple: number | null;
  heldPriceMfePercent: number | null;
  heldPriceMaePercent: number | null;
  positionMfePercent: number | null;
  positionMaePercent: number | null;
  remainingExposureBps: number;
  milestones: Record<
    string,
    {
      firstObservedAt: number;
      elapsedMs: number;
      observedReturnPercent: number;
      regime: FlowRegime | null;
    }
  >;
  flowBeforeExpansion: FlowRegime | null;
  flowAtObservedPeak: FlowRegime | null;
  flowBeforeObservedCollapse: FlowRegime | null;
  regimesSeen: FlowRegime[];
  lastLiquidityUsd: number | null;
  lastMarketCapUsd: number | null;
  partialExits: PartialExit[];
  reviews: Review[];
  finalRealizedLamports?: string;
  closedAt?: number;
}
