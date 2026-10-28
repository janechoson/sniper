import type { Repository, JournalEntry } from "./index";
export class NamespacedRepository implements Repository {
  private readonly prefix: string;
  constructor(
    private readonly repository: Repository,
    namespace: string,
  ) {
    if (!/^[a-z0-9-]+$/.test(namespace))
      throw new Error("JOURNAL_NAMESPACE_INVALID");
    this.prefix = namespace + ":";
  }
  async append(entry: JournalEntry) {
    await this.repository.append({ ...entry, id: this.prefix + entry.id });
  }
  async read() {
    const rows = this.repository.readPrefix
      ? await this.repository.readPrefix(this.prefix)
      : await this.repository.read();
    return rows
      .filter((entry) => entry.id.startsWith(this.prefix))
      .map((entry) => ({ ...entry, id: entry.id.slice(this.prefix.length) }));
  }
  async has(id: string) {
    return this.repository.has
      ? this.repository.has(this.prefix + id)
      : (await this.repository.read()).some(
          (entry) => entry.id === this.prefix + id,
        );
  }
  async page(kind: string, offset: number, limit: number) {
    if (this.repository.page) {
      const result = await this.repository.page(
        kind,
        offset,
        limit,
        this.prefix,
      );
      return {
        ...result,
        entries: result.entries.map((e) => ({
          ...e,
          id: e.id.slice(this.prefix.length),
        })),
      };
    }
    const values = (await this.read()).filter((e) => e.kind === kind).reverse();
    return {
      total: values.length,
      entries: values.slice(offset, offset + limit),
    };
  }
  health() {
    return this.repository.health();
  }
  close() {
    return this.repository.close();
  }
}
export class LegacyMockRepository implements Repository {
  constructor(private readonly repository: Repository) {}
  append(entry: JournalEntry) {
    return this.repository.append(entry);
  }
  async read() {
    return (await this.repository.read()).filter(
      (entry) =>
        !/^real-(paper|live|live-dry-run):/.test(entry.id) &&
        !(
          entry.kind === "local.import.complete" &&
          entry.id.startsWith("local-import:")
        ),
    );
  }
  async has(id: string) {
    return this.repository.has
      ? this.repository.has(id)
      : (await this.read()).some((entry) => entry.id === id);
  }
  health() {
    return this.repository.health();
  }
  close() {
    return this.repository.close();
  }
}
