import type { VersionedTransactionResponse } from "@solana/web3.js";
import type { Execution, Position } from "./domain.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

export interface FxEvidence {
  price: string;
  at: number;
  source: string;
}
export interface FillAccounting {
  version: 1;
  side: "BUY" | "SELL";
  executionId: string;
  signature: string | null;
  at: number;
  timestampSource: "BLOCK_TIME" | "RECONCILIATION_TIME";
  quantityAtomic: string;
  tradingLamports: string | null;
  walletDeltaLamports: string;
  networkFeeLamports: string | null;
  recoverableRentDeltaLamports: string | null;
  unclassifiedDebitLamports: string | null;
  feeScope: "IDENTIFIED_NETWORK_TOTAL" | "SIMULATED_NETWORK_TOTAL";
  priorityFeeLamports: null;
  platformFeeLamports: null;
  routeFeeLamports: null;
  transferFeeLamports: null;
  otherExecutionFeeLamports: null;
  fx: FxEvidence | null;
  feeUsd: string | null;
  priceSol: string | null;
  priceUsd: string | null;
  provenance: string;
}
const atomic = (v: unknown) =>
  typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
export const ratioDecimal = (
  n: bigint,
  d: bigint,
  places = 24,
): string | null => {
  if (d <= 0n) return null;
  const sign = n < 0n ? "-" : "",
    a = n < 0n ? -n : n;
  const scaled = (a * 10n ** BigInt(places)) / d;
  const digits = scaled.toString().padStart(places + 1, "0");
  return (
    sign +
    (digits.slice(0, -places) + "." + digits.slice(-places)).replace(
      /\.?0+$/,
      "",
    )
  );
};
function decimal(v: string) {
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [a, b = ""] = v.split(".");
  return { n: BigInt(a! + b), d: 10n ** BigInt(b.length) };
}
export function solUsd(lamports: bigint, fx: FxEvidence | null) {
  const p = fx ? decimal(fx.price) : null;
  return p && p.n > 0n
    ? ratioDecimal(lamports * p.n, 1000000000n * p.d, 12)
    : null;
}
const pct = (n: bigint | null, d: bigint | null) =>
  n === null || d === null || d <= 0n
    ? null
    : Number((n * 100000000n) / d) / 1000000;

/** Net recoverable balance locked in wallet-owned token accounts, including wSOL rent.
 * Called only after signature/local-wallet reconciliation, never from quote estimates.
 * Missing historical account balances remain UNKNOWN. */
export function receiptRentDelta(
  receipt: VersionedTransactionResponse,
  wallet: string,
): bigint | null {
  const m = receipt.meta;
  if (
    !m?.preTokenBalances ||
    !m.postTokenBalances ||
    !m.preBalances ||
    !m.postBalances
  )
    return null;
  const indices = new Set(
    [...m.preTokenBalances, ...m.postTokenBalances]
      .filter((r) => r.owner === wallet)
      .map((r) => r.accountIndex),
  );
  const message = receipt.transaction?.message;
  let keys: ReturnType<typeof message.getAccountKeys> | undefined;
  try {
    keys = message?.getAccountKeys({
      accountKeysFromLookups: m.loadedAddresses,
    });
  } catch {
    return null;
  }
  const key = (i: number | undefined) =>
    i === undefined ? undefined : keys?.get(i)?.toBase58();
  const instructions: Array<{
    program: string | undefined;
    accounts: number[];
    data: Uint8Array;
  }> = [];
  const decode = (value: string | Uint8Array) => {
    if (typeof value !== "string") return value;
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = 0n;
    for (const c of value) {
      const v = alphabet.indexOf(c);
      if (v < 0) return new Uint8Array();
      n = n * 58n + BigInt(v);
    }
    const hex = n.toString(16);
    return Buffer.concat([
      Buffer.alloc(value.match(/^1*/)?.[0].length ?? 0),
      n
        ? Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex")
        : Buffer.alloc(0),
    ]);
  };
  for (const ix of [
    ...(message?.compiledInstructions ?? []),
    ...(m.innerInstructions ?? []).flatMap((x) => x.instructions),
  ]) {
    instructions.push({
      program: key(ix.programIdIndex),
      accounts: [
        ...("accountKeyIndexes" in ix ? ix.accountKeyIndexes : ix.accounts),
      ],
      data: decode(ix.data),
    });
  }
  let rent = 0n;
  for (const i of indices) {
    const before = m.preTokenBalances.find((r) => r.accountIndex === i),
      after = m.postTokenBalances.find((r) => r.accountIndex === i);
    if (
      (before?.owner && before.owner !== wallet) ||
      (after?.owner && after.owner !== wallet)
    )
      return null;
    const a = m.preBalances[i],
      b = m.postBalances[i];
    if (
      !Number.isSafeInteger(a) ||
      !Number.isSafeInteger(b) ||
      a! < 0 ||
      b! < 0
    )
      return null;
    const wrapped = "So11111111111111111111111111111111111111112";
    const nativeBefore =
      before?.mint === wrapped ? atomic(before.uiTokenAmount.amount) : 0n;
    const nativeAfter =
      after?.mint === wrapped ? atomic(after.uiTokenAmount.amount) : 0n;
    if (nativeBefore === null || nativeAfter === null) return null;
    const r0 = BigInt(a!) - nativeBefore,
      r1 = BigInt(b!) - nativeAfter;
    if (r0 < 0n || r1 < 0n) return null;
    if (
      r1 > r0 &&
      !instructions.some(
        (ix) =>
          ix.program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() &&
          ix.accounts[0] === 0 &&
          ix.accounts[1] === i &&
          key(ix.accounts[2]) === wallet &&
          key(ix.accounts[3]) === after?.mint &&
          (ix.data.length === 0 || ix.data[0] === 0 || ix.data[0] === 1) &&
          a === 0,
      )
    )
      return null;
    if (
      r1 < r0 &&
      !instructions.some(
        (ix) =>
          [
            TOKEN_PROGRAM_ID.toBase58(),
            TOKEN_2022_PROGRAM_ID.toBase58(),
          ].includes(ix.program ?? "") &&
          ix.data[0] === 9 &&
          ix.accounts[0] === i &&
          key(ix.accounts[1]) === wallet &&
          key(ix.accounts[2]) === wallet &&
          b === 0,
      )
    )
      return null;
    rent += r1 - r0;
  }
  return rent;
}

export function makeFillAccounting(
  e: Execution,
  sol: bigint,
  tokens: bigint,
  fee: bigint | null,
  rent: bigint | null,
  decimals: number | undefined,
  fx: FxEvidence | null,
  at: number,
  timestampSource: FillAccounting["timestampSource"],
): FillAccounting {
  // The validated BUY is ExactIn; receipt confirms the signed input/token fill.
  // Its principal is independent of additional, possibly unidentified, SOL costs.
  const principal =
    e.intent.side === "BUY"
      ? BigInt(e.intent.amount)
      : fee !== null && rent !== null
        ? sol + fee + rent
        : null;
  const validPrincipal =
    principal !== null && principal >= 0n ? principal : null;
  const quantity = tokens < 0n ? -tokens : tokens;
  const priceSol =
    validPrincipal !== null && decimals !== undefined
      ? ratioDecimal(
          validPrincipal * 10n ** BigInt(decimals),
          quantity * 1000000000n,
        )
      : null;
  const p = fx ? decimal(fx.price) : null;
  const priceUsd =
    validPrincipal !== null && decimals !== undefined && p
      ? ratioDecimal(
          validPrincipal * 10n ** BigInt(decimals) * p.n,
          quantity * 1000000000n * p.d,
        )
      : null;
  return {
    version: 1,
    side: e.intent.side,
    executionId: e.id,
    signature: e.signature ?? null,
    at,
    timestampSource,
    quantityAtomic: quantity.toString(),
    tradingLamports: validPrincipal?.toString() ?? null,
    walletDeltaLamports: sol.toString(),
    networkFeeLamports: fee?.toString() ?? null,
    recoverableRentDeltaLamports: rent?.toString() ?? null,
    unclassifiedDebitLamports:
      e.intent.side === "BUY" && fee !== null && rent !== null
        ? (-sol - BigInt(e.intent.amount) - fee - rent).toString()
        : null,
    feeScope:
      e.intent.mode === "paper"
        ? "SIMULATED_NETWORK_TOTAL"
        : "IDENTIFIED_NETWORK_TOTAL",
    priorityFeeLamports: null,
    platformFeeLamports: null,
    routeFeeLamports: null,
    transferFeeLamports: null,
    otherExecutionFeeLamports: null,
    fx,
    feeUsd: fee === null ? null : solUsd(fee, fx),
    priceSol,
    priceUsd,
    provenance:
      e.intent.mode === "paper"
        ? "PAPER_RECONCILED_FILL"
        : "RECONCILED_EXACT_IN_AND_TRANSACTION_BALANCES",
  };
}

/** Additive projection. Old raw wallet/capital fields remain intact for reconciliation. */
export function tradeAccounting(p: Position, executions: Execution[]) {
  const seen = new Set<string>();
  const relevant = executions.filter(
    (e) => e.intent.positionId === p.id && e.intent.mode === p.mode,
  );
  const fills = relevant
    .filter((e) => e.state === "CONFIRMED" && e.evidence)
    .sort(
      (a, b) =>
        (a.accounting?.at ?? a.at) - (b.accounting?.at ?? b.at) ||
        (a.evidence?.slot ?? 0) - (b.evidence?.slot ?? 0),
    )
    .flatMap((e) => {
      const key = e.signature ?? e.id;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        e.accounting ??
          makeFillAccounting(
            e,
            BigInt(e.evidence!.solDelta),
            BigInt(e.evidence!.tokenDelta),
            atomic(e.evidence!.feeLamports),
            null,
            p.decimals,
            e.fx ?? null,
            e.at,
            "RECONCILIATION_TIME",
          ),
      ];
    });
  const entry = fills.find((f) => f.side === "BUY") ?? null,
    exits = fills.filter((f) => f.side === "SELL");
  const principal =
    entry?.tradingLamports == null ? null : BigInt(entry.tradingLamports);
  const proceedsKnown = exits.every((f) => f.tradingLamports !== null);
  const proceeds = proceedsKnown
    ? exits.reduce((s, f) => s + BigInt(f.tradingLamports!), 0n)
    : null;
  const original = atomic(entry?.quantityAtomic ?? null),
    remaining = atomic(p.quantity);
  const remainingPrincipal =
    principal !== null &&
    original !== null &&
    original > 0n &&
    remaining !== null
      ? (principal * remaining) / original
      : null;
  const allocated =
    principal !== null && remainingPrincipal !== null
      ? principal - remainingPrincipal
      : null;
  const realized =
    proceeds !== null && allocated !== null ? proceeds - allocated : null;
  const value = p.state === "CLOSED" ? 0n : atomic(p.lastValueLamports);
  const unrealized =
    value !== null && remainingPrincipal !== null
      ? value - remainingPrincipal
      : null;
  const gross =
    realized !== null && unrealized !== null ? realized + unrealized : null;
  const feeSignatures = new Set<string>();
  const feeRecords = relevant
    .filter(
      (e) =>
        (e.state === "CONFIRMED" && e.evidence) ||
        e.failedFeeLamports !== undefined,
    )
    .filter((e) => {
      const key = e.signature ?? e.id;
      if (feeSignatures.has(key)) return false;
      feeSignatures.add(key);
      return true;
    })
    .map((e) => ({
      executionId: e.id,
      side: e.intent.side,
      signature: e.signature ?? null,
      at: e.at,
      feeLamports:
        e.accounting?.networkFeeLamports ??
        e.evidence?.feeLamports ??
        e.failedFeeLamports ??
        null,
      feeUsd:
        e.accounting?.feeUsd ??
        (e.failedFeeLamports
          ? solUsd(BigInt(e.failedFeeLamports), e.fx ?? null)
          : null),
      source:
        e.intent.mode === "paper"
          ? "SIMULATED_NETWORK_TOTAL"
          : "RECEIPT_NETWORK_TOTAL_INCLUDES_PRIORITY",
      fx: e.fx ?? e.accounting?.fx ?? null,
    }));
  const feesKnown =
    feeRecords.length > 0 && feeRecords.every((f) => f.feeLamports !== null);
  const fees = feesKnown
    ? feeRecords.reduce((s, f) => s + BigInt(f.feeLamports!), 0n)
    : null;
  // Unknown rents/extra debits prevent claiming exact net accounting.
  const classified =
    fills.length > 0 &&
    fills.every(
      (f) =>
        f.recoverableRentDeltaLamports !== null &&
        (f.unclassifiedDebitLamports === null ||
          f.unclassifiedDebitLamports === "0"),
    );
  const net =
    gross !== null && fees !== null && classified ? gross - fees : null;
  const feeUsdKnown =
    feeRecords.length > 0 && feeRecords.every((f) => f.feeUsd !== null);
  const feesUsd = feeUsdKnown
    ? feeRecords
        .reduce((s, f) => s + Number(f.feeUsd), 0)
        .toFixed(12)
        .replace(/\.?0+$/, "")
    : null;
  const finalExit =
    p.state === "CLOSED" &&
    remaining === 0n &&
    original !== null &&
    exits.reduce((s, f) => s + BigInt(f.quantityAtomic), 0n) === original
      ? ((p.sellSignature
          ? exits.find((f) => f.signature === p.sellSignature)
          : exits.at(-1)) ?? null)
      : null;
  const avgExitPriceSol =
    proceeds !== null && exits.length && p.decimals !== undefined
      ? ratioDecimal(
          proceeds * 10n ** BigInt(p.decimals),
          exits.reduce((s, f) => s + BigInt(f.quantityAtomic), 0n) *
            1000000000n,
        )
      : null;
  return {
    version: 1,
    principalLamports: principal?.toString() ?? null,
    remainingPrincipalLamports: remainingPrincipal?.toString() ?? null,
    grossRealizedPnlLamports: realized?.toString() ?? null,
    grossUnrealizedPnlLamports: unrealized?.toString() ?? null,
    grossPnlLamports: gross?.toString() ?? null,
    grossPnlPct: pct(gross, principal),
    feesPaidLamports: fees?.toString() ?? null,
    feesPaidUsd: feesUsd,
    feeRecords,
    entryFeesLamports: entry?.networkFeeLamports ?? null,
    exitFeesLamports: feesKnown
      ? feeRecords
          .filter((f) => f.side === "SELL")
          .reduce((s, f) => s + BigInt(f.feeLamports!), 0n)
          .toString()
      : null,
    netPnlLamports: net?.toString() ?? null,
    netPnlPct: pct(net, principal),
    recoverableRentDeltaLamports: classified
      ? fills
          .reduce((s, f) => s + BigInt(f.recoverableRentDeltaLamports!), 0n)
          .toString()
      : null,
    feeCompleteness:
      classified && feesKnown
        ? "IDENTIFIED_DEBITS_RECONCILED"
        : "PARTIAL_OR_UNKNOWN",
    entry,
    exits,
    finalExit,
    averageExitPriceSol: avgExitPriceSol,
    closedAt: finalExit?.at ?? null,
    holdMs: entry && finalExit ? finalExit.at - entry.at : null,
    entryPriceUsd: entry?.priceUsd ?? null,
    signalPriceUsd:
      p.signalPriceUsd ??
      (p.accountingVersion ? null : (p.entryPriceUsd ?? null)),
    valuationBasis: "GMGN_MARK_TO_MARKET_NOT_EXECUTABLE_QUOTE",
    limitations: [
      "Network total includes priority; unknown breakdown is not zero",
      "Embedded route fees/price impact/slippage stay in effective execution price; never subtracted twice",
      "Historical missing rent/FX/fee evidence stays unknown",
      "USD uses timestamped SOL snapshot, not guaranteed exact transaction-time FX",
    ],
  };
}
export type TradeAccounting = ReturnType<typeof tradeAccounting>;
