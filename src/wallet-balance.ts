/** Read-only presentation cache. No DB writes, signing or execution authority. */
export class WalletBalance {
  private pending?: Promise<void>;
  private nextAt = 0;
  private last?: { lamports: string; at: number };
  private failed = false;
  constructor(
    private readonly read?: () => Promise<bigint>,
    private readonly now = Date.now,
  ) {}
  view() {
    if (!this.read)
      return { lamports: null, at: null, stale: true, state: "NOT_CONFIGURED" };
    if (!this.pending && this.now() >= this.nextAt) {
      this.nextAt = this.now() + 15000;
      this.pending = Promise.resolve()
        .then(this.read)
        .then((value) => {
          if (typeof value !== "bigint" || value < 0n)
            throw Error("INVALID_BALANCE");
          this.last = { lamports: value.toString(), at: this.now() };
          this.failed = false;
        })
        .catch(() => {
          this.failed = true;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    const stale = !this.last || this.now() - this.last.at > 45000;
    return {
      lamports: this.last?.lamports ?? null,
      at: this.last?.at ?? null,
      stale,
      state: this.failed
        ? "UNAVAILABLE"
        : this.pending
          ? "LOADING"
          : stale
            ? "STALE"
            : "OK",
    };
  }
}
