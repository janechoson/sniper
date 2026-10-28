import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, unlink, rmdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SqliteRepository, NamespacedRepository } from "@sniper/storage";
import { PrismaClient } from "../packages/storage/generated/client/client";
import { PaperEngine } from "@sniper/engine";
import { chainsFromEnv, loadEnv } from "@sniper/config";
import { mockDiscoveryEvent } from "@sniper/chains/discovery";
import { DurableExecutionStore } from "@sniper/execution";
const run = promisify(execFile);
let directory: string, path: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sniper-sqlite-"));
  path = join(directory, "trading.db");
  await run(
    process.execPath,
    [
      resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
      "--schema",
      "packages/storage/sqlite/schema.prisma",
    ],
    {
      env: {
        ...process.env,
        RUST_LOG: "info",
        DATABASE_URL:
          "file:" +
          relative(resolve("packages/storage/sqlite"), path).replaceAll(
            "\\",
            "/",
          ),
      },
      windowsHide: true,
    },
  );
}, 30000);
afterAll(async () => {
  for (const name of await readdir(directory))
    await unlink(join(directory, name));
  await rmdir(directory);
});
describe("SQLite local thật", () => {
  it("funding chỉ tham khảo: lưu true/false và giữ UNKNOWN qua SQLite", async () => {
    const repo = new SqliteRepository(path);
    try {
      for (const [i, value] of [undefined, false, true].entries()) {
        await repo.append({
          id: `research-funding-${i}`,
          kind: "funding-research.fixture",
          payload: {
            creator: value === undefined ? {} : { knownBadFunding: value },
          },
          createdAt: Date.now(),
        });
      }
      const rows = (await repo.read()).filter(
        (r) => r.kind === "funding-research.fixture",
      );
      expect(rows).toHaveLength(3);
      for (const [i, value] of [undefined, false, true].entries()) {
        const row = rows.find((r) => r.id === `research-funding-${i}`)!;
        expect(
          (row.payload as { creator: { knownBadFunding?: boolean } }).creator
            .knownBadFunding,
        ).toBe(value);
      }
    } finally {
      await repo.close();
    }
  });
  it("WAL, ghi đồng thời, chống trùng và rollback toàn bộ projection lỗi", async () => {
    const repo = new SqliteRepository(path);
    try {
      expect(await repo.health()).toBe(true);
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          repo.append({
            id: `row-${i}`,
            kind: "fixture",
            payload: { i },
            createdAt: Date.now(),
          }),
        ),
      );
      await repo.append({
        id: "row-0",
        kind: "fixture",
        payload: { i: 99 },
        createdAt: Date.now(),
      });
      expect((await repo.page("fixture", 0, 20)).total).toBe(12);
      await expect(
        repo.append({
          id: "real-paper:bad",
          kind: "real.candidate",
          payload: { invalid: true },
          createdAt: Date.now(),
        }),
      ).rejects.toThrow();
      expect(await repo.has("real-paper:bad")).toBe(false);
      await expect(
        repo.append({
          id: "secret",
          kind: "fixture",
          payload: { nested: { EVM_PRIVATE_KEY: "fixture-only" } },
          createdAt: Date.now(),
        }),
      ).rejects.toThrow("SECRET_PERSISTENCE_FORBIDDEN");
      expect(await repo.has("secret")).toBe(false);
      const client = new PrismaClient({
        datasources: {
          db: {
            url:
              "file:" +
              relative(resolve("packages/storage/sqlite"), path).replaceAll(
                "\\",
                "/",
              ),
          },
        },
      });
      try {
        expect(await client.$queryRawUnsafe("PRAGMA journal_mode")).toEqual([
          { journal_mode: "wal" },
        ]);
      } finally {
        await client.$disconnect();
      }
    } finally {
      await repo.close();
    }
  });
  it("sao lưu nhất quán khi có ghi và phục hồi vào file mới; cấm ghi đè", async () => {
    const repo = new SqliteRepository(path),
      backup = join(directory, "backup.db"),
      restored = join(directory, "restored.db");
    try {
      const write = repo.append({
        id: "before-backup",
        kind: "backup-fixture",
        payload: { amount: "12345678901234567890" },
        createdAt: Date.now(),
      });
      await repo.backup(backup);
      await write;
      await expect(repo.backup(backup)).rejects.toThrow(
        "BACKUP_DESTINATION_EXISTS",
      );
      const source = new SqliteRepository(backup);
      try {
        expect(await source.has("before-backup")).toBe(true);
        await source.backup(restored);
      } finally {
        await source.close();
      }
      const check = new SqliteRepository(restored);
      try {
        expect(await check.has("before-backup")).toBe(true);
      } finally {
        await check.close();
      }
    } finally {
      await repo.close();
    }
  });
  it("phục hồi vị thế đang mở và không tạo fill trùng sau restart", async () => {
    const chains = chainsFromEnv(loadEnv({}));
    const engine = new PaperEngine({
      repository: new NamespacedRepository(
        new SqliteRepository(path),
        "test-paper",
      ),
      chains,
      logLevel: "silent",
    });
    await engine.initialize();
    await engine.setRunning(true);
    const event = mockDiscoveryEvent("solana", 0);
    await engine.updateSettings({ tradeSizeUsd: 50 });
    await engine.ingest(event);
    const before = await engine.snapshot();
    expect(before.positions.length).toBeGreaterThan(0);
    await engine.shutdown();
    const restarted = new PaperEngine({
      repository: new NamespacedRepository(
        new SqliteRepository(path),
        "test-paper",
      ),
      chains,
      logLevel: "silent",
    });
    try {
      await restarted.initialize();
      await restarted.setRunning(true);
      await restarted.ingest(event);
      const after = await restarted.snapshot();
      expect(after.positions).toHaveLength(before.positions.length);
      for (const [i, position] of after.positions.entries()) {
        const previous = before.positions[i]!;
        expect(position.entryPriceUsd).toBeCloseTo(previous.entryPriceUsd, 14);
        expect(position.currentPriceUsd).toBeCloseTo(
          previous.currentPriceUsd,
          14,
        );
        expect(position.highestPriceUsd).toBeCloseTo(
          previous.highestPriceUsd,
          14,
        );
        expect({
          ...position,
          currentPriceUsd: 0,
          highestPriceUsd: 0,
          entryPriceUsd: 0,
        }).toEqual({
          ...previous,
          currentPriceUsd: 0,
          highestPriceUsd: 0,
          entryPriceUsd: 0,
        });
      }
      expect(after.metrics.trades).toBe(before.metrics.trades);
    } finally {
      await restarted.shutdown();
    }
  });
  it("giữ nguyên UNKNOWN và namespace LIVE sau khi mở lại file", async () => {
    const repo = new SqliteRepository(path),
      live = new NamespacedRepository(repo, "real-live"),
      store = new DurableExecutionStore(live);
    await store.put({
      id: "execution-unknown",
      intentId: "intent-unknown",
      idempotencyKey: "unknown-key",
      walletId: "trading-evm",
      chainId: "bnb",
      mode: "LIVE",
      state: "UNKNOWN",
      transactionId: "0xfixture",
      updatedAt: Date.now(),
      reasons: ["RECEIPT_UNAVAILABLE"],
    });
    await repo.close();
    const reopened = new SqliteRepository(path);
    try {
      const recovered = new DurableExecutionStore(
        new NamespacedRepository(reopened, "real-live"),
      );
      await recovered.restore();
      expect(recovered.get("unknown-key")?.state).toBe("UNKNOWN");
      expect(recovered.get("unknown-key")?.transactionId).toBe("0xfixture");
      expect(
        (await new NamespacedRepository(reopened, "real-paper").read()).some(
          (e) => e.kind === "execution.record",
        ),
      ).toBe(false);
    } finally {
      await reopened.close();
    }
  });
});
