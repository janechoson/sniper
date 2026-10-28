export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async drain() {
    await this.tail;
  }
}
export class BoundedQueue {
  private active = 0;
  private waiting: {
    work: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  constructor(
    private readonly concurrency = 4,
    private readonly capacity = 64,
  ) {}
  submit(work: () => Promise<void>): Promise<void> {
    if (this.waiting.length + this.active >= this.capacity)
      return Promise.reject(new Error("INGESTION_QUEUE_FULL"));
    const result = new Promise<void>((resolve, reject) =>
      this.waiting.push({ work, resolve, reject }),
    );
    this.pump();
    return result;
  }
  private pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      void job
        .work()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
  async drain() {
    while (this.active || this.waiting.length)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
