import type { AttemptStage, StageStatus } from "./candidate-attempt.js";
import { UnsignedExecutionDeadline } from "./execution-deadline.js";
import { randomUUID } from "node:crypto";
import { assertStrategySell } from "./strategy-authority.js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { env, type Settings } from "./config.js";
import {
  Blocked,
  CandidateRejected,
  type Intent,
  type Execution,
  type Snapshot,
  type Position,
} from "./domain.js";
import type { Gmgn } from "./gmgn.js";
import type { Store } from "./store.js";
import type { Solana } from "./solana.js";
import {
  JupiterExecutionProvider,
  validateQuote,
  type SolanaExecutionProvider,
} from "./execution-provider.js";
import type { ControlledSession } from "./controlled-session.js";
import { TradingMemory } from "./trading-memory.js";
import { size, paperQuantity, paperValue } from "./risk.js";
import { hash, safeError, deepFreeze } from "./util.js";
import { probeExits, assertEntryExit } from "./exit-feasibility.js";
import {
  makeFillAccounting,
  receiptRentDelta,
  tradeAccounting,
  type FxEvidence,
} from "./trade-accounting.js";
export const liveAllowed = () =>
  env.TRADING_MODE === "live" && env.LIVE_TRADING_ACK;
export class Executor {
  private reconciliations = new Map<string, Promise<void>>();
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  readonly provider: SolanaExecutionProvider;
  readonly memory: TradingMemory;
  constructor(
    readonly store: Store,
    readonly gmgn: Gmgn,
    readonly rpc: Solana,
    provider?: SolanaExecutionProvider,
    memory?: TradingMemory,
    readonly controlled?: ControlledSession,
  ) {
    this.provider = provider ?? new JupiterExecutionProvider(rpc);
    this.memory = memory ?? new TradingMemory(store);
  }
  private validate(i: Intent) {
    if (i.side === "SELL") {
      const owner = this.store
        .positions(i.mode)
        .find((p) => p.id === i.positionId);
      if (!owner) throw new Blocked("SELL_POSITION_MISSING");
      assertStrategySell(i, owner);
    }
    if (i.side === "BUY")
      this.store.assertEntryAuthority(i.mint, i.mode, i.entryAuthority);
    if (i.side === "BUY") this.store.assertBuyOwnership(i);
    else if (!this.store.positionManaged(i.positionId, i.mode)) {
      const p = this.store.positions(i.mode).find((p) => p.id === i.positionId);
      if (p?.dismissal)
        throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
          mint: i.mint,
          reason: "POSITION_MANUALLY_REMOVED",
        });
      throw new Blocked("SELL_POSITION_MISSING");
    }
    this.controlled?.validate(i);
    if (i.provider !== "JUPITER" || i.mode !== env.TRADING_MODE)
      throw new Blocked("Trade execution mode/provider mismatch");
    if (Date.now() > i.expiresAt)
      throw new CandidateRejected("QUOTE_STALE", { reason: "INTENT_EXPIRED" });
    if (i.side === "BUY" && !this.store.entriesEnabled())
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
        reason: "ENTRY_CONTROL_DISABLED",
      });
    if (i.mode === "live" && !liveAllowed())
      throw new Blocked("LIVE_ACK_REQUIRED");
  }
  async execute(
    intent: Intent,
    s: Settings,
    solUsd: string,
    finalValidation?: () => Promise<void>,
    authorityCheck?: () => void,
    progress?: (stage: AttemptStage, status: StageStatus) => void,
    fx?: FxEvidence,
  ) {
    if (this.busy) throw new Blocked("Another trade is being executed");
    this.busy = true;
    const i = structuredClone(intent);
    const deadline = new UnsignedExecutionDeadline();
    let e: Execution | undefined,
      submitted = false;
    try {
      this.validate(i);
      if (i.side === "BUY") {
        const snap = this.store.latest<Snapshot>("snapshots", i.mint);
        if (
          !snap ||
          hash(snap) !== i.snapshotHash ||
          !finalValidation ||
          (snap.strategy ?? "STANDARD") !== (i.strategy ?? "STANDARD")
        )
          throw new Blocked(
            "Risk-approved snapshot and final validation are required",
          );
        await deadline.wait(finalValidation);
      } else {
        const p = this.store
          .positions(i.mode)
          .find((p) => p.id === i.positionId);
        if (
          !p ||
          p.provider !== "JUPITER" ||
          p.state !== "OPEN" ||
          BigInt(i.amount) <= 0n ||
          BigInt(i.amount) > BigInt(p.quantity)
        )
          throw new Blocked("SELL position/amount mismatch");
        if (finalValidation) await deadline.wait(finalValidation);
      }
      this.validate(i);
      const capital =
        i.side === "BUY"
          ? {
              balance:
                i.mode === "live"
                  ? await deadline.wait(() => this.provider.getWalletBalance())
                  : BigInt(this.store.get<string>("paperCash") ?? "0"),
              reserve: BigInt(s.feeReserveLamports),
            }
          : undefined;
      this.validate(i);
      e = this.store.claim(i, capital);
      deadline.start(e.at);
      e.protectiveAuthority = this.store
        .positions(i.mode)
        .find((p) => p.id === i.positionId)
        ?.pendingExits?.find((o) => o.id === i.exitOpportunityId)?.protection;
      if (
        fx &&
        Number(fx.price) > 0 &&
        fx.at <= Date.now() &&
        Date.now() - fx.at <= s.maxSnapshotAgeMs
      )
        e.fx = fx;
      else if (i.mode === "paper" && Number(solUsd) > 0)
        e.fx = {
          price: solUsd,
          at: Date.now(),
          source: "PAPER_EXECUTION_SOL_SNAPSHOT",
        };
      this.store.execution(e);
      this.controlled?.reserve(i);
      if (i.side === "BUY" && i.mode === "paper")
        this.memory.entry(
          e,
          this.store.latest<Snapshot>("snapshots", i.mint)!,
          s,
        );
      else if (i.side === "SELL")
        this.memory.exit(
          e,
          this.store.positions(i.mode).find((p) => p.id === i.positionId)!,
        );
      if (i.mode === "paper") {
        for (const stage of [
          "BUY_QUOTE",
          "EXIT_FEASIBILITY",
          "VALIDATE",
          "SIMULATE",
          "PRE_SIGN",
        ] as const)
          progress?.(stage, "SKIPPED");
        progress?.("BUY", "CHECKING");
        const snap = this.store.latest<Snapshot>("snapshots", i.mint),
          p = this.store.positions("paper").find((p) => p.id === i.positionId);
        const market =
          i.side === "BUY"
            ? snap?.market
            : this.store.latest<Snapshot["market"]>("position_market", i.mint);
        if (!market?.priceUsd || market.decimals === undefined)
          throw new Blocked(
            "GMGN price/decimals are required for a paper fill",
          );
        const amount = BigInt(i.amount);
        const token =
          i.side === "BUY"
            ? (paperQuantity(amount, solUsd, market.priceUsd, market.decimals) *
                BigInt(100 - s.slippagePercent)) /
              100n
            : -amount;
        const sol =
          i.side === "BUY"
            ? -amount - BigInt(s.paperFeeLamports)
            : (paperValue(amount, solUsd, market.priceUsd, market.decimals) *
                BigInt(100 - s.slippagePercent)) /
                100n -
              BigInt(s.paperFeeLamports);
        if (i.side === "BUY" && token <= 0n)
          throw new Blocked("Paper fill rounds to zero atomic tokens");
        if (!p) throw new Blocked("Paper position missing");
        this.store.atomic(() => {
          deadline.assertActive();
          e!.evidence = {
            solDelta: sol.toString(),
            tokenDelta: token.toString(),
            feeLamports: s.paperFeeLamports,
            slot: 0,
          };
          e!.accounting = makeFillAccounting(
            e!,
            sol,
            token,
            BigInt(s.paperFeeLamports),
            0n,
            market.decimals,
            e!.fx ?? null,
            Date.now(),
            "RECONCILIATION_TIME",
          );
          this.applyFill(e!, sol, token, s);
          e!.state = "CONFIRMED";
          e!.at = Date.now();
          this.store.execution(e!);
          this.memory.confirmed(e!);
        });
        progress?.("BUY", "PASS");
        return e;
      }

      const before = {
        sol: await deadline.wait(() => this.provider.getWalletBalance()),
        tokens: await deadline.wait(() =>
          this.rpc.tokenBalance(env.WALLET_PUBLIC_KEY, i.mint),
        ),
      };
      if (i.side === "BUY") {
        if (
          size(
            before.sol,
            BigInt(s.feeReserveLamports),
            this.store.reserved("live") - BigInt(i.amount),
            s,
          ).amount !== BigInt(i.amount)
        )
          throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
            mint: i.mint,
            reason: "EXACT_SIZE_CHANGED",
          });
        if (before.tokens > 0n)
          throw new CandidateRejected("TOKEN_ALREADY_OWNED", { mint: i.mint });
      } else if (before.tokens < BigInt(i.amount))
        throw new Blocked("Wallet token balance changed before SELL");
      this.validate(i);
      authorityCheck?.();
      progress?.("BUY_QUOTE", "CHECKING");
      const q =
        i.side === "BUY"
          ? await deadline.wait(() =>
              this.provider.quoteBuy(
                i.mint,
                BigInt(i.amount),
                s.slippagePercent * 100,
              ),
            )
          : await deadline.wait(() =>
              this.provider.quoteSell(
                i.mint,
                BigInt(i.amount),
                s.slippagePercent * 100,
              ),
            );
      const height = Number(q.order.lastValidBlockHeight);
      const validity: NonNullable<Execution["transactionValidity"]> = {
        lastValidBlockHeight:
          Number.isSafeInteger(height) && height > 0 ? height : undefined,
      };
      try {
        validity.blockhash = VersionedTransaction.deserialize(
          Buffer.from(q.order.transaction, "base64"),
        ).message.recentBlockhash;
      } catch {
        /* Provider simulation remains authoritative for layout. */
      }
      e.transactionValidity = validity;
      this.store.execution(e);
      this.validate(i);
      authorityCheck?.();
      progress?.("BUY_QUOTE", "PASS");
      progress?.("VALIDATE", "CHECKING");
      validateQuote(q, {
        mint: i.mint,
        side: i.side,
        amount: BigInt(i.amount),
        wallet: env.WALLET_PUBLIC_KEY,
        slippageBps: s.slippagePercent * 100,
      });
      if (
        BigInt(
          q.order.signatureFeeLamports +
            q.order.prioritizationFeeLamports +
            q.order.rentFeeLamports,
        ) > BigInt(s.feeReserveLamports)
      )
        throw new CandidateRejected("TOKEN_SAFETY_FAILED", {
          mint: i.mint,
          reason: "EXECUTION_FEES_EXCEED_RESERVE",
        });
      if (i.side === "BUY") {
        progress?.("EXIT_FEASIBILITY", "CHECKING");
        e.exitFeasibility = await deadline.wait(() =>
          probeExits(
            this.provider,
            i.mint,
            BigInt(q.order.outAmount),
            env.WALLET_PUBLIC_KEY,
            s,
            "PRE_BUY",
            q,
            () => {
              deadline.assertActive();
              return false;
            },
          ),
        );
        this.store.record("exit_feasibility", i.mint, e.exitFeasibility);
        this.store.db
          .prepare(
            "DELETE FROM records WHERE kind='exit_feasibility' AND id NOT IN (SELECT id FROM records WHERE kind='exit_feasibility' ORDER BY id DESC LIMIT 500)",
          )
          .run();
        this.store.metric("prebuyExitChecked");
        this.store.metric("prebuyExit" + e.exitFeasibility.status);
        for (const level of e.exitFeasibility.levels)
          if (BigInt(level.amount) > 0n) this.store.metric("prebuyExitProbes");
        assertEntryExit(e.exitFeasibility, q, s);
        progress?.("EXIT_FEASIBILITY", "PASS");
        this.store.execution(e);
      }
      this.validate(i);
      authorityCheck?.();
      progress?.("VALIDATE", "PASS");
      progress?.("SIMULATE", "CHECKING");
      await deadline.wait(() => this.provider.simulate(q));
      progress?.("SIMULATE", "PASS");
      progress?.("PRE_SIGN", "CHECKING");
      if (finalValidation) await deadline.wait(finalValidation);
      const fresh = {
        sol: await deadline.wait(() => this.provider.getWalletBalance()),
        tokens: await deadline.wait(() =>
          this.rpc.tokenBalance(env.WALLET_PUBLIC_KEY, i.mint),
        ),
      };
      if (fresh.sol !== before.sol || fresh.tokens !== before.tokens)
        throw new Blocked("Wallet changed during execution preflight");
      this.validate(i);
      e.before = {
        sol: before.sol.toString(),
        tokens: before.tokens.toString(),
      };
      const mint = await deadline.wait(() =>
        this.rpc.connection.getParsedAccountInfo(
          new PublicKey(i.mint),
          "confirmed",
        ),
      );
      const data = mint.value?.data;
      const decimals =
        i.side === "BUY"
          ? this.store.latest<Snapshot>("snapshots", i.mint)?.market.decimals
          : this.store.positions("live").find((p) => p.id === i.positionId)
              ?.decimals;
      if (
        !data ||
        !("parsed" in data) ||
        data.parsed.type !== "mint" ||
        decimals === undefined ||
        data.parsed.info.decimals !== decimals
      )
        throw new CandidateRejected("TOKEN_DECIMALS_MISMATCH", {
          mint: i.mint,
        });
      if (i.side === "SELL") this.memory.preflight(e, q);
      if (i.side === "BUY") assertEntryExit(e.exitFeasibility!, q, s);
      this.validate(i);
      await deadline.wait(() =>
        this.provider.execute(
          q,
          (signature) => {
            deadline.beginSigning();
            e!.signature = signature;
            e!.submittedAt = Date.now();
            e!.state = "SUBMITTED";
            e!.at = Date.now();
            this.store.atomic(() => {
              if (i.side === "BUY") {
                this.memory.entry(
                  e!,
                  this.store.latest<Snapshot>("snapshots", i.mint)!,
                  s,
                );
                this.memory.preflight(e!, q);
              }
              this.store.execution(e!);
              this.controlled?.submitted(e!);
            });
            submitted = true;
          },
          () => {
            deadline.assertActive();
            this.validate(i);
            authorityCheck?.();
            e!.protectiveAuthority = this.store
              .positions(i.mode)
              .find((p) => p.id === i.positionId)
              ?.pendingExits?.find(
                (o) => o.id === i.exitOpportunityId,
              )?.protection;
            progress?.("PRE_SIGN", "PASS");
            progress?.("BUY", "CHECKING");
            deadline.beginSigning();
          },
        ),
      );
      e.state = "PENDING_CONFIRMATION";
      this.store.execution(e);
      await this.provider.confirm(e.signature!);
      await this.reconcile(e, s);
      if (String(e.state) === "CONFIRMED") progress?.("BUY", "PASS");
      return e;
    } catch (error) {
      if (e && e.state !== "CONFIRMED") {
        e.error = safeError(error);
        if (error instanceof CandidateRejected) e.errorDetails = error.details;
        e.state = submitted ? "UNKNOWN" : "FAILED";
        this.store.atomic(() => {
          this.store.execution(e!);
          if (e!.errorDetails)
            this.store.record("execution_errors", i.mint, {
              executionId: e!.id,
              positionId: i.positionId,
              side: i.side,
              code: e!.error,
              signed: !!e!.signature,
              details: e!.errorDetails,
            });
          if (!submitted) this.release(e!);
          this.memory.failure(e!);
          this.controlled?.failed(e!);
        });
        if (!submitted && e.error === "EXECUTION_UNSIGNED_TIMEOUT") {
          if (i.side === "BUY" && i.attemptId)
            this.store.finishBuyOwnership(i.mint, i.mode, i.attemptId);
          this.store.event(
            "EXECUTION_UNSIGNED_TIMEOUT",
            i.mint,
            "Unsigned pending expired after 60s; reservation released; late signing blocked: " +
              e.id,
          );
        }
        if (submitted)
          this.store.halt(
            "Unresolved Solana transaction; no automatic retry: " + e.error,
            "TRANSACTION",
          );
      }
      throw error;
    } finally {
      deadline.finish();
      this.busy = false;
    }
  }
  private release(e: Execution) {
    const p = this.store
      .positions(e.intent.mode)
      .find((p) => p.id === e.intent.positionId);
    if (p) {
      p.state = e.intent.side === "BUY" ? "FAILED" : "OPEN";
      p.exitStatus = e.error;
      this.store.savePosition(p);
    }
  }
  private applyFill(e: Execution, sol: bigint, tokens: bigint, s: Settings) {
    const i = e.intent,
      p = this.store.positions(i.mode).find((p) => p.id === i.positionId);
    if (!p) throw new Blocked("Position missing during receipt reconciliation");
    if (i.side === "BUY") {
      if (
        tokens <= 0n ||
        sol >= 0n ||
        -sol > BigInt(i.amount) + BigInt(s.feeReserveLamports)
      )
        throw new Blocked("BUY receipt balance mismatch");
      const snap = this.store.latest<Snapshot>("snapshots", i.mint);
      p.state = "OPEN";
      p.strategy = i.strategy ?? "STANDARD";
      p.attemptId = i.attemptId;
      p.ownershipClaimId = i.ownershipClaimId;
      p.decisionSource = i.decisionSource;
      p.decisionId = i.decisionId;
      p.decisionAt = i.decisionAt;
      if (snap && hash(snap) === i.snapshotHash) {
        p.entryDiscoverySource = snap.entryDiscoverySource;
        p.discoverySourcesAtEntry = structuredClone(
          snap.candidate.discovery?.sources,
        );
        p.sniperStructureAtEntry = structuredClone(snap.sniperStructureAtEntry);
      }
      p.quantity = tokens.toString();
      p.originalQuantity = p.quantity;
      p.costLamports = (-sol).toString();
      p.remainingCostLamports = p.costLamports;
      p.highWaterLamports = p.costLamports;
      p.symbol = snap?.candidate.symbol;
      p.source = snap?.candidate.source;
      p.signalPriceUsd = snap?.market.priceUsd;
      p.entryPriceUsd = e.accounting?.priceUsd ?? undefined;
      p.grossMfePercent = 0;
      p.grossMaePercent = 0;
      p.grossHighWaterLamports = e.accounting?.tradingLamports ?? undefined;
      p.entryMarketCap =
        snap?.market.marketCap.state === "KNOWN"
          ? snap.market.marketCap.value
          : undefined;
      p.initialLiquidity =
        snap?.market.liquidity.state === "KNOWN"
          ? snap.market.liquidity.value
          : undefined;
      p.decimals = snap?.market.decimals;
      p.signature = e.signature;
      p.tokenExecution = snap?.tokenExecution;
      p.nativeActive = false;
      p.entryAt = Date.now();
    } else {
      const sold = -tokens,
        before = BigInt(p.quantity);
      if (sold !== BigInt(i.amount) || sold <= 0n || sold > before)
        throw new Blocked("SELL receipt quantity mismatch");
      const allocated = (BigInt(p.remainingCostLamports) * sold) / before;
      p.decisionRevision = (p.decisionRevision ?? 0) + 1;
      p.quantity = (before - sold).toString();
      for (const o of p.pendingExits ?? [])
        if (o.protection) o.protection.quantity = p.quantity;
      if (p.grossHighWaterLamports !== undefined)
        p.grossHighWaterLamports = (
          (BigInt(p.grossHighWaterLamports) * (before - sold)) /
          before
        ).toString();
      p.remainingCostLamports = (
        BigInt(p.remainingCostLamports) - allocated
      ).toString();
      p.realizedLamports = (
        BigInt(p.realizedLamports) +
        sol -
        allocated
      ).toString();
      p.highWaterLamports = (
        (BigInt(p.highWaterLamports) * (before - sold)) /
        before
      ).toString();
      if (p.lastValueLamports !== undefined)
        p.lastValueLamports = (
          (BigInt(p.lastValueLamports) * (before - sold)) /
          before
        ).toString();
      p.valuationQuantity = p.quantity;
      p.valuationStatus = "ESTIMATED_AFTER_FILL";
      delete p.lastQuoteAt;
      p.state = sold === before ? "CLOSED" : "OPEN";
      if (p.state === "CLOSED") p.closedAt = e.accounting?.at ?? Date.now();
      if (p.state === "CLOSED")
        for (const request of this.store
          .activeManual(p.mode)
          .filter(
            (r) =>
              r.positionId === p.id &&
              r.id !== i.manualRequestId &&
              ["REQUESTED", "FAILED_RETRYABLE"].includes(r.state),
          )) {
          request.state = "CANCELLED";
          request.error = "POSITION_CLOSED_BY_CONFIRMED_EXECUTION";
          this.store.saveManual(request);
        }
      delete p.attention;
      if (i.takeProfitIndex !== undefined)
        p.takenProfits.push(i.takeProfitIndex);
      p.pendingExits =
        p.state === "CLOSED"
          ? []
          : p.pendingExits?.filter(
              (x) =>
                x.id !== i.exitOpportunityId &&
                (i.takeProfitIndex === undefined ||
                  x.takeProfitIndex !== i.takeProfitIndex),
            );
      p.exitStatus = "Confirmed";
      p.sellSignature = e.signature;
    }
    if (i.side === "SELL" && !p.accountingVersion && !p.signalPriceUsd)
      p.signalPriceUsd = p.entryPriceUsd;
    p.accountingVersion = 1;
    p.accounting = tradeAccounting(p, [
      ...this.store.executions().filter((x) => x.id !== e.id),
      { ...e, state: "CONFIRMED" },
    ]);
    if (p.accounting.grossPnlPct !== null) {
      p.grossMfePercent = Math.max(
        0,
        p.grossMfePercent ?? 0,
        p.accounting.grossPnlPct,
      );
      p.grossMaePercent = Math.min(
        0,
        p.grossMaePercent ?? 0,
        p.accounting.grossPnlPct,
      );
    }
    this.store.savePosition(p);
    this.store.pipelineEvent("POSITION_VALUATION_UPDATED", p.mint, {
      positionId: p.id,
      grossPnl: p.accounting.grossPnlLamports,
      grossPnlPct: p.accounting.grossPnlPct,
      feesPaid: p.accounting.feesPaidLamports,
      netPnl: p.accounting.netPnlLamports,
    });
    if (i.mode === "paper")
      this.store.set(
        "paperCash",
        (BigInt(this.store.get<string>("paperCash") ?? "0") + sol).toString(),
      );
    this.store.record("position_events", i.mint, {
      positionId: p.id,
      state: p.state,
      solDelta: sol.toString(),
      tokenDelta: tokens.toString(),
      signature: e.signature,
      simulated: i.mode === "paper",
    });
    this.store.event(i.side, i.mint, i.reason);
  }

  async reconcile(e: Execution, s: Settings) {
    const active = this.reconciliations.get(e.id);
    if (active) {
      await active;
      return;
    }
    const work = this.reconcileOne(e, s).catch((error) => {
      if (
        this.store.executions().find((x) => x.id === e.id)?.state !==
        "CONFIRMED"
      )
        throw error;
    });
    this.reconciliations.set(e.id, work);
    try {
      await work;
    } finally {
      if (this.reconciliations.get(e.id) === work)
        this.reconciliations.delete(e.id);
    }
  }
  private async investigateUnknown(e: Execution, error?: unknown) {
    if (!e.investigation || Date.now() - e.investigation.checkedAt >= 30000) {
      const prior = e.investigation;
      let info: Awaited<ReturnType<Solana["investigate"]>> | undefined;
      try {
        info = await this.rpc.investigate(e.signature!, e.transactionValidity);
      } catch {
        /* Unknown remains locked. */
      }
      e.investigation = {
        checkedAt: Date.now(),
        checks: (prior?.checks ?? 0) + 1,
        receiptAvailable: false,
        ...info,
        error: error ? safeError(error) : undefined,
        result:
          info?.blockhashValid === true ? "STILL_POSSIBLY_LIVE" : "UNRESOLVED",
      };
      this.store.execution(e);
      this.store.pipelineEvent(
        "EXECUTION_BLOCKED_BY_UNKNOWN_TX",
        e.intent.mint,
        {
          positionId: e.intent.positionId,
          signature: e.signature,
          submittedAt: e.submittedAt,
          ageMs: Date.now() - (e.submittedAt ?? e.at),
          mode: e.intent.mode,
          wallet: env.WALLET_PUBLIC_KEY,
          investigation: e.investigation,
          validity: e.transactionValidity,
        },
      );
    }
  }
  private async reconcileOne(e: Execution, s: Settings) {
    if (
      this.store.executions().find((x) => x.id === e.id)?.state === "CONFIRMED"
    )
      return;
    if (e.intent.provider !== "JUPITER" || !e.signature || !e.before) {
      this.store.halt(
        "Legacy or unsigned pending trade requires manual review",
        "TRANSACTION",
      );
      return;
    }
    let receipt: Awaited<ReturnType<Solana["receipt"]>>;
    try {
      receipt = await this.rpc.receipt(e.signature);
    } catch (error) {
      e.state = "UNKNOWN";
      e.error = safeError(error);
      this.store.execution(e);
      await this.investigateUnknown(e, error);
      this.store.halt(
        "Receipt lookup unavailable; execution remains locked",
        "TRANSACTION",
      );
      return;
    }
    if (
      this.store.executions().find((x) => x.id === e.id)?.state === "CONFIRMED"
    )
      return;
    if (!receipt?.meta) {
      e.state = "UNKNOWN";
      this.store.execution(e);
      this.memory.failure(e);
      this.controlled?.failed(e);
      this.store.halt(
        "On-chain receipt unresolved; BUY replay prohibited",
        "TRANSACTION",
      );
      await this.investigateUnknown(e);
      return;
    }
    if (receipt.transaction.signatures[0] !== e.signature) {
      this.store.halt("RECEIPT_SIGNATURE_MISMATCH", "TRANSACTION");
      return;
    }
    if (e.investigation)
      e.investigation = {
        ...e.investigation,
        checkedAt: Date.now(),
        checks: e.investigation.checks + 1,
        receiptAvailable: true,
        result: receipt.meta.err ? "FAILED" : "CONFIRMED",
        signatureStatus: receipt.meta.err ? "FAILED" : "CONFIRMED",
      };
    if (receipt.meta.err) {
      e.state = "FAILED";
      e.error = "Solana transaction failed on chain";
      e.failedFeeLamports = String(receipt.meta.fee);
      this.store.atomic(() => {
        this.store.execution(e);
        this.release(e);
        this.memory.failure(e);
        this.controlled?.failed(e);
      });
      return;
    }
    try {
      if (receipt.transaction.signatures[0] !== e.signature)
        throw new Blocked("RECEIPT_SIGNATURE_MISMATCH");
      const delta = this.rpc.deltas(
        receipt,
        env.WALLET_PUBLIC_KEY,
        e.intent.mint,
      );
      if (
        delta.beforeSol === undefined ||
        delta.afterSol === undefined ||
        delta.beforeTokens === undefined ||
        delta.afterTokens === undefined ||
        delta.beforeSol !== BigInt(e.before.sol) ||
        delta.beforeTokens !== BigInt(e.before.tokens) ||
        delta.afterSol - delta.beforeSol !== delta.sol ||
        delta.afterTokens - delta.beforeTokens !== delta.tokens
      )
        throw new Blocked("TRANSACTION_LOCAL_BALANCE_EVIDENCE_MISMATCH");
      const sol = await this.rpc.balance(env.WALLET_PUBLIC_KEY),
        tokens = await this.rpc.tokenBalance(
          env.WALLET_PUBLIC_KEY,
          e.intent.mint,
        );
      const later = this.store
        .executions()
        .filter(
          (x) =>
            x.id !== e.id &&
            x.intent.mode === e.intent.mode &&
            x.state === "CONFIRMED" &&
            x.signature &&
            x.evidence &&
            (x.evidence.slot > receipt.slot ||
              (x.evidence.slot === receipt.slot &&
                (x.submittedAt ?? x.intent.createdAt) >
                  (e.submittedAt ?? e.intent.createdAt))),
        );
      const subsequentSol = later.reduce(
        (sum, x) => sum + BigInt(x.evidence!.solDelta),
        0n,
      );
      const subsequentTokens = later
        .filter((x) => x.intent.mint === e.intent.mint)
        .reduce((sum, x) => sum + BigInt(x.evidence!.tokenDelta), 0n);
      if (
        sol !== delta.afterSol + subsequentSol ||
        tokens !== delta.afterTokens + subsequentTokens
      )
        throw new Blocked(
          "Wallet balances differ from receipt; manual reconciliation required",
        );
      this.store.atomic(() => {
        if (
          this.store.executions().find((x) => x.id === e.id)?.state ===
          "CONFIRMED"
        )
          return;
        const existing = this.store.db
          .prepare("SELECT execution_id FROM execution_fills WHERE signature=?")
          .get(e.signature!);
        if (
          existing ||
          this.store
            .executions()
            .some(
              (x) =>
                x.id !== e.id &&
                x.signature === e.signature &&
                x.state === "CONFIRMED",
            )
        )
          throw new Blocked("SIGNATURE_FILL_ALREADY_APPLIED");
        this.store.db
          .prepare("INSERT INTO execution_fills VALUES(?,?,?,?)")
          .run(
            e.signature!,
            e.id,
            receipt.slot,
            JSON.stringify({
              strategy: e.intent.strategy ?? "STANDARD",
              attemptId: e.intent.attemptId,
              ownershipClaimId: e.intent.ownershipClaimId,
              decisionSource: e.intent.decisionSource,
              decisionId: e.intent.decisionId,
              decisionAt: e.intent.decisionAt,
              beforeSol: String(delta.beforeSol),
              afterSol: String(delta.afterSol),
              beforeTokens: String(delta.beforeTokens),
              afterTokens: String(delta.afterTokens),
            }),
          );
        e.evidence = {
          solDelta: delta.sol.toString(),
          tokenDelta: delta.tokens.toString(),
          feeLamports: String(receipt.meta!.fee),
          slot: receipt.slot,
          transactionBalances: {
            beforeSol: String(delta.beforeSol),
            afterSol: String(delta.afterSol),
            beforeTokens: String(delta.beforeTokens),
            afterTokens: String(delta.afterTokens),
          },
        };
        const decimals =
          this.store
            .positions(e.intent.mode)
            .find((p) => p.id === e.intent.positionId)?.decimals ??
          this.store.latest<Snapshot>("snapshots", e.intent.mint)?.market
            .decimals;
        e.accounting = makeFillAccounting(
          e,
          delta.sol,
          delta.tokens,
          BigInt(receipt.meta!.fee),
          receiptRentDelta(receipt, env.WALLET_PUBLIC_KEY),
          decimals,
          e.fx ?? null,
          receipt.blockTime ? receipt.blockTime * 1000 : Date.now(),
          receipt.blockTime ? "BLOCK_TIME" : "RECONCILIATION_TIME",
        );
        this.applyFill(e, delta.sol, delta.tokens, s);
        e.state = "CONFIRMED";
        e.at = Date.now();
        this.store.execution(e);
        this.memory.confirmed(e);
        this.controlled?.confirmed(e);
      });
    } catch (error) {
      if (
        this.store.executions().find((x) => x.id === e.id)?.state ===
        "CONFIRMED"
      )
        return;
      e.state = "UNKNOWN";
      e.error = safeError(error);
      this.store.execution(e);
      this.store.halt(e.error, "TRANSACTION");
    }
  }
  async recover(s: Settings) {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const e of this.store
        .pending()
        .filter((e) => e.intent.mode === env.TRADING_MODE)) {
        if (e.intent.provider !== "JUPITER") {
          this.store.halt(
            "Legacy GMGN pending trade requires manual review; never replayed",
            "TRANSACTION",
          );
          continue;
        }
        if (e.state === "CREATED" && !e.signature) {
          e.state = "FAILED";
          e.error = "Unsubmitted intent discarded on restart; never replayed";
          this.store.atomic(() => {
            this.store.execution(e);
            this.release(e);
          });
          if (e.intent.side === "BUY" && e.intent.attemptId)
            this.store.finishBuyOwnership(
              e.intent.mint,
              e.intent.mode,
              e.intent.attemptId,
            );
        } else
          try {
            await this.reconcile(e, s);
          } catch {
            this.store.halt(
              "Pending transaction recovery unavailable",
              "TRANSACTION",
            );
          }
      }
    } finally {
      this.busy = false;
    }
  }
  sellIntent(
    p: Position,
    amount: bigint,
    reason: string,
    s: Settings,
    takeProfitIndex?: number,
  ): Intent {
    return deepFreeze({
      id: randomUUID(),
      strategy: p.strategy ?? "STANDARD",
      attemptId: p.attemptId,
      ownershipClaimId: p.ownershipClaimId,
      provider: "JUPITER",
      key: `${p.mode}:SELL:${p.id}:${p.quantity}:${this.store.executions().filter((e) => e.intent.positionId === p.id && e.intent.side === "SELL" && e.state === "FAILED").length}`,
      mint: p.mint,
      mode: p.mode,
      side: "SELL",
      amount: amount.toString(),
      createdAt: Date.now(),
      expiresAt: Date.now() + s.maxSnapshotAgeMs,
      snapshotHash: "Local exit policy",
      positionId: p.id,
      reason,
      takeProfitIndex,
    });
  }
}
