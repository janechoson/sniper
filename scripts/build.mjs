import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
execFileSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("typescript/bin/tsc"),
    "-p",
    "tsconfig.build.json",
  ],
  { stdio: "inherit", windowsHide: true },
);
mkdirSync("dist", { recursive: true });
writeFileSync(
  "dist/identity.json",
  JSON.stringify({
    name: "K1ll of BOT — Kronos",
    defaultMode: "paper",
    supportedModes: ["paper", "live"],
    autoActivateLive: false,
    builtAt: new Date().toISOString(),
  }),
);
