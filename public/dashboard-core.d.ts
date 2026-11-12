export interface M1Candle {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number | null;
}

export function normalizeM1Candles(input: unknown, limit?: number): M1Candle[];
export function createChartSelection(): {
  observe(mint: string | null | undefined): string | null;
  select(mint: string | null | undefined): string | null;
  toggle(): boolean;
  readonly following: boolean;
  readonly selectedMint: string | null;
};
