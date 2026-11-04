import { env, type Settings } from "./config.js";
import type { Candidate, FailureInfo, RiskResult } from "./domain.js";
import type { Store } from "./store.js";
export interface CandidateState {
  appearanceId?: number;
  batchId?: string;
  structureReadyAt?: number;
  structureWatchExpiresAt?: number;
  baseScore?: number;
  waitSince?: number;
  priority?: number;
  analysisWaitMs?: number;
  agedPromotion?: boolean;
  mint: string;
  symbol?: string;
  state:
    | "QUEUED"
    | "ANALYZING"
    | "WATCH"
    | "STRUCTURE_WATCH"
    | "QUALIFIED"
    | "APPROVED"
    | "BOUGHT"
    | "DEFERRED"
    | "REJECTED"
    | "USER_REMOVED";
  score: number;
  failureCount: number;
  rechecks: number;
  firstDeferredAt?: number;
  lastChecked: number;
  nextCheckAt: number;
  expiresAt: number;
  issue?: FailureInfo;
  recoveryPending?: boolean;
}

/** Only unconsumed Trending appearances enter. No deferred timers or judgments. */
export class CandidateLifecycle {
  constructor(
    readonly store: Store,
    private settings: () => Settings,
  ) {
    store.db
      .prepare(
        `DELETE FROM candidate_lifecycle WHERE mode=? AND (
        COALESCE(json_extract(payload,'$.state'),'')!='QUEUED'
        OR COALESCE(json_extract(payload,'$.batchId'),'')!=?
        OR NOT EXISTS (SELECT 1 FROM trending_appearances a
          WHERE a.mode=candidate_lifecycle.mode AND a.consumed=0
            AND a.id=CAST(json_extract(candidate_lifecycle.payload,'$.appearanceId') AS INTEGER))
      )`,
      )
      .run(env.TRADING_MODE, store.trendingBatch()?.id ?? "__NO_BATCH__");
  }
  list(): CandidateState[] {
    return this.store.db
      .prepare(
        "SELECT payload FROM candidate_lifecycle WHERE mode=? ORDER BY CAST(json_extract(payload,'$.appearanceId') AS INTEGER) ASC,mint ASC",
      )
      .all(env.TRADING_MODE)
      .map((r) => JSON.parse(String(r.payload)));
  }
  get(mint: string) {
    return this.list().find((r) => r.mint === mint);
  }
  private save(row: CandidateState) {
    const previous = this.get(row.mint);
    this.store.db
      .prepare(
        "INSERT INTO candidate_lifecycle VALUES(?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET payload=excluded.payload",
      )
      .run(env.TRADING_MODE, row.mint, JSON.stringify(row));
    if (previous?.state !== row.state) {
      const names: Record<string, string> = {
        QUEUED: "CANDIDATE_QUEUED",
        ANALYZING: "CANDIDATE_CHECKING",
        QUALIFIED: "CANDIDATE_QUALIFIED",
        APPROVED: "RISK_APPROVED",
        REJECTED: "CANDIDATE_REJECTED",
        BOUGHT: "CANDIDATE_TRADED",
      };
      this.store.pipelineEvent(names[row.state] ?? row.state, row.mint, {
        from: previous?.state ?? "DISCOVERY",
        to: row.state,
        reason: row.issue?.reasonCode,
      });
    }
  }
  setState(mint: string, state: CandidateState["state"], now = Date.now()) {
    const row = this.get(mint);
    if (!row) return;
    row.state = ["WATCH", "STRUCTURE_WATCH", "DEFERRED"].includes(state)
      ? "REJECTED"
      : state;
    row.lastChecked = now;
    this.save(row);
    if (state === "ANALYZING" && row.appearanceId)
      this.store.db
        .prepare("UPDATE trending_appearances SET consumed=1 WHERE id=?")
        .run(row.appearanceId);
  }
  dismiss(mint: string) {
    this.setState(mint, "USER_REMOVED");
  }
  promoteStructure(mint: string, _now?: number, _reason?: string) {
    this.setState(mint, "REJECTED");
  }
  structureWait(mint: string, _expiresAt: number, _now?: number) {
    this.setState(mint, "REJECTED");
  }
  providerWait(mint: string, _now?: number) {
    this.setState(mint, "REJECTED");
  }
  recovered(_mint: string) {}
  fail(issue: FailureInfo, _now?: number) {
    const row = this.get(issue.mint ?? "");
    if (!row) return;
    row.issue = issue;
    row.state = "REJECTED";
    this.save(row);
    this.store.record("token_failures", row.mint, {
      ...issue,
      disposition: "REJECTED",
    });
  }
  decision(mint: string, r: RiskResult, _now?: number) {
    this.setState(mint, r.allowed ? "APPROVED" : "REJECTED");
  }
  finish(mint: string) {
    const row = this.get(mint);
    if (row?.appearanceId)
      this.store.finishUnboundTrendingAppearance(row.appearanceId);
    this.store.db
      .prepare("DELETE FROM candidate_lifecycle WHERE mode=? AND mint=?")
      .run(env.TRADING_MODE, mint);
    this.store.db
      .prepare("DELETE FROM candidate_flow_states WHERE mint=?")
      .run(mint);
  }
  refill(candidates: Candidate[], now = Date.now()) {
    this.store.enqueueTrending(candidates);
    const batch = this.store.prepareTrendingBatch();
    if (!batch) return [];
    const rows = this.store.db
      .prepare(
        "SELECT * FROM trending_appearances WHERE mode=? AND consumed=0 AND seen_at=? ORDER BY id",
      )
      .all(env.TRADING_MODE, batch.fetchedAt);
    for (const r of rows) {
      const c = JSON.parse(String(r.payload)) as Candidate;
      if (this.get(c.mint)) continue;
      if (this.list().length >= this.settings().candidateQueueSize) break;
      this.save({
        appearanceId: Number(r.id),
        batchId: batch.id,
        mint: c.mint,
        symbol: c.symbol,
        state: "QUEUED",
        score: 0,
        failureCount: 0,
        rechecks: 0,
        lastChecked: now,
        nextCheckAt: now,
        expiresAt: 0,
      });
    }
    this.store.db
      .prepare(
        "DELETE FROM trending_appearances WHERE consumed=1 AND id IN (SELECT id FROM trending_appearances WHERE consumed=1 ORDER BY id DESC LIMIT -1 OFFSET 2000)",
      )
      .run();
    return this.list()
      .filter((r) => r.state === "QUEUED" && r.batchId === batch.id)
      .map((r) => r.mint);
  }
}
