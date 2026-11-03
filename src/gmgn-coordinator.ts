import { ProviderFailure } from "./domain.js";
import type { ProviderCooldownStore } from "./gmgn-provider-state.js";

export function gmgnRequestKey(args: string[]) {
  const index = args.findIndex((a) => a.startsWith("--"));
  if (index < 0) return JSON.stringify(args);
  const params: Array<[string, string | null]> = [],
    seen = new Set<string>();
  for (let n = index; n < args.length; n++) {
    const flag = args[n]!;
    if (!flag.startsWith("--") || seen.has(flag)) return JSON.stringify(args);
    seen.add(flag);
    const value =
      args[n + 1] && !args[n + 1]!.startsWith("--") ? args[++n]! : null;
    params.push([flag, value]);
  }
  return JSON.stringify({
    command: args.slice(0, index),
    params: params.sort((a, b) => a[0].localeCompare(b[0])),
  });
}

export class GmgnRateLimited extends ProviderFailure {
  constructor(public retryAfterMs?: number) {
    super("GMGN_RATE_LIMIT_COOLDOWN", "GMGN");
  }
}
export interface ReadOptions {
  priority?: number;
  consumer?: string;
  staleMs?: number;
}
export interface CoordinatorPolicy {
  concurrency?: number;
  intervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxQueue: number;
}
interface Job {
  key: string;
  createdAt: number;
  priority: number;
  consumer: string;
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
export interface SnapshotMeta {
  provider: "GMGN";
  source: string;
  fetchedAt: number;
  ageMs: number;
  freshness: "FRESH" | "STALE_USABLE" | "STALE" | "UNKNOWN";
}
/** One coordinator per runtime GMGN client. No credentials, token decisions or signing. */
export class GmgnCoordinator {
  private cache = new Map<string, { at: number; value: unknown }>();
  private flights = new Map<string, Promise<unknown>>();
  private jobs: Job[] = [];
  private active = false;
  private requests = new Set<Promise<void>>();
  private stopped = false;
  private nextAt = 0;
  private cooldownUntil = 0;
  private rateStreak = 0;
  private recoverySuccesses = 6;
  private lastSuccessAt = 0;
  private routineTurn = 0;
  private consumers: Record<string, number> = {};
  private waitTotal = 0;
  readonly metrics = {
    logicalReads: 0,
    actualCalls: 0,
    success: 0,
    failed: 0,
    rateLimited: 0,
    cacheHit: 0,
    cacheMiss: 0,
    staleHit: 0,
    singleFlightJoined: 0,
    singleFlightCreated: 0,
    cooldownStarted: 0,
    cooldownExtended: 0,
    cooldownRecovered: 0,
  };
  constructor(
    private policy: () => CoordinatorPolicy,
    private now = () => Date.now(),
    private wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    private random = () => Math.random(),
    private providerState?: ProviderCooldownStore,
  ) {}
  get cooling() {
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      this.providerState?.read() ?? 0,
    );
    return this.now() < this.cooldownUntil;
  }
  metadata(key: string, freshMs: number, staleMs = freshMs): SnapshotMeta {
    const c = this.cache.get(key),
      ageMs = c ? Math.max(0, this.now() - c.at) : 0;
    return {
      provider: "GMGN",
      source: key.split(":").slice(0, 2).join(":"),
      fetchedAt: c?.at ?? 0,
      ageMs,
      freshness: !c
        ? "UNKNOWN"
        : ageMs <= freshMs
          ? "FRESH"
          : ageMs <= staleMs
            ? "STALE_USABLE"
            : "STALE",
    };
  }
  private decorate(
    value: unknown,
    key: string,
    freshMs: number,
    staleMs: number,
  ) {
    const copy = structuredClone(value);
    if (copy && typeof copy === "object" && !Array.isArray(copy))
      Object.assign(copy, {
        _gmgnSnapshot: this.metadata(key, freshMs, staleMs),
      });
    return copy;
  }
  peek(key: string, ttl: number) {
    const cached = this.cache.get(key);
    return cached && this.now() - cached.at <= ttl
      ? this.decorate(cached.value, key, ttl, ttl)
      : undefined;
  }
  async read(
    key: string,
    ttl: number,
    work: () => Promise<unknown>,
    options: ReadOptions = {},
  ): Promise<unknown> {
    this.metrics.logicalReads++;
    const consumer = options.consumer ?? "other";
    this.consumers[consumer] = (this.consumers[consumer] ?? 0) + 1;
    const c = this.cache.get(key),
      age = c ? this.now() - c.at : Infinity,
      staleMs = options.staleMs ?? ttl;
    if (ttl > 0 && c && age <= ttl) {
      this.metrics.cacheHit++;
      return this.decorate(c.value, key, ttl, staleMs);
    }
    if (ttl > 0 && c && age <= staleMs) {
      this.metrics.staleHit++;
      if (!this.cooling) void this.enqueue(key, work, options).catch(() => {});
      return this.decorate(c.value, key, ttl, staleMs);
    }
    this.metrics.cacheMiss++;
    const value = await this.enqueue(key, work, options);
    return this.decorate(value, key, ttl || 10000, staleMs || 10000);
  }
  private enqueue(
    key: string,
    work: () => Promise<unknown>,
    options: ReadOptions,
  ) {
    if (this.stopped)
      return Promise.reject(
        new ProviderFailure("GMGN_COORDINATOR_STOPPED", "GMGN"),
      );
    const old = this.flights.get(key);
    if (old) {
      this.metrics.singleFlightJoined++;
      const job = this.jobs.find((j) => j.key === key);
      if (job) job.priority = Math.min(job.priority, options.priority ?? 4);
      return old;
    }
    if (this.cooling)
      return Promise.reject(
        new GmgnRateLimited(this.cooldownUntil - this.now()),
      );
    if (this.jobs.length >= this.policy().maxQueue)
      return Promise.reject(new ProviderFailure("GMGN_QUEUE_CAPACITY", "GMGN"));
    this.metrics.singleFlightCreated++;
    const promise = new Promise<unknown>((resolve, reject) =>
      this.jobs.push({
        key,
        work,
        resolve,
        reject,
        createdAt: this.now(),
        priority: options.priority ?? 4,
        consumer: options.consumer ?? "other",
      }),
    );
    this.flights.set(key, promise);
    void this.pump();
    return promise;
  }
  private async pump() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.jobs.length && !this.stopped) {
        if (this.requests.size >= (this.policy().concurrency ?? 1)) {
          await Promise.race(this.requests);
          continue;
        }
        // Re-sort after waiting so an arriving protective read can precede queued enrichment.
        await this.wait(Math.max(0, this.nextAt - this.now()));
        if (!this.jobs.length) break;
        const now = this.now();
        this.jobs.sort(
          (a, b) =>
            a.priority -
              Math.floor((now - a.createdAt) / 30000) -
              (b.priority - Math.floor((now - b.createdAt) / 30000)) ||
            a.createdAt - b.createdAt,
        );
        // Critical protective reads retain P0. Routine position, observation,
        // discovery/analysis work share slots; no class owns the entire budget.
        let selected = 0;
        if (!this.jobs.some((j) => j.priority === 0)) {
          const lane = (j: Job) =>
            j.consumer === "structure-observation"
              ? "watch"
              : j.consumer === "position-monitor"
                ? "position"
                : "other";
          const wheel = [
            "watch",
            "position",
            "watch",
            "other",
            "watch",
            "position",
            "watch",
          ];
          const wanted = wheel[this.routineTurn++ % wheel.length];
          const found = this.jobs.findIndex((j) => lane(j) === wanted);
          if (found >= 0) selected = found;
        } else selected = this.jobs.findIndex((j) => j.priority === 0);
        const job = this.jobs.splice(selected, 1)[0]!;
        const request = this.runJob(job, now);
        this.requests.add(request);
        void request.finally(() => this.requests.delete(request));
      }
    } finally {
      this.active = false;
    }
  }
  private async runJob(job: Job, now: number) {
    try {
      if (this.cooling) throw new GmgnRateLimited(this.cooldownUntil - now);
      this.waitTotal += now - job.createdAt;
      this.metrics.actualCalls++;
      this.nextAt =
        now + this.policy().intervalMs * (this.recoverySuccesses < 6 ? 3 : 1);
      const value = await job.work();
      this.cache.delete(job.key);
      this.cache.set(job.key, { at: this.now(), value });
      while (this.cache.size > 300)
        this.cache.delete(this.cache.keys().next().value!);
      this.metrics.success++;
      this.lastSuccessAt = this.now();
      if (this.recoverySuccesses < 6 && ++this.recoverySuccesses === 6) {
        this.rateStreak = 0;
        this.metrics.cooldownRecovered++;
      }
      job.resolve(value);
    } catch (error) {
      if (error instanceof GmgnRateLimited && !this.cooling) {
        this.metrics.rateLimited++;
        const p = this.policy(),
          fallback = Math.min(
            p.maxBackoffMs,
            p.baseBackoffMs * 2 ** Math.min(this.rateStreak, 10),
          );
        const delay =
          error.retryAfterMs ??
          Math.min(
            p.maxBackoffMs,
            Math.ceil(fallback * (1 + this.random() * 0.25)),
          );
        if (this.rateStreak) this.metrics.cooldownExtended++;
        else this.metrics.cooldownStarted++;
        this.cooldownUntil = this.now() + Math.max(1, delay);
        this.providerState?.extend(this.cooldownUntil, this.now());
        this.rateStreak++;
        this.recoverySuccesses = 0;
      } else if (!(error instanceof GmgnRateLimited)) this.metrics.failed++;
      job.reject(error);
      if (this.cooling) {
        for (const waiting of this.jobs.splice(0)) {
          this.flights.delete(waiting.key);
          waiting.reject(new GmgnRateLimited(this.cooldownUntil - this.now()));
        }
      }
    } finally {
      this.flights.delete(job.key);
    }
  }
  async stop() {
    this.stopped = true;
    for (const job of this.jobs.splice(0)) {
      this.flights.delete(job.key);
      job.reject(new ProviderFailure("GMGN_COORDINATOR_STOPPED", "GMGN"));
    }
    while (this.active) await this.wait(10);
    await Promise.all(this.requests);
  }
  status() {
    return {
      ...this.metrics,
      consumers: { ...this.consumers },
      state: this.cooling
        ? "RATE_LIMITED"
        : this.recoverySuccesses < 6
          ? "RECOVERING"
          : this.lastSuccessAt
            ? "HEALTHY"
            : "UNKNOWN",
      cooldownUntil: this.cooldownUntil,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - this.now()),
      queueDepth: this.jobs.length,
      inFlight: this.flights.size,
      cacheEntries: this.cache.size,
      lastSuccessAt: this.lastSuccessAt,
      averageQueueWaitMs: this.metrics.actualCalls
        ? Math.round(this.waitTotal / this.metrics.actualCalls)
        : 0,
      cacheHitRatio: this.metrics.logicalReads
        ? this.metrics.cacheHit / this.metrics.logicalReads
        : 0,
    };
  }
}

/** Parse only explicit retry guidance; never retain or log raw CLI stderr. */
export function retryDelay(text: string, now = Date.now()): number | undefined {
  const seconds = text.match(/retry-after\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  if (seconds) {
    const ms = Number(seconds[1]) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = text.match(/retry-after\s*[:=]\s*([^\r\n]+)/i);
  if (date) {
    const parsed = Date.parse(date[1]!);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  }
  const reset = text.match(
    /(?:until|resets at)\s+(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) GMT([+-]\d\d:\d\d)/,
  );
  if (reset) {
    const parsed = Date.parse(`${reset[1]}T${reset[2]}${reset[3]}`);
    return Number.isFinite(parsed)
      ? Math.max(0, parsed - now) + 1000
      : undefined;
  }
  const remaining = text.match(/\(~(\d+)s remaining\)/);
  return remaining ? Number(remaining[1]) * 1000 + 1000 : undefined;
}
