import { PublicKey } from "@solana/web3.js";
export const SOL = "So11111111111111111111111111111111111111112";
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export function requireMainnetGenesis(hash: string) {
  if (hash !== MAINNET_GENESIS_HASH) throw Error("RPC_NOT_SOLANA_MAINNET");
}
export const LIVE_SIZING_POLICY = Object.freeze({
  positionSizePercent: 1,
  editable: false,
  basis: "SPENDABLE_SOL_AFTER_RESERVE",
  baseReserveLamports: "20000000",
  reservePerOpenLamports: "5000000",
});
export interface LiveConfig {
  WALLET_PUBLIC_KEY: string;
  SOLANA_PRIVATE_KEY: string;
  SOLANA_KEYPAIR_PATH: string;
  JUPITER_API_KEY: string; // Optional: empty uses the provider's existing keyless request path.
  reserveLamports: string;
  slippageBps: number;
  maxImpactPct: number;
  acknowledged: boolean;
}
export function liveConfig(e: NodeJS.ProcessEnv): LiveConfig {
  return {
    WALLET_PUBLIC_KEY: e.KRONOS_WALLET_PUBLIC_KEY ?? "",
    SOLANA_PRIVATE_KEY: e.KRONOS_PRIVATE_KEY ?? "",
    SOLANA_KEYPAIR_PATH: e.KRONOS_KEYPAIR_PATH ?? "",
    JUPITER_API_KEY: e.KRONOS_JUPITER_API_KEY ?? "",
    reserveLamports: LIVE_SIZING_POLICY.baseReserveLamports,
    slippageBps: 100,
    maxImpactPct: 15,
    acknowledged: e.KRONOS_LIVE_ACK === "I_ACCEPT_REAL_TRADING",
  };
}
export function requireLiveConfiguration(
  c: LiveConfig,
  gmgn: string,
  rpc: string,
) {
  if (
    !c.acknowledged ||
    !gmgn ||
    !rpc ||
    !c.WALLET_PUBLIC_KEY ||
    !(c.SOLANA_PRIVATE_KEY || c.SOLANA_KEYPAIR_PATH)
  )
    throw Error("LIVE_CONFIGURATION_INCOMPLETE");
  new PublicKey(c.WALLET_PUBLIC_KEY);
  if (!/^https:\/\//.test(rpc)) throw Error("LIVE_RPC_HTTPS_REQUIRED");
}
export function sizeBuy(balance: bigint, reserve: bigint) {
  const spendable = balance > reserve ? balance - reserve : 0n;
  return (spendable * BigInt(LIVE_SIZING_POLICY.positionSizePercent)) / 100n;
}
