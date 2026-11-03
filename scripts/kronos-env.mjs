// Must be preloaded before reusable production parsers import config.ts.
// Does not read .env or any GMGN signing material.
import fs from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
const forbidden = new Set(
  [
    resolve(".env"),
    join(homedir(), ".config", "gmgn", ".env"),
    join(homedir(), ".config", "gmgn", "keypair.pem"),
  ].map((x) => x.toLowerCase()),
);
const read = fs.readFileSync;
fs.readFileSync = function (p, o) {
  if (typeof p === "string" && forbidden.has(resolve(p).toLowerCase()))
    return typeof o === "string" || o?.encoding ? "" : Buffer.alloc(0);
  return read.call(this, p, o);
};
syncBuiltinESMExports();
for (const key of Object.keys(process.env))
  if (
    ![
      "SystemRoot",
      "WINDIR",
      "PATH",
      "Path",
      "PATHEXT",
      "TEMP",
      "TMP",
      "LOCALAPPDATA",
      "USERPROFILE",
      "HOME",
      "KRONOS_GMGN_API_KEY",
      "KRONOS_RPC_URL",
      "KRONOS_BOT_PORT",
      "KRONOS_RUNTIME",
    ].includes(key)
  )
    delete process.env[key];
process.env.TRADING_MODE = "paper";
process.env.LIVE_TRADING_ACK = "false";
process.env.KRONOS_SAFE_PRELOAD = "1";
process.env.GMGN_PRIVATE_KEY_PATH = resolve("lab/kronos/NO_SIGNER_KEY");
process.env.DATABASE_PATH = resolve("lab/kronos/NEVER_OPEN_PRODUCTION.sqlite");
