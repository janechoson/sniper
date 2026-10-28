import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { parseArgs } from "node:util";
const action = process.argv[2] ?? "migrate";
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    file: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  },
});
const path = resolve(
  process.env.SQLITE_PATH ??
    resolve(process.env.DATA_DIRECTORY ?? "data", "trading.db"),
);
await mkdir(dirname(path), { recursive: true });
async function prisma(args: string[]) {
  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/prisma/build/index.js"),
      ...args,
      "--schema",
      "packages/storage/sqlite/schema.prisma",
    ],
    {
      stdio: "inherit",
      windowsHide: true,
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
    },
  );
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  if (code !== 0) throw new Error("SQLITE_MIGRATION_OR_GENERATION_FAILED");
}
try {
  if (action === "migrate") await prisma(["migrate", "deploy"]);
  else if (action === "generate") await prisma(["generate"]);
  else if (action === "validate") await prisma(["validate"]);
  else if (action === "backup") {
    await stat(path);
    await mkdir("backups", { recursive: true });
    const backup = resolve(
      "backups",
      `trading-${new Date().toISOString().replaceAll(":", "-")}.db`,
    );
    const { SqliteRepository } = await import("@sniper/storage");
    const repository = new SqliteRepository(path);
    try {
      await repository.backup(backup);
      process.stdout.write(`Đã sao lưu nhất quán: ${backup}\n`);
    } finally {
      await repository.close();
    }
  } else if (action === "restore") {
    if (!values.from || !values.to)
      throw new Error(
        "Dùng --from backups/file.db --to data/restored.db; không tự ghi đè database đang dùng",
      );
    const target = resolve(values.to);
    if (target === path)
      throw new Error("RESTORE_TO_ACTIVE_DATABASE_FORBIDDEN");
    const { SqliteRepository } = await import("@sniper/storage");
    const source = new SqliteRepository(resolve(values.from));
    try {
      await stat(resolve(values.from));
      if (!(await source.health())) throw new Error("RESTORE_SOURCE_INVALID");
      await source.backup(target);
      process.stdout.write(
        `Đã phục hồi vào file mới: ${target}. Đặt SQLITE_PATH tới file này sau khi dừng bot.\n`,
      );
    } finally {
      await source.close();
    }
  } else if (action === "import") {
    if (!values.file) throw new Error("Dùng --file đường-dẫn-journal.jsonl");
    if ((await stat(values.file)).size > 64 * 1024 * 1024)
      throw new Error("IMPORT_FILE_LIMIT_64MB_SPLIT_EXPORT_REQUIRED");
    const { SqliteRepository, journalEntrySchema, assertNoSecrets } =
      await import("@sniper/storage");
    const entries = (await readFile(values.file, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => journalEntrySchema.parse(JSON.parse(line)));
    for (const entry of entries) assertNoSecrets(entry.payload);
    const repository = new SqliteRepository(path);
    try {
      if (!(await repository.health())) throw new Error("RUN_DB_MIGRATE_FIRST");
      for (const entry of entries) await repository.append(entry);
      process.stdout.write(
        `Đã nhập ${entries.length} bản ghi; giữ ID/namespace, không sửa file nguồn.\n`,
      );
    } finally {
      await repository.close();
    }
  } else throw new Error("UNKNOWN_DATABASE_COMMAND");
} catch (error) {
  process.stderr.write(
    error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
      ? error.message + "\n"
      : "Thao tác database thất bại; kiểm tra tham số, migration và quyền file.\n",
  );
  process.exitCode = 1;
}
