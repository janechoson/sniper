import { readFileSync, writeFileSync } from "node:fs";
const root = JSON.parse(readFileSync("package.json", "utf8"));
const map = {
  core: ["zod"],
  config: ["@sniper/core", "zod"],
  shared: ["pino"],
  chains: [
    "@sniper/core",
    "@sniper/shared",
    "@sniper/config",
    "@sniper/features",
    "@sniper/storage",
    "zod",
    "viem",
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
    "ws",
  ],
  dex: [
    "@sniper/core",
    "@sniper/chains",
    "@sniper/shared",
    "@sniper/config",
    "zod",
    "viem",
    "@solana/web3.js",
  ],
  features: ["@sniper/core", "@sniper/shared", "@sniper/storage", "zod"],
  ai: ["@sniper/core", "@sniper/shared", "@typesafe-ai/sdk", "zod"],
  strategies: ["@sniper/core", "zod"],
  risk: ["@sniper/core", "@sniper/config"],
  routing: ["@sniper/core", "@sniper/shared", "zod"],
  execution: [
    "@sniper/core",
    "@sniper/chains",
    "@sniper/wallet",
    "@sniper/shared",
    "@sniper/storage",
    "viem",
    "@solana/web3.js",
    "@solana/spl-token",
    "@coral-xyz/anchor",
    "zod",
  ],
  positions: ["@sniper/core", "@sniper/config", "@sniper/storage", "zod"],
  wallet: [
    "@sniper/core",
    "@sniper/chains",
    "@sniper/shared",
    "viem",
    "@solana/web3.js",
    "zod",
  ],
  storage: ["@sniper/core", "@sniper/shared", "@prisma/client", "zod"],
  engine: [
    "@sniper/core",
    "@sniper/config",
    "@sniper/ai",
    "@sniper/chains",
    "@sniper/features",
    "@sniper/dex",
    "@sniper/execution",
    "@sniper/routing",
    "@sniper/positions",
    "@sniper/wallet",
    "@sniper/risk",
    "@sniper/strategies",
    "@sniper/storage",
    "@sniper/shared",
    "zod",
  ],
};
const set = (path, deps) => {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.dependencies = Object.fromEntries(
    deps.map((d) => [d, root.dependencies[d]]),
  );
  if (pkg.name === "@sniper/chains")
    pkg.exports = {
      ".": "./src/index.ts",
      "./discovery": "./src/discovery.ts",
    };
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
};
for (const [name, deps] of Object.entries(map))
  set(`packages/${name}/package.json`, deps);
set("apps/web/package.json", [
  "next",
  "react",
  "react-dom",
  "@sniper/core",
  "@sniper/config",
  "zod",
]);
set("apps/bot/package.json", [
  "@sniper/core",
  "@sniper/config",
  "@sniper/shared",
  "@sniper/storage",
  "@sniper/engine",
  "@sniper/wallet",
  "zod",
]);
for (const path of [
  "packages/engine/src/index.ts",
  ...[
    "features",
    "strategy-risk",
    "execution",
    "engine",
    "outcomes-storage",
    "boundaries",
  ].map((name) => `tests/${name}.test.ts`),
]) {
  let code = readFileSync(path, "utf8");
  code = code
    .replaceAll('"../../chains/src/discovery"', '"@sniper/chains/discovery"')
    .replaceAll(
      '"../packages/chains/src/discovery"',
      '"@sniper/chains/discovery"',
    );
  writeFileSync(path, code);
}
