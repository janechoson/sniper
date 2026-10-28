import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
const localNode22 = resolve(
  "data/runtime-download/node-v22.23.4-win-x64/node.exe",
);
if (
  Number(process.versions.node.split(".")[0]) < 22 &&
  process.platform === "win32" &&
  existsSync(localNode22)
) {
  const runtime = spawn(
    localNode22,
    ["--import", "tsx", ...process.argv.slice(1)],
    { stdio: "inherit", windowsHide: true, env: process.env },
  );
  const code = await new Promise((done, reject) => {
    runtime.once("error", reject);
    runtime.once("exit", done);
  });
  process.exit(code ?? 1);
}
try {
  if (process.env.SNIPER_SKIP_ENV_FILE !== "true") loadEnvFile(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const pid = Number(
  await readFile(
    resolve(process.env.DATA_DIRECTORY ?? "data", "worker.lock"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") return "0";
    throw error;
  }),
);
if (pid > 0) {
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (alive)
    throw new Error(
      "Bot đã chạy với thư mục dữ liệu này; dừng instance cũ trước khi migrate.",
    );
}
const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/database.ts", "migrate"],
  { stdio: "inherit", windowsHide: true, env: process.env },
);
const code = await new Promise((done, reject) => {
  child.once("error", reject);
  child.once("exit", done);
});
if (code !== 0) process.exitCode = code ?? 1;
else {
  if (process.argv[2] === "dev") process.argv.push("--dev");
  await import("../apps/local/src/main.ts");
}
