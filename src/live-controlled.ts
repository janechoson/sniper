import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultSettings, env, settingsSchema } from "./config.js";
import { CONTROLLED_BUY_CAP, ControlledSession } from "./controlled-session.js";
import { Blocked } from "./domain.js";
import { JupiterExecutionProvider, localWallet } from "./execution-provider.js";
import { Executor } from "./executor.js";
import { Gmgn } from "./gmgn.js";
import { size } from "./risk.js";
import { acquireLock, startServer } from "./server.js";
import { SMOKE_MAINNET_GENESIS, SMOKE_USDC } from "./smoke-policy.js";
import { Solana } from "./solana.js";
import { Store } from "./store.js";
import { json, log, safeError, sleep } from "./util.js";

async function preflight() {
  if (env.TRADING_MODE !== "live" || !env.LIVE_TRADING_ACK)
    throw new Blocked("LIVE_TRADING_ACK_REQUIRED_OWNER_ACTION");
  if (!env.SCANNER_ENABLED || !env.NEW_ENTRIES_ENABLED)
    throw new Blocked("SCANNER_AND_ENTRIES_MUST_BE_CONFIGURED_BY_OWNER");
  const wallet = localWallet();
  wallet.secretKey.fill(0);
  const release = acquireLock(env.DATABASE_PATH),
    store = new Store(env.DATABASE_PATH);
  try {
    const settings = settingsSchema.parse(
      store.get("strategyV2") ?? defaultSettings(),
    );
    if (process.argv.includes("--resume")) {
      const rpc = new Solana(),
        walletKey = env.WALLET_PUBLIC_KEY;
      if ((await rpc.connection.getGenesisHash()) !== SMOKE_MAINNET_GENESIS)
        throw new Blocked("RPC_NOT_SOLANA_MAINNET");
      if (store.pending().some((e) => !!e.signature))
        throw new Blocked("PENDING_TRANSACTION_REQUIRES_RECONCILIATION");
      // Existing restart recovery discards unsigned intents; it never broadcasts/replays them.
      await new Executor(store, new Gmgn(), rpc).recover(settings);
      const prior = store.get<{
        positionId?: string;
        buySignature?: string;
        mint?: string;
      }>("controlledLiveRunV1");
      const position = store
        .positions("live")
        .find((p) => p.id === prior?.positionId);
      if (!position || !prior?.buySignature || !prior.mint)
        throw new Blocked("CONTROLLED_RESUME_EVIDENCE_MISSING");
      const status = (
        await rpc.connection.getSignatureStatuses([prior.buySignature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (
        !status ||
        status.err ||
        !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")
      )
        throw new Blocked("CONTROLLED_BUY_RECEIPT_UNRESOLVED");
      if (
        (await rpc.tokenBalance(walletKey, prior.mint)).toString() !==
        position.quantity
      )
        throw new Blocked("CONTROLLED_POSITION_BALANCE_MISMATCH");
      const session = ControlledSession.resume(store);
      // Only the legacy token pause is lifted, supported by persisted unsigned failure evidence.
      const failed = store
        .executions()
        .filter(
          (e) =>
            e.intent.positionId === position.id &&
            e.intent.side === "SELL" &&
            e.state === "FAILED" &&
            !e.signature &&
            !!e.errorDetails,
        )
        .at(-1);
      const legacyReason = `Position monitoring/execution failure: ${failed?.error} · ${position.symbol ?? position.mint} · new BUYs paused; protective exits remain active`;
      if (
        failed?.state === "FAILED" &&
        !failed.signature &&
        failed.errorDetails &&
        store.get("haltScope") == null &&
        store.get("haltReason") === legacyReason
      ) {
        store.set("haltReason", null);
        store.set("haltScope", null);
        store.record("legacy_token_pause_review", position.mint, {
          executionId: failed.id,
          error: failed.error,
          scope: "POSITION",
          at: Date.now(),
        });
      }
      log("CONTROLLED_RESUME_READY", {
        run: session.read(),
        positionId: position.id,
        actualTokenAmount: position.quantity,
        broadcasts: 0,
      });
      return session.id;
    }
    if (
      store.pending().length ||
      store
        .positions("live")
        .some((p) =>
          ["OPEN", "PENDING_ENTRY", "PENDING_EXIT"].includes(p.state),
        )
    )
      throw new Blocked("OPEN_OR_PENDING_TRADE_REQUIRES_RECONCILIATION");
    const rpc = new Solana(),
      gmgn = new Gmgn(),
      provider = new JupiterExecutionProvider(rpc);
    if ((await rpc.connection.getGenesisHash()) !== SMOKE_MAINNET_GENESIS)
      throw new Blocked("RPC_NOT_SOLANA_MAINNET");
    const balance = await rpc.balance(env.WALLET_PUBLIC_KEY),
      amount = size(
        balance,
        BigInt(settings.feeReserveLamports),
        0n,
        settings,
      ).amount;
    if (amount <= 0n) throw new Blocked("INSUFFICIENT_AVAILABLE_SOL");
    if (amount > CONTROLLED_BUY_CAP)
      throw new Blocked("NORMAL_ENTRY_EXCEEDS_CONTROLLED_CAP_NO_RESIZE");
    const candidates = await gmgn.discover();
    if (!candidates[0]) throw new Blocked("GMGN_NO_CANDIDATES");
    await gmgn.info(candidates[0].mint);
    await gmgn.security(candidates[0], settings);
    const quote = await provider.quoteBuy(
      SMOKE_USDC,
      amount,
      settings.slippagePercent * 100,
    );
    await provider.quoteSell(
      SMOKE_USDC,
      BigInt(quote.order.outAmount),
      settings.slippagePercent * 100,
      true,
    );
    await provider.simulate(quote);
    const session = ControlledSession.create(store);
    store.set("newEntriesEnabled", true);
    store.set("haltReason", null);
    store.event(
      "CONTROLLED_LIVE_READY",
      undefined,
      "Owner-authorized single completed scanner trade; principal <= 0.005 SOL; one position; ACK unchanged",
    );
    log("CONTROLLED_PREFLIGHT_READY", {
      run: session.read(),
      wallet: env.WALLET_PUBLIC_KEY,
      balanceLamports: balance,
      nextEntryLamports: amount,
      rpc: rpc.http.health,
      gmgn: gmgn.health,
      jupiter: provider.health,
      probeBroadcasts: 0,
    });
    return session.id;
  } finally {
    store.close();
    release();
  }
}

async function main() {
  const runId = await preflight();
  const app = await startServer({ controlledRunId: runId });
  const store = app.engine.store,
    session = app.engine.executor.controlled!;
  const directory = resolve(dirname(env.DATABASE_PATH));
  mkdirSync(directory, { recursive: true });
  const suffix = process.argv.includes("--resume")
    ? `.resume-${Date.now()}`
    : "";
  const reportPath = resolve(
      directory,
      `controlled-live-${runId}${suffix}.json`,
    ),
    eventsPath = resolve(
      directory,
      `controlled-live-${runId}${suffix}.events.jsonl`,
    );
  let cursor = session.read().startRecordId,
    unknownSince: number | undefined,
    finalReason: string | undefined;
  const seenExecutions = new Map<string, string>();
  const emit = (event: string, data: unknown) => {
    const line = json({ at: Date.now(), event, runId, data });
    appendFileSync(eventsPath, line + "\n", { mode: 0o600 });
    process.stdout.write(line + "\n");
  };
  try {
    while (app.engine.running) {
      const rows = store.db
        .prepare(
          "SELECT id,kind,mint,payload FROM records WHERE id>? ORDER BY id LIMIT 500",
        )
        .all(cursor);
      for (const row of rows) {
        cursor = Number(row.id);
        if (
          [
            "events",
            "token_execution_checks",
            "candidate_rejections",
            "kronos_decisions",
            "risk_decisions",
          ].includes(String(row.kind))
        )
          emit(String(row.kind), {
            mint: row.mint,
            payload: JSON.parse(String(row.payload)),
          });
      }
      const run = session.read();
      const executions = store
        .executions()
        .filter((e) => e.intent.positionId === run.positionId);
      for (const e of executions)
        if (seenExecutions.get(e.id) !== e.state) {
          seenExecutions.set(e.id, e.state);
          emit("EXECUTION_STATE", {
            side: e.intent.side,
            state: e.state,
            signature: e.signature,
            amount: e.intent.amount,
            evidence: e.evidence,
            error: e.error,
          });
        }
      if (run.status === "COMPLETE") break;
      if (run.status === "POSITION_OPEN_FAILURE") {
        const position = store
          .positions("live")
          .find((p) => p.id === run.positionId);
        if (
          !position?.attention ||
          position.attention.issue.scope !== "POSITION"
        ) {
          finalReason = run.sellError ?? "SELL_FAILED";
          break;
        }
      }
      if (run.status === "BLOCKED") {
        finalReason = run.reason ?? "CONTROLLED_RUN_BLOCKED";
        break;
      }
      const unknown = executions.some((e) =>
        ["UNKNOWN", "AMBIGUOUS"].includes(e.state),
      );
      if (unknown) {
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince > 60000) {
          finalReason =
            "UNRESOLVED_TRANSACTION_REQUIRES_RECONCILIATION_NO_RETRY";
          break;
        }
      } else unknownSince = undefined;
      if (!run.buySignature && !store.entriesEnabled()) {
        finalReason = store.get<string>("haltReason") ?? "ENTRIES_DISABLED";
        break;
      }
      await sleep(2000);
    }
  } catch (error) {
    finalReason = safeError(error);
  }
  // Stop further activity before collecting final evidence; never stop merely at submission.
  store.set("newEntriesEnabled", false);
  await app.engine.stop();
  const run = session.read();
  const position = store.positions("live").find((p) => p.id === run.positionId);
  const executions = store
    .executions()
    .filter((e) => e.intent.positionId === run.positionId);
  const confirmed = (side: "BUY" | "SELL") =>
    executions.filter(
      (e) =>
        e.intent.side === side &&
        e.state === "CONFIRMED" &&
        e.signature &&
        e.evidence,
    );
  const checks = store.db
    .prepare(
      "SELECT mint,payload FROM records WHERE id>? AND kind='token_execution_checks'",
    )
    .all(run.startRecordId)
    .map((r) => ({ mint: r.mint, report: JSON.parse(String(r.payload)) }));
  const rejects = store.db
    .prepare(
      "SELECT mint,payload FROM records WHERE id>? AND kind='candidate_rejections'",
    )
    .all(run.startRecordId)
    .map((r) => ({ mint: r.mint, ...JSON.parse(String(r.payload)) }));
  const success =
    run.status === "COMPLETE" &&
    position?.state === "CLOSED" &&
    confirmed("BUY").length === 1 &&
    confirmed("SELL").length > 0;
  let currentTokenBalance: string | null = null;
  if (run.mint)
    try {
      currentTokenBalance = (
        await app.engine.rpc.tokenBalance(env.WALLET_PUBLIC_KEY, run.mint)
      ).toString();
    } catch {
      /* Unknown is never presented as zero. */
    }
  const report = {
    run,
    finishedAt: new Date().toISOString(),
    status: success
      ? "REAL_CONTROLLED_ROUND_TRIP_VERIFIED"
      : "BLOCKED_OR_INCOMPLETE",
    reason: finalReason ?? null,
    candidatesInspected: checks.length,
    token2022Candidates: checks.filter(
      (c) => c.report.tokenProgram === "TOKEN_2022",
    ).length,
    tokenChecks: checks,
    candidateSkips: rejects,
    selectedMint: run.mint ?? null,
    position: position ?? null,
    executions,
    currentTokenBalance,
    scannerStopped: !app.engine.running,
    remainingOpenPosition:
      position && position.state !== "CLOSED" && position.state !== "FAILED"
        ? position
        : null,
  };
  writeFileSync(reportPath, json(report) + "\n", { mode: 0o600, flag: "wx" });
  if (finalReason) session.block(finalReason);
  if (!success && run.buySignature)
    emit("REAL POSITION REMAINS OPEN_OR_REQUIRES_RECONCILIATION", {
      mint: run.mint,
      tokenProgram: position?.tokenExecution?.tokenProgram,
      extensions: position?.tokenExecution?.extensions,
      remainingAmount: position?.quantity ?? "UNKNOWN",
      currentTokenBalance,
      buySignature: run.buySignature,
      sellError: finalReason,
    });
  emit(
    success
      ? "REAL_CONTROLLED_ROUND_TRIP_VERIFIED"
      : "CONTROLLED_STOPPED_INCOMPLETE",
    {
      reportPath,
      status: report.status,
      run: session.read(),
      position: position?.state,
    },
  );
  await app.stop();
  if (!success) process.exitCode = 2;
}
void main().catch((error) => {
  log("CONTROLLED_FATAL_REVIEW_PERSISTED_STATE", {
    reason: safeError(error),
    broadcasts: "UNKNOWN; inspect controlled run and transaction journal",
  });
  process.exitCode = 2;
});
