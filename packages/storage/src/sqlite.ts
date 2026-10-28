import { mkdir, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { PrismaClient, Prisma } from "../generated/client/client";
import { KeyedLock } from "@sniper/shared";
import {
  journalEntrySchema,
  type JournalEntry,
  type Repository,
} from "./index";
import { projectCommit, toJson } from "./projections";
import { projectProductionEntry } from "./production-projections";
export function assertNoSecrets(value: unknown, depth = 0) {
  if (depth > 40) throw new Error("PERSISTENCE_DEPTH_LIMIT");
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const name = key.replace(/[_-]/g, "").toLowerCase();
    if (
      [
        "privatekey",
        "evmprivatekey",
        "solanaprivatekey",
        "mnemonic",
        "seed",
        "seedphrase",
        "walletsecret",
        "apikey",
        "typesafeapikey",
        "jupiterapikey",
        "authorization",
        "signedtransaction",
        "rawsignedtransaction",
      ].includes(name) &&
      item !== null &&
      item !== undefined &&
      item !== ""
    )
      throw new Error("SECRET_PERSISTENCE_FORBIDDEN");
    assertNoSecrets(item, depth + 1);
  }
}
export class SqliteRepository implements Repository {
  private readonly client: PrismaClient;
  private readonly writes = new KeyedLock();
  private opened = false;
  private opening?: Promise<void>;
  private closed = false;
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    this.client = new PrismaClient({
      datasources: {
        db: {
          url:
            "file:" +
            relative(resolve("packages/storage/sqlite"), this.path).replaceAll(
              "\\",
              "/",
            ),
        },
      },
    });
  }
  private async open() {
    if (this.closed) throw new Error("REPOSITORY_CLOSED");
    if (this.opened) return;
    if (this.opening) return this.opening;
    this.opening = this.connect();
    try {
      await this.opening;
    } finally {
      this.opening = undefined;
    }
  }
  private async connect() {
    await mkdir(dirname(this.path), { recursive: true });
    await this.client.$connect();
    await this.client.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await this.client.$queryRawUnsafe("PRAGMA synchronous=FULL");
    await this.client.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    await this.client.$queryRawUnsafe("PRAGMA foreign_keys=ON");
    this.opened = true;
  }
  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++)
      try {
        return await work();
      } catch (error) {
        const busy =
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P1008", "P2028", "P2034"].includes(error.code)) ||
          (error instanceof Error &&
            /SQLITE_BUSY|database is locked/i.test(error.message));
        if (!busy || attempt >= 2) throw error;
        await new Promise((done) => setTimeout(done, 100 * (attempt + 1)));
      }
  }
  async append(input: JournalEntry) {
    const entry = journalEntrySchema.parse(input);
    assertNoSecrets(entry.payload);
    await this.writes.run("writer", async () => {
      await this.open();
      await this.retry(() =>
        this.client.$transaction(
          async (tx) => {
            if (await tx.journalEntry.findUnique({ where: { id: entry.id } }))
              return;
            await tx.journalEntry.create({
              data: {
                id: entry.id,
                kind: entry.kind,
                chainId: entry.chainId,
                tokenAddress: entry.tokenAddress,
                payload: toJson(entry.payload),
                createdAt: new Date(entry.createdAt),
              },
            });
            if (entry.kind === "commit")
              await projectCommit(tx, entry.payload, entry.id, entry.createdAt);
            else await projectProductionEntry(tx, entry);
          },
          { timeout: 20000, maxWait: 5000 },
        ),
      );
    });
  }
  private entry(row: {
    id: string;
    kind: string;
    chainId: string | null;
    tokenAddress: string | null;
    payload: unknown;
    createdAt: Date;
  }): JournalEntry {
    return {
      id: row.id,
      kind: row.kind,
      chainId: row.chainId ?? undefined,
      tokenAddress: row.tokenAddress ?? undefined,
      payload: row.payload,
      createdAt: row.createdAt.getTime(),
    };
  }
  async read() {
    await this.open();
    return (
      await this.client.journalEntry.findMany({ orderBy: { sequence: "asc" } })
    ).map((row) => this.entry(row));
  }
  async has(id: string) {
    await this.open();
    return !!(await this.client.journalEntry.findUnique({
      where: { id },
      select: { id: true },
    }));
  }
  async readPrefix(prefix: string) {
    await this.open();
    return (
      await this.client.journalEntry.findMany({
        where: { id: { startsWith: prefix } },
        orderBy: { sequence: "asc" },
      })
    ).map((row) => this.entry(row));
  }
  async page(kind: string, offset: number, limit: number, prefix = "") {
    await this.open();
    const where = { kind, id: { startsWith: prefix } };
    const [total, rows] = await this.client.$transaction([
      this.client.journalEntry.count({ where }),
      this.client.journalEntry.findMany({
        where,
        orderBy: { sequence: "desc" },
        skip: offset,
        take: limit,
      }),
    ]);
    return { total, entries: rows.map((row) => this.entry(row)) };
  }
  async health() {
    try {
      await this.open();
      await this.client.$queryRawUnsafe("SELECT 1");
      await this.client.journalEntry.count();
      return true;
    } catch {
      return false;
    }
  }
  async backup(destination: string) {
    await this.writes.run("writer", async () => {
      const target = resolve(destination);
      if (
        await stat(target).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        throw new Error("BACKUP_DESTINATION_EXISTS");
      await mkdir(dirname(target), { recursive: true });
      await this.open();
      await this.client.$executeRawUnsafe("VACUUM INTO ?", target);
    });
  }
  async close() {
    await this.writes.run("writer", async () => {
      if (this.closed) return;
      this.closed = true;
      await this.client.$disconnect();
    });
  }
}
