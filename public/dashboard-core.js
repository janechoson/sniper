const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined)
    e.textContent =
      /token-name/.test(cls || "") || tag === "pre"
        ? String(text)
        : window.BOTText.vi(String(text));
  if (cls) e.className = cls;
  if (cls?.includes("strategy-badge") && ["KRONOS"].includes(text))
    e.dataset.strategy = text;
  return e;
};
const sol = (n) =>
  n === null || n === undefined
    ? "—"
    : (Number(n) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
const num = (n) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, {
        maximumFractionDigits: 4,
        notation: Number(n) > 1e6 ? "compact" : "standard",
      });
const scanNumber = (n) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : Math.trunc(Number(n)).toLocaleString("vi-VN");
const ev = (v) =>
  v?.state === "KNOWN" && Number.isFinite(v.value)
    ? scanNumber(v.value)
    : "UNKNOWN";
const scanPrice = (v) =>
  v?.state === "KNOWN" && Number.isFinite(v.value)
    ? v.value.toLocaleString("vi-VN", { maximumSignificantDigits: 6 })
    : "UNKNOWN";
function tokenQuantity(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0)
    return `${amount} atomic units · decimals unavailable`;
  const value = BigInt(amount)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = decimals ? value.slice(0, -decimals) : value;
  const fraction = decimals ? value.slice(-decimals).replace(/0+$/, "") : "";
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? "." + fraction : "")
  );
}
function pnlText(amount, cost) {
  if (amount === null) return "Awaiting valuation";
  const percent =
    cost > 0n
      ? ` (${(Number((amount * 10000n) / cost) / 100).toFixed(2)}%)`
      : "";
  return `${amount > 0n ? "+" : ""}${sol(amount)} SOL${percent}`;
}
function accountingSol(v) {
  return v === null || v === undefined || !/^-?\d+$/.test(String(v))
    ? "—"
    : sol(v) + " SOL";
}
function accountingUsd(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v))
    ? "—"
    : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 8 });
}
function accountingFeeText(a) {
  if (a?.feesPaidLamports == null) return "—";
  return (
    (a.feeCompleteness === "PARTIAL_OR_UNKNOWN" ? "≥ " : "") +
    accountingSol(a.feesPaidLamports) +
    " · " +
    (a.feesPaidUsd == null ? "—" : "≈ " + accountingUsd(a.feesPaidUsd))
  );
}
function accountingFeeDetails(a) {
  return (
    "Phí đã phát sinh; network gồm priority. USD xấp xỉ theo SOL snapshot.\n" +
    (a?.feeRecords || [])
      .map(
        (f) =>
          f.side +
          ": " +
          accountingSol(f.feeLamports) +
          " / " +
          accountingUsd(f.feeUsd) +
          (f.fx
            ? " · " +
              f.fx.source +
              " · " +
              new Date(f.fx.at).toLocaleString("vi-VN")
            : " · FX: —"),
      )
      .join("\n") +
    "\nPriority split / platform / route / transfer: — khi thiếu bằng chứng. Recoverable rent tách riêng; không cộng price impact/slippage."
  );
}
function accountingEntryPrice(p) {
  const fill = p.accounting?.entry;
  return fill?.priceUsd != null
    ? accountingUsd(fill.priceUsd)
    : fill?.priceSol != null
      ? fill.priceSol + " SOL/token"
      : "—";
}

export {
  el,
  sol,
  num,
  ev,
  scanPrice,
  tokenQuantity,
  pnlText,
  accountingSol,
  accountingUsd,
  accountingFeeText,
  accountingFeeDetails,
  accountingEntryPrice,
};
