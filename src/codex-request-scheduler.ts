export type CodexPriority = "GUARD" | "VALIDATION" | "LEARNING";

type Request<T> = {
  priority: CodexPriority;
  sequence: number;
  enqueuedAt: number;
  minIntervalMs: number;
  signal?: AbortSignal;
  work: (signal: AbortSignal) => Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  abort?: () => void;
  onStart?: (queueWaitMs:number) => void;
};

const rank: Record<CodexPriority, number> = { GUARD: 0, VALIDATION: 1, LEARNING: 2 };

/** One non-preemptive Codex lane. Urgent guards outrank queued background work. */
export class CodexRequestScheduler {
  private queue: Request<unknown>[] = [];
  private active?: { priority: CodexPriority; startedAt: number; controller: AbortController };
  private sequence = 0;
  private lastBackgroundStartedAt = 0;
  private wake?: ReturnType<typeof setTimeout>;
  private completed = 0;
  private failed = 0;
  private waitSamples: number[] = [];

  submit<T>(priority: CodexPriority, work: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; minIntervalMs?: number; maxQueue?: number; onStart?: (queueWaitMs:number)=>void } = {}) {
    if (options.signal?.aborted) return Promise.reject(Error("CODEX_REQUEST_CANCELLED"));
    if (this.queue.length >= (options.maxQueue ?? 100)) return Promise.reject(Error("CODEX_QUEUE_FULL"));
    return new Promise<T>((resolve, reject) => {
      const req: Request<T> = { priority, sequence: this.sequence++, enqueuedAt: Date.now(), minIntervalMs: Math.max(0, options.minIntervalMs ?? 0), signal: options.signal, work, resolve, reject, onStart:options.onStart };
      req.abort = () => {
        const index = this.queue.indexOf(req as Request<unknown>);
        if (index >= 0) { this.queue.splice(index, 1); options.signal?.removeEventListener("abort", req.abort!); reject(Error("CODEX_REQUEST_CANCELLED")); if(!this.queue.length&&this.wake){clearTimeout(this.wake);this.wake=undefined;} this.schedule(); }
        else if (this.active?.priority === priority) this.active.controller.abort();
      };
      options.signal?.addEventListener("abort", req.abort, { once: true });
      this.queue.push(req as Request<unknown>);
      this.sort();
      if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
      this.schedule();
    });
  }

  private sort() { this.queue.sort((a, b) => rank[a.priority] - rank[b.priority] || a.sequence - b.sequence); }

  private schedule() {
    if (this.active || this.wake) return;
    this.sort();
    const next = this.queue[0];
    if (!next) return;
    const wait = next.priority === "GUARD" ? 0 : Math.max(0, this.lastBackgroundStartedAt + next.minIntervalMs - Date.now());
    if (wait) { this.wake = setTimeout(() => { this.wake = undefined; this.schedule(); }, wait); return; }
    this.queue.shift();
    next.signal?.removeEventListener("abort", next.abort!);
    if (next.signal?.aborted) { next.reject(Error("CODEX_REQUEST_CANCELLED")); this.schedule(); return; }
    const controller = new AbortController();
    this.active = { priority: next.priority, startedAt: Date.now(), controller };
    this.waitSamples.push(Math.max(0, this.active.startedAt - next.enqueuedAt));
    next.onStart?.(Math.max(0,this.active.startedAt-next.enqueuedAt));
    if (this.waitSamples.length > 1000) this.waitSamples.shift();
    const relay = () => controller.abort();
    next.signal?.addEventListener("abort", relay, { once: true });
    if (next.signal?.aborted) controller.abort();
    void next.work(controller.signal).then((value) => { this.completed++; next.resolve(value); }, (error) => { this.failed++; next.reject(error instanceof Error ? error : Error("CODEX_REQUEST_FAILED")); }).finally(() => {
      next.signal?.removeEventListener("abort", relay);
      next.signal?.removeEventListener("abort", next.abort!);
      if (next.priority !== "GUARD") this.lastBackgroundStartedAt = Date.now();
      this.active = undefined;
      this.schedule();
    });
  }

  status() {
    const waits = [...this.waitSamples].sort((a, b) => a - b);
    const percentile = (p: number) => waits.length ? waits[Math.min(waits.length - 1, Math.ceil(waits.length * p) - 1)]! : null;
    return { concurrency: 1, active: this.active?.priority ?? null, activeForMs: this.active ? Date.now() - this.active.startedAt : 0, queued: this.queue.length, queuedByPriority: { guard: this.queue.filter((r) => r.priority === "GUARD").length, validation: this.queue.filter((r) => r.priority === "VALIDATION").length, learning: this.queue.filter((r) => r.priority === "LEARNING").length }, completed: this.completed, failed: this.failed, queueWaitMs: { p50: percentile(0.5), p95: percentile(0.95), sampleCount: waits.length } };
  }
}
