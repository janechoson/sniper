// Operator maintenance for this migration only. Never called by smoke:live.
// An ambiguous legacy order, signature, changed wallet, or changed balance blocks archival.
import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../src/config.js";
import { Solana } from "../src/solana.js";
import { acquireLock } from "../src/server.js";
import { SMOKE_USDC, SMOKE_MAINNET_GENESIS } from "../src/smoke-policy.js";
import { json, safeError } from "../src/util.js";
import { Blocked } from "../src/domain.js";
const release = acquireLock(env.DATABASE_PATH);
try {
  const root = resolve(dirname(env.DATABASE_PATH));
  const source = resolve(root, "live-smoke-test.json"),
    marker = source + ".once";
  const previous = JSON.parse(readFileSync(source, "utf8"));
  const buy = previous.buy;
  if (
    previous.provider ||
    previous.executionFlow !== "DIRECT_MARKET_SWAP" ||
    previous.reason !== "GMGN_PLAN_UPGRADE_REQUIRED" ||
    buy?.submissionError !== "GMGN_PLAN_UPGRADE_REQUIRED" ||
    buy.order?.orderId ||
    buy.order?.signature ||
    buy.evidence ||
    previous.sell?.submitted ||
    previous.wallet !== env.WALLET_PUBLIC_KEY ||
    Date.now() - Date.parse(previous.finishedAt) < 300000
  )
    throw new Blocked("LEGACY_ATTEMPT_NOT_PROVEN_REJECTED_BEFORE_TRANSACTION");
  for (const b of [previous.initial, buy.before, buy.after, previous.final])
    if (!b || b.sol !== previous.initial.sol || b.tokens !== "0")
      throw new Blocked("LEGACY_BALANCE_EVIDENCE_MISMATCH");
  const rpc = new Solana();
  if ((await rpc.connection.getGenesisHash()) !== SMOKE_MAINNET_GENESIS)
    throw new Blocked("NOT_MAINNET");
  const sol = await rpc.balance(env.WALLET_PUBLIC_KEY),
    tokens = await rpc.tokenBalance(env.WALLET_PUBLIC_KEY, SMOKE_USDC);
  if (sol.toString() !== previous.final.sol || tokens !== 0n)
    throw new Blocked("CURRENT_BALANCES_REQUIRE_MANUAL_RECONCILIATION");
  const archive = resolve(root, "legacy-gmgn-smoke-" + Date.now() + ".json");
  if (dirname(archive) !== root || existsSync(archive))
    throw new Blocked("INVALID_ARCHIVE_TARGET");
  writeFileSync(
    archive + ".review.json",
    json({
      at: new Date().toISOString(),
      reason:
        "GMGN entitlement rejection without order/signature; all recorded and current balances unchanged; new Jupiter test explicitly requested",
      wallet: env.WALLET_PUBLIC_KEY,
      solLamports: sol.toString(),
      tokens: tokens.toString(),
      previousFile: source,
    }),
    { mode: 0o600, flag: "wx" },
  );
  renameSync(source, archive);
  renameSync(marker, archive + ".once");
  process.stdout.write(
    json({
      status: "LEGACY_REJECTION_REVIEWED_AND_ARCHIVED",
      archive,
      solLamports: sol.toString(),
      tokens: tokens.toString(),
      broadcasts: 0,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    json({ status: "BLOCKED", reason: safeError(error) }) + "\n",
  );
  process.exitCode = 2;
} finally {
  release();
}
