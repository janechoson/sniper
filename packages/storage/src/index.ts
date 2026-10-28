import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
export * from "./namespace";
export const journalEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  chainId: z.string().optional(),
  tokenAddress: z.string().optional(),
  payload: z.unknown(),
  createdAt: z.number().finite(),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;
export interface Repository {
  append(entry: JournalEntry): Promise<void>;
  read(): Promise<JournalEntry[]>;
  readPrefix?(prefix: string): Promise<JournalEntry[]>;
  health(): Promise<boolean>;
  close(): Promise<void>;
  has?(id: string): Promise<boolean>;
  page?(
    kind: string,
    offset: number,
    limit: number,
    prefix?: string,
  ): Promise<{ total: number; entries: JournalEntry[] }>;
}
export class MemoryRepository implements Repository {
  protected entries: JournalEntry[] = [];
  async append(entry: JournalEntry) {
    if (!this.entries.some((x) => x.id === entry.id))
      this.entries.push(structuredClone(entry));
  }
  async read() {
    return structuredClone(this.entries);
  }
  async has(id: string) {
    return this.entries.some((entry) => entry.id === id);
  }
  async page(kind: string, offset: number, limit: number, prefix = "") {
    const values = this.entries.filter(
      (e) => e.kind === kind && e.id.startsWith(prefix),
    );
    return {
      total: values.length,
      entries: structuredClone(values.reverse().slice(offset, offset + limit)),
    };
  }
  async health() {
    return true;
  }
  async close() {}
}
export class JournalRepository implements Repository {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly directory: string) {}
  private path() {
    return join(this.directory, "journal.jsonl");
  }
  async page(kind: string, offset: number, limit: number, prefix = "") {
    await this.tail;
    const size = await stat(this.path())
      .then((value) => value.size)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      });
    if (!size) return { total: 0, entries: [] };
    const scan = async (visit: (entry: JournalEntry) => void) => {
      const input = createReadStream(this.path(), {
          encoding: "utf8",
          end: size - 1,
        }),
        lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const entry = journalEntrySchema.parse(JSON.parse(line));
          if (entry.kind === kind && entry.id.startsWith(prefix)) visit(entry);
        }
      } finally {
        lines.close();
        input.destroy();
      }
    };
    let total = 0;
    await scan(() => total++);
    let index = 0;
    const entries: JournalEntry[] = [];
    await scan((entry) => {
      if (index >= total - offset - limit && index < total - offset)
        entries.push(entry);
      index++;
    });
    return { total, entries: entries.reverse() };
  }
  async has(id: string) {
    const input = createReadStream(this.path(), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line && journalEntrySchema.parse(JSON.parse(line)).id === id)
          return true;
      }
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      lines.close();
      input.destroy();
    }
  }
  async append(entry: JournalEntry) {
    if (this.closed) throw new Error("REPOSITORY_CLOSED");
    const work = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(
        this.path(),
        JSON.stringify(journalEntrySchema.parse(entry)) + "\n",
        { encoding: "utf8", flush: true },
      );
    });
    this.tail = work.catch(() => undefined);
    await work;
  }
  async read() {
    let contents: string;
    try {
      contents = await readFile(this.path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Dòng bị cắt hoặc hỏng là lỗi toàn vẹn dữ liệu, không được âm thầm bỏ qua.
    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => journalEntrySchema.parse(JSON.parse(line)));
  }
  async health() {
    try {
      await mkdir(this.directory, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    this.closed = true;
    await this.tail;
  }
}
export * from "./sqlite";
