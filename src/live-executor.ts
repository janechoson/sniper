import { randomUUID } from "node:crypto";
import type { KronosStore } from "./kronos-store.js";
import type { LabDecision, LabTrial } from "./kronos-domain.js";
import { KRONOS } from "./kronos-domain.js";
import { type LiveConfig, sizeBuy, LIVE_SIZING_POLICY } from "./live-config.js";
import { LiveStore } from "./live-store.js";
import type { LiveExecution, LivePosition } from "./live-types.js";
import {
  type SolanaExecutionProvider,
  validateQuote,
} from "./execution-provider.js";
import { Solana } from "./solana.js";
import { requireCompatibleToken } from "./token-program.js";
import {
  makeFillAccounting,
  receiptRentDelta,
  type FxEvidence,
} from "./fill-accounting.js";
import { Blocked } from "./domain.js";
import { safeError } from "./util.js";

/** Strategy-free wallet mutation lane, adapted from BOT B Executor's claim/sign/receipt boundaries. */
export class LiveExecutor {
  readonly ledger: LiveStore;
  private busy = false;
  private reconcileActive?: Promise<void>;
  private nextRecoveryAt = 0;
  constructor(
    readonly store: KronosStore,
    readonly provider: SolanaExecutionProvider,
    readonly rpc: Solana,
    readonly config: LiveConfig,
    private readonly authority: () => void,
    private readonly finalEntry: (t: LabTrial) => Promise<void>,
    private readonly fx: () => Promise<FxEvidence | null> = async () => null,
  ) {
    this.ledger = new LiveStore(store);
  }
  status() {
    return {
      pending: this.ledger.pending().map((e) => ({
        id: e.id,
        side: e.intent.side,
        state: e.state,
        signature: e.signature ?? null,
        error: e.error ?? null,
      })),
      busy: this.busy,
    };
  }
  private check(t: LabTrial, d: LabDecision) {
    this.authority();
    if (Date.now() < d.at || Date.now() - d.at > KRONOS.priceMaxAgeMs)
      throw new Blocked("KRONOS_DECISION_EXPIRED");
    const latest = this.store.trial(t.id);
    if (
      latest?.mode !== "LIVE" ||
      latest.latest?.at !== d.at ||
      latest.latest.action !== d.action
    )
      throw new Blocked("KRONOS_AUTHORITY_CHANGED");
    if (d.action === "PAPER_BUY")
      for (const name of [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ]) {
        const gate = latest.gates[name];
        if (
          !gate ||
          gate.status !== "PASS" ||
          !Number.isFinite(gate.at) ||
          gate.at > Date.now() ||
          Date.now() - gate.at > 45000
        )
          throw new Blocked("PRE_BUY_ELIGIBILITY_EXPIRED");
      }
    if (!this.config.acknowledged) throw new Blocked("LIVE_ACK_REQUIRED");
  }
  private event(kind: string, e: LiveExecution, payload: unknown = {}) {
    const t = this.store.trial(e.trialId);
    if (t) {
      t.execution = {
        id: e.id,
        state: e.state,
        side: e.intent.side,
        signature: e.signature,
        error: e.error,
      };
      this.store.save(t);
    }
    this.store.event(kind, t, payload);
  }
  async execute(
    t: LabTrial,
    d: LabDecision,
    dryRun = false,
  ): Promise<LiveExecution> {
    if (!["PAPER_BUY", "PAPER_SELL"].includes(d.action))
      throw new Blocked("NO_TRADE_SIGNAL");
    if (this.busy || this.ledger.pending().length)
      throw new Blocked("PENDING_TRANSACTION");
    this.busy = true;
    let e: LiveExecution | undefined;
    try {
      this.check(t, d);
      const side = d.action === "PAPER_BUY" ? "BUY" : "SELL",
        wallet = this.config.WALLET_PUBLIC_KEY;
      const before = {
        sol: await this.rpc.balance(wallet),
        tokens: await this.rpc.tokenBalance(wallet, t.mint),
      };
      const report = await this.rpc.inspectMint(t.mint);
      requireCompatibleToken(report);
      const position = this.ledger.position(t.id);
      if (
        side === "BUY" &&
        (before.tokens !== 0n || this.ledger.owned(wallet, t.mint))
      )
        throw new Blocked("OWNERSHIP_CONFLICT");
      if (
        side === "SELL" &&
        (!position ||
          position.state !== "OPEN" ||
          position.wallet !== wallet ||
          before.tokens !== BigInt(position.quantity) ||
          before.tokens === 0n)
      )
        throw new Blocked("OWNERSHIP_CONFLICT");
      // Reserve for each already OPEN position in addition to the new position/BUY/ATA reserve.
      const reserve =
        BigInt(this.config.reserveLamports) +
        BigInt(this.ledger.openCount()) *
          BigInt(LIVE_SIZING_POLICY.reservePerOpenLamports);
      const amount =
        side === "BUY" ? sizeBuy(before.sol, reserve) : before.tokens;
      if (amount <= 0n) throw new Blocked("INSUFFICIENT_FEE_RESERVE");
      e = {
        id: randomUUID(),
        trialId: t.id,
        wallet,
        mint: t.mint,
        intent: {
          mode: "live",
          side,
          amount: amount.toString(),
          decisionAt: d.at,
        },
        state: "CREATED",
        at: Date.now(),
        before: {
          sol: before.sol.toString(),
          tokens: before.tokens.toString(),
        },
      };
      this.ledger.atomic(() => {
        if (this.ledger.pending().length)
          throw new Blocked("PENDING_TRANSACTION");
        this.ledger.claim(e!);
      });
      this.event(side + "_SIGNAL", e, { decisionAt: d.at });
      if (side === "BUY")
        this.event("SIZE_1_PERCENT_SPENDABLE", e, {
          balance: before.sol.toString(),
          reserve: reserve.toString(),
          principal: amount.toString(),
        });
      const q =
        side === "BUY"
          ? await this.provider.quoteBuy(
              t.mint,
              amount,
              this.config.slippageBps,
            )
          : await this.provider.quoteSell(
              t.mint,
              amount,
              this.config.slippageBps,
            );
      e.quote = q;
      this.validate(q, e);
      this.ledger.save(e);
      const fees =
        BigInt(q.order.signatureFeeLamports) +
        BigInt(q.order.prioritizationFeeLamports) +
        BigInt(q.order.rentFeeLamports);
      if (
        fees > 5000000n ||
        before.sol < (side === "BUY" ? amount + reserve : fees + 5000000n)
      )
        throw new Blocked("INSUFFICIENT_FEE_RESERVE");
      this.event(side + "_JUPITER_QUOTE_PASS", e, {
        input: q.amount,
        output: q.order.outAmount,
      });
      if (side === "BUY") await this.exitProbes(e);
      await this.provider.simulate(q);
      this.event("SIMULATION_PASS", e);
      if (side === "BUY") await this.finalEntry(t);
      const mint = await this.rpc.inspectMint(t.mint);
      requireCompatibleToken(mint);
      if (mint.decimals !== report.decimals || mint.decimals === null)
        throw new Blocked("TOKEN_DECIMALS_MISMATCH");
      if (
        (await this.rpc.balance(wallet)) !== before.sol ||
        (await this.rpc.tokenBalance(wallet, t.mint)) !== before.tokens
      )
        throw new Blocked("WALLET_CHANGED_DURING_PREFLIGHT");
      this.check(t, d);
      this.validate(q, e);
      if (dryRun) {
        e.state = "DRY_RUN";
        this.ledger.save(e);
        this.event("DRY_RUN_STOP_BEFORE_SIGN", e, {
          principal: e.intent.amount,
        });
        return e;
      }
      await this.provider.execute(
        q,
        (signature) => {
          // FULL synchronous durable commit before first possible HTTP submission. No signed bytes persisted.
          e!.signature = signature;
          e!.state = "SUBMITTED";
          e!.at = Date.now();
          this.ledger.atomic(() => {
            this.ledger.save(e!);
            this.event(side + "_SUBMITTED", e!, { signature });
          });
        },
        () => {
          this.check(t, d);
          this.validate(q, e!);
        },
      );
      await this.provider.confirm(e.signature!);
      await this.reconcileOne(e);
      return this.ledger.execution(e.id)!;
    } catch (error) {
      if (e) {
        const saved = this.ledger.execution(e.id);
        if (saved?.state !== "RECONCILED") {
          e.state = e.signature ? "UNKNOWN" : "FAILED";
          e.error = safeError(error);
          this.ledger.save(e);
          this.event(e.intent.side + "_" + e.state, e, {
            reason: e.error,
            signature: e.signature ?? null,
          });
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private validate(q: NonNullable<LiveExecution["quote"]>, e: LiveExecution) {
    validateQuote(q, {
      mint: e.mint,
      side: e.intent.side,
      amount: BigInt(e.intent.amount),
      wallet: e.wallet,
      slippageBps: this.config.slippageBps,
    });
    if (
      q.order.priceImpactPct === undefined ||
      q.order.priceImpactPct > this.config.maxImpactPct
    )
      throw new Blocked("PRICE_IMPACT");
  }
  private async exitProbes(e: LiveExecution) {
    const q = e.quote!,
      levels = [];
    let accepted = false;
    for (const bps of [2000, 5000, 10000]) {
      const amount = (BigInt(q.order.outAmount) * BigInt(bps)) / 10000n;
      try {
        if (!amount) throw new Blocked("MIN_ROUTE");
        const sell = await this.provider.quoteSell(
          e.mint,
          amount,
          this.config.slippageBps,
          true,
        );
        validateQuote(sell, {
          mint: e.mint,
          side: "SELL",
          amount,
          wallet: e.wallet,
          slippageBps: this.config.slippageBps,
          routeOnly: true,
        });
        const net = BigInt(sell.order.otherAmountThreshold) - 110000n;
        const pass =
          sell.order.priceImpactPct !== undefined &&
          sell.order.priceImpactPct <= 15 &&
          net >= 10000n;
        if (pass && bps !== 10000) accepted = true;
        levels.push({
          bps,
          amount: amount.toString(),
          minimum: sell.order.otherAmountThreshold,
          pass,
        });
      } catch (error) {
        levels.push({
          bps,
          amount: amount.toString(),
          pass: false,
          reason: safeError(error),
        });
      }
    }
    this.event("EXIT_FEASIBILITY", e, { buyQuoteAt: q.at, levels, accepted });
    if (!accepted) throw new Blocked("TOKEN_NOT_SELLABLE");
    if (Date.now() - q.at > 15000) throw new Blocked("EXIT_FEASIBILITY_STALE");
  }
  async recover(force = true) {
    if (this.busy) return;
    if (this.reconcileActive) return this.reconcileActive;
    if (!force && Date.now() < this.nextRecoveryAt) return;
    this.nextRecoveryAt = Date.now() + 30000;
    this.reconcileActive = (async () => {
      for (const e of this.ledger.pending()) {
        if (e.wallet !== this.config.WALLET_PUBLIC_KEY)
          throw new Blocked("RECOVERY_WALLET_MISMATCH");
        if (!e.signature) {
          e.state = "FAILED";
          e.error = "UNSIGNED_RESTART_NO_REPLAY";
          this.ledger.save(e);
          continue;
        }
        await this.reconcileOne(e);
      }
    })();
    try {
      await this.reconcileActive;
    } finally {
      this.reconcileActive = undefined;
    }
  }
  private async reconcileOne(e: LiveExecution) {
    if (this.ledger.execution(e.id)?.state === "RECONCILED") return;
    try {
      const receipt = await this.rpc.receipt(e.signature!);
      if (!receipt?.meta) throw new Blocked("RECEIPT_UNAVAILABLE");
      if (receipt.transaction.signatures[0] !== e.signature)
        throw new Blocked("RECEIPT_SIGNATURE_MISMATCH");
      if (!Number.isSafeInteger(receipt.meta.fee) || receipt.meta.fee < 0)
        throw new Blocked("INVALID_RECEIPT_FEE");
      if (receipt.meta.err) {
        e.state = "FAILED";
        e.error = "ON_CHAIN_FAILED";
        e.failedFeeLamports = String(receipt.meta.fee);
        this.ledger.atomic(() => {
          this.ledger.save(e);
          const p = this.ledger.position(e.trialId);
          if (p) {
            p.feesLamports = this.ledger.fees(p.id)?.toString() ?? null;
            this.ledger.savePosition(p);
            this.project(p);
          }
          this.event(e.intent.side + "_FAILED", e, {
            fee: e.failedFeeLamports,
          });
        });
        return;
      }
      const d = this.rpc.deltas(receipt, e.wallet, e.mint);
      if (
        !e.before ||
        d.beforeSol !== BigInt(e.before.sol) ||
        d.beforeTokens !== BigInt(e.before.tokens)
      )
        throw new Blocked("LOCAL_RECEIPT_BALANCE_MISMATCH");
      if (
        (await this.rpc.balance(e.wallet)) !== d.afterSol ||
        (await this.rpc.tokenBalance(e.wallet, e.mint)) !== d.afterTokens
      )
        throw new Blocked("WALLET_RECEIPT_MISMATCH");
      const buy = e.intent.side === "BUY",
        q = e.quote!;
      if (
        buy
          ? d.tokens < BigInt(q.order.otherAmountThreshold) ||
            d.sol >= 0n ||
            -d.sol > BigInt(e.intent.amount) + 5000000n
          : d.tokens !== -BigInt(e.intent.amount) || d.sol <= 0n
      )
        throw new Blocked("RECEIPT_FILL_MISMATCH");
      const mint = await this.rpc.inspectMint(e.mint);
      const rent = receiptRentDelta(receipt, e.wallet),
        fee = BigInt(receipt.meta.fee);
      let fx: FxEvidence | null = null;
      try {
        // A later restart must not pretend today's FX was the historical fill's USD rate.
        fx =
          receipt.blockTime &&
          Math.abs(Date.now() - receipt.blockTime * 1000) <= 45000
            ? await this.fx()
            : null;
        if (fx && (fx.at > Date.now() || Date.now() - fx.at > 45000)) fx = null;
      } catch {
        /* FX is optional; SOL accounting remains authoritative. */
      }
      const accounting = makeFillAccounting(
        e,
        d.sol,
        d.tokens,
        fee,
        rent,
        mint.decimals ?? undefined,
        fx,
        receipt.blockTime ? receipt.blockTime * 1000 : Date.now(),
        receipt.blockTime ? "BLOCK_TIME" : "RECONCILIATION_TIME",
      );
      if (
        !buy &&
        accounting.tradingLamports !== null &&
        BigInt(accounting.tradingLamports) <
          BigInt(q.order.otherAmountThreshold)
      )
        throw new Blocked("RECEIPT_MINIMUM_OUTPUT_MISMATCH");
      e.state = "CONFIRMED";
      delete e.error;
      e.slot = receipt.slot;
      e.accounting = accounting;
      this.ledger.save(e);
      this.event(e.intent.side + "_CONFIRMED", e, { signature: e.signature });
      this.ledger.atomic(() => {
        if (this.ledger.execution(e.id)?.state === "RECONCILED") return;
        this.store.db
          .prepare("INSERT INTO live_fills VALUES(?,?,?)")
          .run(e.signature!, e.id, JSON.stringify(accounting));
        let p = this.ledger.position(e.trialId);
        if (buy) {
          if (p || mint.decimals === null)
            throw new Blocked("DUPLICATE_POSITION_FILL");
          p = {
            id: e.trialId,
            mode: "LIVE",
            mint: e.mint,
            wallet: e.wallet,
            state: "OPEN",
            quantity: d.tokens.toString(),
            decimals: mint.decimals,
            entry: accounting,
            buyDecisionAt: e.intent.decisionAt,
            requestedPrincipal: e.intent.amount,
            grossPnlLamports: null,
            feesLamports: null,
            netPnlLamports: null,
            feesPrincipalPct: null,
            marketPnlPct: null,
            mfePct: null,
            maePct: null,
          };
        } else {
          if (!p || p.state !== "OPEN" || BigInt(p.quantity) !== -d.tokens)
            throw new Blocked("SELL_QUANTITY_MISMATCH");
          p.quantity = "0";
          p.state = "CLOSED";
          p.exit = accounting;
          p.sellDecisionAt = e.intent.decisionAt;
        }
        e.state = "RECONCILED";
        this.ledger.save(e);
        p.feesLamports = this.ledger.fees(p.id)?.toString() ?? null;
        const cost = p.entry.tradingLamports,
          proceeds = p.exit?.tradingLamports;
        if (p.state === "CLOSED" && cost != null && proceeds != null) {
          p.grossPnlLamports = (BigInt(proceeds) - BigInt(cost)).toString();
          const clean =
            p.entry.unclassifiedDebitLamports === "0" &&
            p.entry.recoverableRentDeltaLamports !== null &&
            p.exit!.recoverableRentDeltaLamports !== null;
          if (clean && p.feesLamports !== null)
            p.netPnlLamports = (
              BigInt(p.grossPnlLamports) - BigInt(p.feesLamports)
            ).toString();
        }
        p.feesPrincipalPct =
          cost && p.feesLamports !== null
            ? Number((BigInt(p.feesLamports) * 1000000n) / BigInt(cost)) / 10000
            : null;
        this.ledger.savePosition(p);
        this.project(p);
        this.event(e.intent.side + "_RECONCILED", e, {
          signature: e.signature,
          accounting,
        });
        this.event(buy ? "POSITION_OPEN" : "POSITION_CLOSED", e, {
          netPnl: p.netPnlLamports,
        });
      });
    } catch (error) {
      e.state = "UNKNOWN";
      e.error = safeError(error);
      this.ledger.save(e);
      this.event("RECONCILIATION_REQUIRED", e, {
        reason: e.error,
        signature: e.signature,
      });
    }
  }
  project(p: LivePosition) {
    const t = this.store.trial(p.id);
    if (!t) throw new Blocked("LIVE_TRIAL_MISSING");
    t.live = p;
    t.mode = "LIVE";
    t.status = p.state;
    delete t.error;
    if (t.evaluation) {
      t.evaluation.stages.EXECUTION = "PASS";
      delete t.evaluation.error;
    }
    const fill = (a: LivePosition["entry"]) => ({
      value: Number(a.priceUsd ?? a.priceSol),
      observedAt: a.at,
      source: a.priceUsd
        ? ("RECONCILED_USD" as const)
        : ("RECONCILED_SOL" as const),
    });
    t.entry = fill(p.entry);
    t.buyDecisionAt = p.buyDecisionAt;
    if (p.exit) {
      t.exit = fill(p.exit);
      t.sellDecisionAt = p.sellDecisionAt;
    }
    this.store.save(t);
  }
  mark(t: LabTrial, price: number, at: number) {
    const p = this.ledger.position(t.id);
    if (!p || p.state !== "OPEN") return;
    p.markUsd = price;
    p.markAt = at;
    const entry = p.entry.priceUsd ? Number(p.entry.priceUsd) : null;
    if (entry) {
      p.marketPnlPct = (price / entry - 1) * 100;
      p.mfePct = Math.max(p.mfePct ?? 0, p.marketPnlPct);
      p.maePct = Math.min(p.maePct ?? 0, p.marketPnlPct);
    }
    this.ledger.savePosition(p);
    t.live = p;
  }
}
