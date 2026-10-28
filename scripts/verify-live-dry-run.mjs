import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const local = resolve("data/runtime-download/node-v22.23.4-win-x64/node.exe");
const executable =
  Number(process.versions.node.split(".")[0]) < 22 &&
  process.platform === "win32" &&
  existsSync(local)
    ? local
    : process.execPath;
const infra = process.argv.includes("--infrastructure");
const child = spawn(
  executable,
  [
    "--env-file=.env",
    "--import",
    "tsx",
    infra ? "scripts/verify-live.ts" : "scripts/verify-live-dry-run.ts",
    ...process.argv.slice(2).filter((a) => a !== "--infrastructure"),
  ],
  { stdio: "inherit", windowsHide: true },
);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
