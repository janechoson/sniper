// Trusted local launcher. Selects read credentials, never forwards BOT .env or
// wallet/signing fields. Python receives its own stricter allowlist separately.
import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "dotenv";
const runtime = resolve(
  process.env.KRONOS_RUNTIME ??
    join(process.env.LOCALAPPDATA, "gmgn-kronos-runtime"),
);
let key = process.env.KRONOS_GMGN_API_KEY || process.env.GMGN_API_KEY || "",
  rpc = process.env.KRONOS_RPC_URL;
for (const file of [
  resolve(".env"),
  join(homedir(), ".config", "gmgn", ".env"),
]) {
  if (!existsSync(file)) continue;
  const selected = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) =>
      /^\s*(?:export\s+)?(?:GMGN_API_KEY|SOLANA_RPC_HTTP|SOLANA_RPC_URL)\s*=/.test(
        line,
      ),
    )
    .join("\n");
  const config = parse(selected);
  if (config.GMGN_API_KEY) key = config.GMGN_API_KEY;
  rpc = rpc || config.SOLANA_RPC_HTTP || config.SOLANA_RPC_URL;
}
if (!key) throw Error("NO_CONFIGURED_GMGN_READ_API_KEY");
let alreadyRunning = false;
try {
  const r = await fetch("http://127.0.0.1:8792/state", {
    signal: AbortSignal.timeout(1000),
  });
  alreadyRunning = r.ok;
} catch {
  /* Start only the isolated service. */
}
let pid;
if (!alreadyRunning) {
  mkdirSync(runtime, { recursive: true });
  const out = openSync(join(runtime, "lab-service.stdout.log"), "a"),
    err = openSync(join(runtime, "lab-service.stderr.log"), "a");
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: join(runtime, "tmp"),
    TMP: join(runtime, "tmp"),
    KRONOS_RUNTIME: runtime,
    KRONOS_GMGN_API_KEY: key,
    KRONOS_BOT_PORT: process.env.KRONOS_BOT_PORT ?? "3000",
  };
  if (rpc) environment.KRONOS_RPC_URL = rpc;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/kronos-env.mjs",
      "--import",
      "tsx",
      "./src/kronos-server.ts",
    ],
    {
      cwd: resolve("."),
      env: environment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, err],
    },
  );
  await new Promise((accept, reject) => {
    child.once("spawn", accept);
    child.once("error", reject);
  });
  pid = child.pid;
  child.unref();
  closeSync(out);
  closeSync(err);
}
let state;
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch("http://127.0.0.1:8792/state", {
      signal: AbortSignal.timeout(1000),
    });
    if (r.ok) {
      state = await r.json();
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
if (!state?.paperOnly) throw Error("PAPER_SERVICE_NOT_READY");
const response = await fetch("http://127.0.0.1:8792/control", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Origin: "http://127.0.0.1:8792",
    "X-Kronos-CSRF": state.csrf,
  },
  body: JSON.stringify({ action: "enable" }),
  signal: AbortSignal.timeout(3000),
});
if (!response.ok) throw Error("PAPER_COLLECTION_ENABLE_FAILED");
const activation = {
  activatedAt: new Date().toISOString(),
  mode: "LIVE_DATA_PAPER_ONLY",
  pid,
  alreadyRunning,
  url: "http://127.0.0.1:8792",
  productionRestarted: false,
  privateKeyForwarded: false,
};
writeFileSync(
  join(runtime, "activation.json"),
  JSON.stringify(activation, null, 2),
);
console.log(JSON.stringify(activation));
