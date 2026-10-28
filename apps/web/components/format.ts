export const money = (v: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "code",
    maximumFractionDigits: 2,
  }).format(v);
export function discoverySymbol(
  candidate: import("@sniper/core").CandidateRecord,
) {
  const raw = candidate.event.rawEvent;
  const symbol =
    candidate.event.dexId === "pump-fun" &&
    raw &&
    typeof raw === "object" &&
    "symbol" in raw &&
    typeof raw.symbol === "string" &&
    raw.symbol.length <= 13
      ? raw.symbol
      : undefined;
  return candidate.state?.identity.symbol || symbol;
}
export const price = (v: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "code",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(v);
export const shortChain = (id: string) =>
  ({ solana: "SOL", bnb: "BNB", robinhood: "RH" })[id] ?? id;
export const number = (value: number, digits = 0) =>
  new Intl.NumberFormat("vi-VN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
