// Isolated fixtures: no inherited production config, keys or real providers.
for (const k of Object.keys(process.env))
  if (/API_KEY|PRIVATE|MNEMONIC|WALLET|JUPITER|TYPESAFE|SOLANA|KRONOS_/.test(k))
    delete process.env[k];
process.env.TRADING_MODE = "paper";
const original = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(String(url)).hostname)
  )
    throw Error("FIXTURE_REAL_NETWORK_FORBIDDEN");
  return original(url, options);
};
