import { entrySizingSchema, type EntrySizing } from "@sniper/core";
import { parseUnitsSafe, formatUnitsSafe } from "@sniper/shared";

/** Không chuyển coin/token, không tự giảm phần trăm khi vướng cap. */
export function sizeEntry(input: {
  percent: number;
  tokenIn: string;
  balanceRaw: bigint;
  reservedRaw: bigint;
  nativeBalanceRaw: bigint;
  nativeReserveRaw: bigint;
  spendsNative: boolean;
  decimals: number;
  quoteUsd: string;
  observedAt: number;
  maxTradeUsd: number;
  maxTokenExposureUsd: number;
  now?: number;
}): EntrySizing {
  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(input.observedAt) ||
    input.observedAt > now ||
    now - input.observedAt > 10000
  )
    throw new Error("CAPITAL_BALANCE_UNKNOWN");
  if (
    !Number.isFinite(input.percent) ||
    input.percent <= 0 ||
    input.percent > 100
  )
    throw new Error("POSITION_SIZE_PERCENT_INVALID");
  if (
    input.balanceRaw < 0n ||
    input.reservedRaw < 0n ||
    input.nativeReserveRaw <= 0n
  )
    throw new Error("CAPITAL_RESERVATION_INVALID");
  if (input.nativeBalanceRaw < input.nativeReserveRaw)
    throw new Error("INSUFFICIENT_NATIVE_RESERVE");
  const available =
    input.balanceRaw -
    input.reservedRaw -
    (input.spendsNative ? input.nativeReserveRaw : 0n);
  if (available <= 0n) throw new Error("INSUFFICIENT_TRADING_CAPITAL");
  const fraction = parseUnitsSafe(String(input.percent), 8);
  const amount = (available * fraction) / (100n * 10n ** 8n);
  if (amount === 0n) throw new Error("POSITION_SIZE_TOO_SMALL");
  const price = parseUnitsSafe(input.quoteUsd, 18);
  if (price <= 0n) throw new Error("QUOTE_USD_PRICE_UNKNOWN_OR_STALE");
  const divisor = 10n ** BigInt(input.decimals);
  // Làm tròn chi phí lên; cap không bị lọt do làm tròn xuống.
  const cost = (amount * price + divisor - 1n) / divisor;
  if (cost > parseUnitsSafe(String(input.maxTradeUsd), 18))
    throw new Error("MAX_TRADE_USD");
  if (cost > parseUnitsSafe(String(input.maxTokenExposureUsd), 18))
    throw new Error("TOKEN_EXPOSURE");
  return entrySizingSchema.parse({
    percent: input.percent,
    tokenIn: input.tokenIn,
    balanceRaw: input.balanceRaw.toString(),
    reservedRaw: input.reservedRaw.toString(),
    availableRaw: available.toString(),
    nativeReserveRaw: input.nativeReserveRaw.toString(),
    amountIn: amount.toString(),
    costUsd: formatUnitsSafe(cost, 18),
    observedAt: input.observedAt,
  });
}
