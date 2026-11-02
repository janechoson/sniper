import { test } from "node:test";
import assert from "node:assert/strict";
import { startupErrorCode } from "../src/startup-error.js";
import { Blocked } from "../src/domain.js";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeConfig, ROOT } from "../src/config.js";
import { startKronos } from "../src/server.js";
import { requireMainnetGenesis } from "../src/live-config.js";

test("mainnet preflight accepts the canonical Solana mainnet hash and rejects other networks/typos",()=>{
  assert.doesNotThrow(()=>requireMainnetGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"));
  for(const hash of ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2r","devnet","testnet",""])
    assert.throws(()=>requireMainnetGenesis(hash),/RPC_NOT_SOLANA_MAINNET/);
});

test("startup reports controlled configuration, signer and filesystem/socket codes", () => {
  assert.equal(
    startupErrorCode(new Error("LIVE_CONFIGURATION_INCOMPLETE")),
    "LIVE_CONFIGURATION_INCOMPLETE",
  );
  assert.equal(
    startupErrorCode(new Blocked("SOLANA_SIGNER_WALLET_MISMATCH")),
    "SOLANA_SIGNER_WALLET_MISMATCH",
  );
  assert.equal(
    startupErrorCode(
      Object.assign(new Error("sensitive/path"), { code: "EEXIST" }),
    ),
    "EEXIST",
  );
  assert.equal(
    startupErrorCode(
      Object.assign(new Error("sensitive endpoint"), { code: "EADDRINUSE" }),
    ),
    "EADDRINUSE",
  );
});

test("startup never echoes raw error messages, stacks, URLs or embedded secrets", () => {
  for (const error of [
    new Error("URL https://rpc.invalid/?key=fixture-secret"),
    { message: "fixture-secret", stack: "fixture-secret" },
    "fixture-secret",
    null,
  ]) {
    assert.equal(
      startupErrorCode(error),
      "INVALID_CONFIGURATION_OR_STARTUP_FAILURE",
    );
  }
});

test("existing installation lock blocks startup explicitly and is never overwritten", async () => {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "data", "test-startup-"));
  const runtime = join(dir, "runtime");
  mkdirSync(runtime, { recursive: true });
  const lock = join(runtime, "kronos.lock");
  writeFileSync(lock, String(process.pid));
  const config = runtimeConfig({
    TRADING_MODE: "paper",
    KRONOS_RUNTIME: runtime,
    KRONOS_DATABASE_PATH: join(dir, "test.sqlite"),
    KRONOS_LOG_DIR: join(dir, "logs"),
    KRONOS_PORT: "48793",
  });
  await assert.rejects(startKronos(config), /KRONOS_LOCK_EXISTS_CHECK_PID/);
  assert.equal(readFileSync(lock, "utf8"), String(process.pid));
});
