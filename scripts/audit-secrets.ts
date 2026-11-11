import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { env, gmgnSigningKey } from "../src/config.js";
import { localWallet, base58 } from "../src/execution-provider.js";
const needles = [
  ["SOLANA_PRIVATE_KEY", env.SOLANA_PRIVATE_KEY],
  ["GMGN_API_KEY", env.GMGN_API_KEY],
  ["GMGN_AUTH_KEY", gmgnSigningKey()],
  ["JUPITER_API_KEY", env.JUPITER_API_KEY],
];
if (env.SOLANA_PRIVATE_KEY || env.SOLANA_KEYPAIR_PATH) {
  const wallet = localWallet();
  needles.push(
    ["SOLANA_KEY_BASE58", base58(wallet.secretKey)],
    ["SOLANA_KEY_JSON", JSON.stringify([...wallet.secretKey])],
  );
  wallet.secretKey.fill(0);
}
const findings: { file: string; credential: string }[] = [];
let filesScanned = 0;
function scan(path: string) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) scan(join(path, entry));
    return;
  }
  // Secrets are intentionally configured in .env or the explicitly configured keypair path.
  if (
    env.SOLANA_KEYPAIR_PATH &&
    resolve(path) === resolve(env.SOLANA_KEYPAIR_PATH)
  )
    return;
  const bytes = readFileSync(path);
  filesScanned++;
  for (const [name, value] of needles)
    if (value && value.length >= 8 && bytes.includes(Buffer.from(value)))
      findings.push({ file: path, credential: name! });
}
for (const path of [
  "src",
  "scripts",
  "tests",
  "public",
  "docs",
  "data",
  "dist",
])
  scan(path);
process.stdout.write(
  JSON.stringify({ filesScanned, findings, secretValuesPrinted: false }) + "\n",
);
if (findings.length) process.exitCode = 2;
