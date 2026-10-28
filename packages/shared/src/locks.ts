export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.tails.set(key, result);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === result) this.tails.delete(key);
    }
  }
}
