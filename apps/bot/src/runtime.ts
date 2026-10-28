import { mkdir, open, readFile, unlink, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  loadEnv,
  chainsFromEnv,
  applyRpcConfiguration,
  loadRealConfig,
  realConfigSchema,
  operationalMode,
} from "@sniper/config";
import { createLogger } from "@sniper/shared";
import {
  JournalRepository,
  SqliteRepository,
  journalEntrySchema,
  assertNoSecrets,
  NamespacedRepository,
  type Repository,
} from "@sniper/storage";
import { RealTradingEngine } from "@sniper/engine";
import { TradingWallet } from "@sniper/wallet";
export async function createBotRuntime() {
  const env = loadEnv();
  if (env.DATA_MODE !== "real") throw new Error("RUNTIME_REQUIRES_REAL_DATA");
  const logger = createLogger(env.LOG_LEVEL);
  const directory = resolve(env.DATA_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, "worker.lock");
  async function acquireLock(): Promise<void> {
    try {
      const lock = await open(lockPath, "wx");
      await lock.writeFile(String(process.pid));
      await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(
          "Khóa tiến trình không hợp lệ; kiểm tra data/worker.lock",
        );
      try {
        process.kill(pid, 0);
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(lockPath);
          return acquireLock();
        }
        throw check;
      }
      throw new Error("Đã có tiến trình bot sử dụng thư mục dữ liệu này");
    }
  }
  await acquireLock();
  let startupRepository: Repository | undefined;
  try {
    const baseRepository =
      env.STORAGE_DRIVER === "sqlite"
        ? new SqliteRepository(
            env.SQLITE_PATH ?? resolve(directory, "trading.db"),
          )
        : new JournalRepository(
            env.DATA_MODE === "real"
              ? resolve(
                  directory,
                  `real-${operationalMode(env).toLowerCase().replaceAll("_", "-")}`,
                )
              : directory,
          );
    startupRepository = baseRepository;
    if (baseRepository instanceof SqliteRepository && env.IMPORT_LEGACY_JOURNAL)
      await importLegacyJournals(directory, baseRepository);
    const repository = new NamespacedRepository(
      baseRepository,
      env.OBSERVATION_ONLY
        ? "real-observation"
        : `real-${operationalMode(env).toLowerCase().replaceAll("_", "-")}`,
    );
    const engine = await (async () => {
      let configurationLoaded = true;
      const config = await loadRealConfig(env.REAL_CONFIG_PATH).catch(
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("REAL_CONFIG_INVALID");
          configurationLoaded = false;
          return realConfigSchema.parse({ version: 1 });
        },
      );
      return new RealTradingEngine({
        repository,
        chains: applyRpcConfiguration(chainsFromEnv(env), env),
        env,
        config,
        wallets: new TradingWallet(
          chainsFromEnv(env),
          env.OBSERVATION_ONLY ? {} : process.env,
        ),
        configurationLoaded,
      });
    })();
    let stopped = false;
    const shutdown = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await engine.shutdown();
      } finally {
        await baseRepository.close();
        if (
          (await readFile(lockPath, "utf8").catch(() => "")) ===
          String(process.pid)
        )
          await unlink(lockPath);
      }
    };
    try {
      await engine.initialize();
    } catch (error) {
      await shutdown();
      throw error;
    }
    return { engine, env, logger, shutdown };
  } catch (error) {
    await startupRepository?.close();
    if (
      (await readFile(lockPath, "utf8").catch(() => "")) === String(process.pid)
    )
      await unlink(lockPath);
    throw error;
  }
}
async function importLegacyJournals(
  directory: string,
  repository: SqliteRepository,
) {
  // Import lại theo ID an toàn nếu tiến trình trước dừng giữa chừng; không sửa nguồn.
  const entries = [];
  const markers = [];
  for (const folder of ["", "real-paper", "real-live-dry-run", "real-live"]) {
    const file = resolve(directory, folder, "journal.jsonl");
    const size = await stat(file).then(
      (s) => s.size,
      (error) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
    if (size > 64 * 1024 * 1024)
      throw new Error("LEGACY_JOURNAL_REQUIRES_EXPLICIT_IMPORT");
    const content = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (Buffer.byteLength(content) > 64 * 1024 * 1024)
      throw new Error("LEGACY_JOURNAL_REQUIRES_EXPLICIT_IMPORT");
    if (!content.trim()) continue;
    const markerId =
      "local-import:" +
      createHash("sha256")
        .update(folder + "\n" + content)
        .digest("hex");
    if (await repository.has(markerId)) continue;
    for (const line of content.split(/\r?\n/).filter((line) => line.trim())) {
      const entry = journalEntrySchema.parse(JSON.parse(line));
      assertNoSecrets(entry.payload);
      if (folder && !entry.id.startsWith(folder + ":"))
        entry.id = folder + ":" + entry.id;
      entries.push(entry);
    }
    markers.push({
      id: markerId,
      kind: "local.import.complete",
      createdAt: Date.now(),
      payload: { folder, bytes: size },
    });
  }
  for (const entry of entries) await repository.append(entry);
  for (const marker of markers) await repository.append(marker);
}
