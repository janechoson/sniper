import { randomUUID } from "node:crypto";
import type { Candidate } from "./domain.js";
import type { LabTrial } from "./kronos-domain.js";
import type { LabMarket } from "./kronos-market.js";
import { KronosStore } from "./kronos-store.js";
import { tokenLogo } from "./token-metadata.js";

export const DISCOVERY_BATCH_TTL_MS = 5 * 60_000;
const FAILED_FETCH_RETRY_MS = 120_000;
const EMPTY_BATCH_RETRY_MS = 30_000;
type Job = {
  appearance: string;
  trialId?: string;
  state:
    | "PENDING"
    | "RUNNING"
    | "PROCESSED"
    | "DEDUPLICATED"
    | "INTERRUPTED"
    | "EXPIRED_UNPROCESSED";
};
type Batch = {
  batchId: string;
  fetchedAt: number;
  expiresAt: number;
  rawReceivedCount: number;
  uniqueCount: number;
  duplicateCount: number;
  status: "PROCESSING" | "EXHAUSTED" | "EXPIRED";
  jobs: Job[];
};
type State = {
  batch?: Batch;
  retryAt: number;
  listFetchCount: number;
  candidateEvaluationCount: number;
  fetchError?: string;
};

/** Owns rank snapshots only; never forecasts, signs or changes entry/exit policy. */
export class DiscoveryBatches {
  private readonly key: string;
  private state: State;
  private flight?: Promise<void>;
  private running = new Map<string, { batch: Batch; job: Job }>();
  constructor(
    private store: KronosStore,
    private market: LabMarket,
    private mode: "PAPER" | "LIVE",
    private now = Date.now,
  ) {
    this.key = "discoverySchedulerV1:" + mode;
    this.state = store.get(this.key) ?? {
      retryAt: 0,
      listFetchCount: 0,
      candidateEvaluationCount: 0,
    };
    // A previous process's interrupted work is not a new discovery appearance.
    // Existing checked trials remain eligible for the ordinary fresh recheck lane.
    for (const job of this.state.batch?.jobs ?? [])
      if (job.state === "RUNNING") job.state = "INTERRUPTED";
  }
  private save() {
    this.store.set(this.key, this.state);
  }
  private counts(b: Batch) {
    return {
      processedCount: b.jobs.filter((j) => j.state === "PROCESSED").length,
      pendingCount: b.jobs.filter((j) => j.state === "PENDING").length,
      runningCount: b.jobs.filter((j) => j.state === "RUNNING").length,
      skippedCount: b.jobs.filter((j) => j.state === "DEDUPLICATED").length,
      interruptedCount: b.jobs.filter((j) => j.state === "INTERRUPTED").length,
      expiredUnprocessedCount: b.jobs.filter(
        (j) => j.state === "EXPIRED_UNPROCESSED",
      ).length,
    };
  }
  private summary(b: Batch) {
    const { jobs: _jobs, ...fields } = b;
    return {
      ...fields,
      ...this.counts(b),
      ageMs: Math.max(0, this.now() - b.fetchedAt),
    };
  }
  private event(kind: string, b: Batch) {
    this.store.event(kind, undefined, this.summary(b));
  }
  private expire() {
    const b = this.state.batch;
    if (!b || b.status !== "PROCESSING" || this.now() < b.expiresAt) return;
    b.status = "EXPIRED";
    for (const job of b.jobs)
      if (job.state === "PENDING") {
        job.state = "EXPIRED_UNPROCESSED";
        if (job.trialId) this.store.expireUnstarted(job.trialId, this.now());
      }
    this.event("DISCOVERY_BATCH_EXPIRED", b);
    this.save();
  }
  private exhaust(b: Batch) {
    const c = this.counts(b);
    if (
      b.status === "PROCESSING" &&
      c.pendingCount === 0 &&
      c.runningCount === 0
    ) {
      b.status = "EXHAUSTED";
      this.event("DISCOVERY_BATCH_EXHAUSTED", b);
      this.save();
    }
  }
  poll() {
    this.expire();
    if (
      !this.flight &&
      this.now() >= this.state.retryAt &&
      this.state.batch?.status !== "PROCESSING"
    )
      void this.fetch();
  }
  fetch(): Promise<void> {
    this.expire();
    if (this.flight) return this.flight;
    if (
      this.now() < this.state.retryAt ||
      this.state.batch?.status === "PROCESSING"
    )
      return Promise.resolve();
    if (this.now() < (this.market.retryAt?.() ?? 0)) {
      this.state.retryAt = this.market.retryAt!();
      this.state.fetchError = "LAB_PROVIDER_COOLDOWN";
      this.save();
      return Promise.resolve();
    }
    this.state.listFetchCount++;
    this.store.event("DISCOVERY_BATCH_FETCH_START", undefined, {
      listFetchCount: this.state.listFetchCount,
      previousBatchId: this.state.batch?.batchId,
    });
    this.save();
    this.flight = this.receive()
      .catch((error) => {
        this.state.fetchError =
          error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "DISCOVERY_UNAVAILABLE";
        this.state.retryAt = Math.max(
          this.now() + FAILED_FETCH_RETRY_MS,
          this.market.retryAt?.() ?? 0,
        );
        this.store.event("DISCOVERY_BATCH_FETCH_FAILED", undefined, {
          batchId: this.state.batch?.batchId,
          reason: this.state.fetchError,
          retryAt: this.state.retryAt,
        });
        this.save();
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }
  private async receive() {
    const rows = await this.market.discover();
    const metadata = this.market.discoveryMetadata?.();
    const fetchedAt = metadata?.fetchedAt ?? this.now();
    if (!Number.isFinite(fetchedAt) || fetchedAt > this.now() || fetchedAt < 0)
      throw Error("DISCOVERY_BATCH_TIMESTAMP_INVALID");
    // Old installations had an unbounded, unbatched first-attempt queue. Preserve
    // those rows, but do not let an old snapshot silently schedule new work.
    this.store.expireLegacyUnstarted(this.mode, this.now());
    const unique = new Map<string, Candidate>();
    for (const c of rows) unique.set(this.appearance(c), c);
    const b: Batch = {
      batchId: randomUUID(),
      fetchedAt,
      expiresAt: fetchedAt + DISCOVERY_BATCH_TTL_MS,
      rawReceivedCount: metadata?.rawReceivedCount ?? rows.length,
      uniqueCount: unique.size,
      duplicateCount: rows.length - unique.size,
      status: "PROCESSING",
      jobs: [],
    };
    for (const [appearance, c] of unique) {
      let trial = this.store.appearance(appearance);
      if (
        trial?.status === "EXPIRED_UNPROCESSED" &&
        trial.checkedAt === undefined &&
        !trial.entry
      ) {
        trial = {
          ...trial,
          status: "ANALYZING",
          discoveredAt: c.discoveredAt,
          nextAt: this.now(),
          updatedAt: this.now(),
        };
        this.store.save(trial);
      } else if (trial) {
        b.jobs.push({ appearance, state: "DEDUPLICATED" });
        continue;
      } else
        trial = this.store.add(
          {
            mint: c.mint,
            symbol: c.symbol,
            name: c.name,
            logo: tokenLogo(c),
            discoveredAt: c.discoveredAt,
            appearance,
            mode: this.mode,
          },
          this.now(),
        );
      if (!trial) {
        b.jobs.push({ appearance, state: "DEDUPLICATED" });
        continue;
      }
      trial.discoveryBatch = {
        batchId: b.batchId,
        fetchedAt,
        expiresAt: b.expiresAt,
      };
      this.store.save(trial);
      this.store.set("candidate:" + trial.id, c);
      this.store.event("KRONOS_DISCOVERY", trial, {
        source: trial.source,
        appearance,
        batchId: b.batchId,
      });
      b.jobs.push({ appearance, trialId: trial.id, state: "PENDING" });
    }
    if (this.state.batch)
      this.store.set(this.key + ":previous", this.summary(this.state.batch));
    this.state.batch = b;
    this.state.fetchError = undefined;
    this.state.retryAt = b.jobs.some((j) => j.state === "PENDING")
      ? 0
      : this.now() + EMPTY_BATCH_RETRY_MS;
    this.event("DISCOVERY_BATCH_FETCHED", b);
    this.exhaust(b);
    this.save();
    // A provider/cache response already outside its original window grants no work.
    this.expire();
  }
  private appearance(c: Candidate) {
    const sequence = c.discovery?.trending?.sequenceStartedAt;
    const basis = c.discovery?.trending?.basis ?? "sol:5m:volume:desc";
    // The parser's transport timestamp is explicitly marked LOCAL_SNAPSHOT by
    // KronosMarket. Without provider identity, use a conservative stable fallback.
    const provider =
      c.discovery?.trending?.sequenceOrigin !== "LOCAL_SNAPSHOT" &&
      typeof sequence === "number" &&
      Number.isFinite(sequence) &&
      sequence > 0;
    const key = "discoveryAppearanceV1:" + this.mode + ":" + c.mint;
    const identity = provider
      ? `${this.mode}:${c.mint}:provider:${sequence}`
      : (this.store.get(key) ?? `${this.mode}:${c.mint}:stable:${basis}`);
    this.store.set(key, identity);
    return identity;
  }
  next(): LabTrial | undefined {
    this.expire();
    if (!this.canScheduleCandidates()) return;
    const b = this.state.batch;
    if (!b || b.status !== "PROCESSING") return;
    for (const job of b.jobs)
      if (job.state === "PENDING" && job.trialId) {
        const t = this.store.trial(job.trialId);
        if (t && !t.entry && t.status === "ANALYZING" && t.nextAt <= this.now())
          return t;
        if (
          !t ||
          t.checkedAt !== undefined ||
          t.entry ||
          ["REJECTED", "ERROR", "CLOSED"].includes(t.status)
        )
          job.state = "DEDUPLICATED";
      }
    this.exhaust(b);
  }
  canScheduleCandidates() {
    return this.now() >= (this.market.retryAt?.() ?? 0);
  }
  started(t: LabTrial) {
    if (t.entry) return;
    this.state.candidateEvaluationCount++;
    const b = this.state.batch,
      job = b?.jobs.find((j) => j.trialId === t.id && j.state === "PENDING");
    if (b && job) {
      job.state = "RUNNING";
      this.running.set(t.id, { batch: b, job });
      this.store.event("DISCOVERY_BATCH_TOKEN_STARTED", t, {
        batchId: b.batchId,
        candidateEvaluationCount: this.state.candidateEvaluationCount,
      });
    }
    this.save();
  }
  finished(t: LabTrial) {
    const running = this.running.get(t.id);
    if (!running) return;
    running.job.state = "PROCESSED";
    this.running.delete(t.id);
    this.store.event("DISCOVERY_BATCH_TOKEN_PROCESSED", t, {
      batchId: running.batch.batchId,
      outcome: t.status,
      ...this.counts(running.batch),
    });
    this.exhaust(running.batch);
    if (running.batch !== this.state.batch)
      this.store.set(this.key + ":previous", this.summary(running.batch));
    this.save();
  }
  view() {
    return {
      batch: this.state.batch ? this.summary(this.state.batch) : null,
      fetching: !!this.flight,
      fetchStatus: this.state.fetchError
        ? "FETCH_FAILED"
        : this.flight
          ? "FETCHING"
          : "IDLE",
      error: this.state.fetchError,
      retryAt: this.state.retryAt,
      listFetchCount: this.state.listFetchCount,
      candidateEvaluationCount: this.state.candidateEvaluationCount,
      ttlMs: DISCOVERY_BATCH_TTL_MS,
    };
  }
  async stop() {
    await this.flight;
  }
}
