import { z } from "zod";
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/) }),
});
const nativeMint = "So11111111111111111111111111111111111111112";
/** Native economic delta excludes network fee and net recoverable token-account rent. */
export function solanaNativeReceiptDelta(
  input: unknown,
  wallet: string,
  signature: string,
) {
  const r = z
    .object({
      transaction: z.object({
        signatures: z.array(z.string()),
        message: z.object({ accountKeys: z.array(z.string()) }),
      }),
      meta: z.object({
        fee: amount,
        preBalances: z.array(amount),
        postBalances: z.array(amount),
        preTokenBalances: z.array(token),
        postTokenBalances: z.array(token),
        loadedAddresses: z
          .object({
            writable: z.array(z.string()),
            readonly: z.array(z.string()),
          })
          .optional(),
      }),
    })
    .parse(input);
  if (
    r.transaction.signatures[0] !== signature ||
    r.transaction.message.accountKeys[0] !== wallet
  )
    throw Error("SOLANA_RECEIPT_AUTHORITY_MISMATCH");
  const keys = [
    ...r.transaction.message.accountKeys,
    ...(r.meta.loadedAddresses?.writable ?? []),
    ...(r.meta.loadedAddresses?.readonly ?? []),
  ];
  if (
    r.meta.preBalances.length !== keys.length ||
    r.meta.postBalances.length !== keys.length
  )
    throw Error("SOLANA_RECEIPT_BALANCES_INVALID");
  const rent = (rows: z.infer<typeof token>[], balances: number[]) =>
    rows
      .filter((a) => a.owner === wallet)
      .reduce((sum, a) => {
        const lamports = balances[a.accountIndex];
        if (lamports === undefined)
          throw Error("SOLANA_RECEIPT_BALANCES_INVALID");
        const locked =
          BigInt(lamports) -
          (a.mint === nativeMint ? BigInt(a.uiTokenAmount.amount) : 0n);
        if (locked < 0n) throw Error("SOLANA_RENT_INVALID");
        return sum + locked;
      }, 0n);
  const rentDelta =
    rent(r.meta.postTokenBalances, r.meta.postBalances) -
    rent(r.meta.preTokenBalances, r.meta.preBalances);
  return (
    BigInt(r.meta.postBalances[0]!) -
    BigInt(r.meta.preBalances[0]!) +
    BigInt(r.meta.fee) +
    rentDelta
  );
}
