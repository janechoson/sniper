const pow10 = (decimals: number) => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error("Số chữ số thập phân không hợp lệ");
  return 10n ** BigInt(decimals);
};
export function parseUnitsSafe(value: string, decimals: number): bigint {
  if (value.length > 400 || !/^\d+(\.\d+)?$/.test(value))
    throw new Error("Số thập phân không hợp lệ");
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals)))
    throw new Error("Số lượng có độ chính xác vượt token");
  const result =
    BigInt(whole) * pow10(decimals) +
    BigInt(
      (fraction.slice(0, decimals) + "0".repeat(decimals)).slice(0, decimals) ||
        "0",
    );
  if (result >= 2n ** 256n) throw new Error("Số lượng vượt uint256");
  return result;
}
export function formatUnitsSafe(amount: bigint, decimals: number): string {
  const unit = pow10(decimals);
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const fraction = (value % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${value / unit}${fraction ? "." + fraction : ""}`;
}
export function ratioToNumber(
  numerator: bigint,
  denominator: bigint,
  precision = 12,
): number | undefined {
  if (denominator === 0n) return;
  if (numerator === 0n) return 0;
  for (
    let places = Math.min(18, Math.max(0, precision));
    places >= 0;
    places--
  ) {
    const scale = 10n ** BigInt(places);
    const scaled = (numerator * scale) / denominator;
    if (scaled === 0n) {
      if (places < 18) {
        const finer = (numerator * 10n ** 18n) / denominator;
        if (
          finer !== 0n &&
          finer <= BigInt(Number.MAX_SAFE_INTEGER) &&
          finer >= BigInt(Number.MIN_SAFE_INTEGER)
        )
          return Number(finer) / 1e18;
      }
      return;
    }
    if (
      scaled <= BigInt(Number.MAX_SAFE_INTEGER) &&
      scaled >= BigInt(Number.MIN_SAFE_INTEGER)
    )
      return Number(scaled) / Number(scale);
  }
  return;
}
export function toDisplayNumber(
  amount: bigint,
  decimals: number,
): number | undefined {
  return ratioToNumber(amount, pow10(decimals));
}
export function applySlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10000)
    throw new Error("Trượt giá không hợp lệ");
  return (amount * BigInt(10000 - bps)) / 10000n;
}
export function quoteUnitsForUsd(
  usd: string,
  quoteUsd: string,
  decimals: number,
): bigint {
  const price = parseUnitsSafe(quoteUsd, 18);
  if (price <= 0n) throw new Error("Chưa có giá USD hợp lệ");
  return (parseUnitsSafe(usd, 18) * pow10(decimals)) / price;
}
export function serializePublic(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  );
}
