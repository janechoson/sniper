/** Per-position ownership and bounded provider collection, independent of analyst jobs. */
export class PositionCollector {
  private jobs = new Map<
    string,
    { work: () => Promise<void>; done: Promise<void>; resolve: () => void }
  >();
  private active = new Set<string>();
  constructor(private concurrency: () => number) {}
  collect(id: string, work: () => Promise<void>) {
    const existing = this.jobs.get(id);
    if (existing) return existing.done;
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.jobs.set(id, { work, done, resolve });
    this.pump();
    return done;
  }
  private pump() {
    for (const [id, job] of this.jobs) {
      if (this.active.size >= this.concurrency()) break;
      if (this.active.has(id)) continue;
      this.active.add(id);
      void Promise.resolve()
        .then(job.work)
        .catch(() => {})
        .finally(() => {
          this.active.delete(id);
          this.jobs.delete(id);
          job.resolve();
          this.pump();
        });
    }
  }
  async idle() {
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
  get size() {
    return this.jobs.size;
  }
}
