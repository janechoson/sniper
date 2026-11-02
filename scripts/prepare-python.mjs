import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtime");
mkdirSync(join(runtime, "tmp"), { recursive: true });
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  PATH: process.env.PATH ?? process.env.Path,
  PATHEXT: process.env.PATHEXT,
  USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  TEMP: join(runtime, "tmp"),
  TMP: join(runtime, "tmp"),
  UV_PYTHON_INSTALL_DIR: join(runtime, "python"),
  UV_NO_CACHE: "1",
};
for (const args of [
  ["python", "install", "3.11.11"],
  ["venv", "--python", "3.11.11", "runtime/venv"],
  [
    "pip",
    "install",
    "--python",
    "runtime/venv/Scripts/python.exe",
    "--require-hashes",
    "--index-strategy",
    "unsafe-best-match",
    "--extra-index-url",
    "https://download.pytorch.org/whl/cpu",
    "-r",
    "lab/kronos/requirements.lock",
  ],
]) {
  const result = spawnSync("uv", args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.status !== 0) throw Error("PINNED_PYTHON_SETUP_FAILED");
}
