/** DTOs for the existing discovery pipeline. No timers, providers or execution authority. */
export interface TrendingBatchEntry {
  appearanceId: number;
  mint: string;
  status: "WAITING" | "PROCESSING" | "COMPLETE";
  attemptId?: string;
  result?: string;
  endedAt?: number;
}
export interface TrendingBatch {
  id: string;
  mode: string;
  fetchedAt: number;
  legacy: boolean;
  total: number | null;
  entries: TrendingBatchEntry[];
}
export interface TrendingBatchBinding {
  appearanceId: number;
  batchId: string;
}
