// Keep fixture tests independent of real credentials/balances in the user's .env.
// This preload runs only under `pnpm test`, never under dev/start/smoke:live.
import fs from "node:fs";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
// Prevent fixtures from reading production credentials at module initialization.
const credentialFiles = new Set(
  [
    resolve(".env"),
    join(homedir(), ".config", "gmgn", ".env"),
    join(homedir(), ".config", "gmgn", "keypair.pem"),
  ].map((p) => p.toLowerCase()),
);
const readFile = fs.readFileSync;
fs.readFileSync = function (path, options) {
  if (
    typeof path === "string" &&
    credentialFiles.has(resolve(path).toLowerCase())
  )
    return typeof options === "string" || options?.encoding
      ? ""
      : Buffer.alloc(0);
  return readFile.call(this, path, options);
};
syncBuiltinESMExports();
const fixtureFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const host = new URL(String(url)).hostname;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
    return Promise.reject(new Error("FIXTURE_EXTERNAL_NETWORK_FORBIDDEN"));
  return fixtureFetch(url, options);
};
Object.assign(process.env, {
  TRADING_MODE: "demo",
  LIVE_TRADING_ACK: "false",
  TEMP_BYPASS_RECOVERY_GUARD: "false",
  LIVE_SMOKE_TEST_ACK: "false",
  AI_GUARD_ENABLED: "true",
  AI_GUARD_COLD_START_POLICY: "PASS",
  AI_GUARD_TIMEOUT_MS: "8000",
  AUTO_CHART_LEARNING_ENABLED: "false",
  WALLET_PUBLIC_KEY: "",
  PAPER_INITIAL_SOL: "1",
  GMGN_API_KEY: "",
  GMGN_PRIVATE_KEY: "",
  TYPESAFE_API_KEY: "",
  SOLANA_PRIVATE_KEY: "",
  SOLANA_KEYPAIR_PATH: "",
  JUPITER_API_KEY: "",
  GMGN_PRIVATE_KEY_PATH: join(
    tmpdir(),
    "fixture-nonexistent-key-" + process.pid,
  ),
  DATABASE_PATH: join(tmpdir(), "gmgn-fixture-" + process.pid + ".sqlite"),
});
