import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../src/config.js";
import { Solana } from "../src/solana.js";
import { json } from "../src/util.js";
import type { SmokeRecord } from "../src/smoke-live.js";
const file = resolve(dirname(env.DATABASE_PATH), "live-smoke-test.json");
const run = JSON.parse(readFileSync(file, "utf8")) as SmokeRecord;
if (
  run.status !== "PASS" ||
  !run.buy.signature ||
  !run.sell.signature ||
  run.wallet !== env.WALLET_PUBLIC_KEY
)
  throw new Error("No matching verified smoke run");
const rpc = new Solana();
const statuses = await rpc.connection.getSignatureStatuses(
  [run.buy.signature, run.sell.signature],
  { searchTransactionHistory: true },
);
const buy = await rpc.receipt(run.buy.signature),
  sell = await rpc.receipt(run.sell.signature);
if (
  !buy?.meta ||
  !sell?.meta ||
  buy.meta.err ||
  sell.meta.err ||
  statuses.value.some(
    (s) =>
      !s ||
      s.err ||
      !["confirmed", "finalized"].includes(s.confirmationStatus ?? ""),
  )
)
  throw new Error("Confirmed receipt evidence unavailable");
const createdTokenAccountRent = (buy.meta.postTokenBalances ?? [])
  .filter((b) => b.owner === run.wallet && b.mint === run.mint)
  .reduce(
    (total, b) =>
      total +
      (buy.meta!.preBalances[b.accountIndex] === 0
        ? BigInt(buy.meta!.postBalances[b.accountIndex]!)
        : 0n),
    0n,
  );
const keys = buy.transaction.message.getAccountKeys({
  accountKeysFromLookups: buy.meta.loadedAddresses,
});
const actualBuyPrincipal = buy.transaction.message.compiledInstructions.reduce(
  (sum, ix) => {
    const data = Buffer.from(ix.data);
    return keys.get(ix.programIdIndex)?.toBase58() ===
      "11111111111111111111111111111111" &&
      keys.get(ix.accountKeyIndexes[0]!)?.toBase58() === run.wallet &&
      data.length === 12 &&
      data.readUInt32LE(0) === 2
      ? sum + data.readBigUInt64LE(4)
      : sum;
  },
  0n,
);
if (actualBuyPrincipal.toString() !== run.principalLamports)
  throw new Error("On-chain BUY principal differs from approved amount");
const evidence = {
  at: new Date().toISOString(),
  wallet: run.wallet,
  mint: run.mint,
  principalLamports: run.principalLamports,
  actualBuyPrincipalLamports: actualBuyPrincipal.toString(),
  buy: {
    signature: run.buy.signature,
    status: statuses.value[0]!.confirmationStatus,
    slot: buy.slot,
    ...rpc.deltas(buy, run.wallet!, run.mint),
    networkFeeLamports: buy.meta.fee,
  },
  sell: {
    signature: run.sell.signature,
    status: statuses.value[1]!.confirmationStatus,
    slot: sell.slot,
    ...rpc.deltas(sell, run.wallet!, run.mint),
    networkFeeLamports: sell.meta.fee,
  },
  tokenAccountRentRetainedLamports: createdTokenAccountRent.toString(),
  currentSolLamports: (await rpc.balance(run.wallet!)).toString(),
  currentTokenBalance: (
    await rpc.tokenBalance(run.wallet!, run.mint)
  ).toString(),
  broadcasts: 0,
};
writeFileSync(file + ".verification.json", json(evidence) + "\n", {
  mode: 0o600,
});
process.stdout.write(json(evidence) + "\n");
