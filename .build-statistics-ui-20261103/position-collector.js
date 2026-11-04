/** Per-position ownership and bounded provider collection, independent of analyst jobs. */
export class PositionCollector {
    concurrency;
    jobs = new Map();
    active = new Set();
    constructor(concurrency) {
        this.concurrency = concurrency;
    }
    collect(id, work) {
        const existing = this.jobs.get(id);
        if (existing)
            return existing.done;
        let resolve;
        const done = new Promise((r) => {
            resolve = r;
        });
        this.jobs.set(id, { work, done, resolve });
        this.pump();
        return done;
    }
    pump() {
        for (const [id, job] of this.jobs) {
            if (this.active.size >= this.concurrency())
                break;
            if (this.active.has(id))
                continue;
            this.active.add(id);
            void Promise.resolve()
                .then(job.work)
                .catch(() => { })
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
