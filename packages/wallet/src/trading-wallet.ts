import { getAddress } from "viem";
import { PublicKey } from "@solana/web3.js";
import type {
  ChainConfig,
  WalletDefinition,
  DashboardSnapshot,
} from "@sniper/core";
import { LocalWalletManager } from "./local";
import { EnvironmentSecretProvider } from "./secrets";
export class TradingWallet extends LocalWalletManager {
  private readonly families: Map<string, "evm" | "solana">;
  private readonly configured: Set<string>;
  constructor(
    chains: ChainConfig[],
    environment: Record<string, string | undefined> = process.env,
  ) {
    const definitions: WalletDefinition[] = [];
    for (const family of ["evm", "solana"] as const) {
      const ids = chains.filter((c) => c.type === family).map((c) => c.id),
        key = family === "evm" ? "EVM_PRIVATE_KEY" : "SOLANA_PRIVATE_KEY",
        addressKey =
          family === "evm" ? "EVM_WALLET_ADDRESS" : "SOLANA_WALLET_ADDRESS";
      const secret = environment[key]?.trim(),
        publicAddress = environment[addressKey]?.trim();
      if (!ids.length || (!secret && !publicAddress)) continue;
      const address = publicAddress
        ? family === "evm"
          ? getAddress(publicAddress)
          : new PublicKey(publicAddress).toBase58()
        : undefined;
      definitions.push({
        id: `trading-${family}`,
        label: "Danh tính giao dịch cố định",
        family,
        chains: ids,
        enabled: true,
        address,
        signerType: secret ? "local-env" : "watch-only",
        secretRef: secret ? `env:${key}` : undefined,
      });
    }
    super(
      definitions,
      new EnvironmentSecretProvider(
        ["EVM_PRIVATE_KEY", "SOLANA_PRIVATE_KEY"],
        environment,
      ),
    );
    this.families = new Map(chains.map((c) => [c.id, c.type]));
    this.configured = new Set(definitions.map((d) => d.family));
  }
  async publicStatus(): Promise<
    NonNullable<DashboardSnapshot["tradingWallet"]>
  > {
    const status = async (family: "evm" | "solana") => {
      if (!this.configured.has(family))
        return { signerStatus: "NOT_CONFIGURED" as const };
      try {
        const wallet = await this.publicWallet(`trading-${family}`);
        return {
          address: wallet.address,
          signerStatus:
            wallet.signerType === "watch-only"
              ? ("WATCH_ONLY" as const)
              : ("READY" as const),
        };
      } catch {
        return { signerStatus: "UNAVAILABLE" as const };
      }
    };
    return { evm: await status("evm"), solana: await status("solana") };
  }
  private fixedId(chainId: string) {
    const family = this.families.get(chainId);
    if (!family) throw new Error("WALLET_CHAIN_UNSUPPORTED");
    return `trading-${family}`;
  }
  override signer(_id: string, chainId: string) {
    return super.signer(this.fixedId(chainId), chainId);
  }
  override health(_id: string, chainId: string) {
    return super.health(this.fixedId(chainId), chainId);
  }
}
