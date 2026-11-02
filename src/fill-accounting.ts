import type { VersionedTransactionResponse } from "@solana/web3.js";
import type { LiveExecution as Execution } from "./live-types.js";
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
      String(e.intent.mode) === "paper"
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
      String(e.intent.mode) === "paper"
        ? "PAPER_RECONCILED_FILL"
        : "RECONCILED_EXACT_IN_AND_TRANSACTION_BALANCES",
  };
}
