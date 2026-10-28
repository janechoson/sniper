import { readFile } from "node:fs/promises";
import { z } from "zod";
import { getAddress, type Address, type TransactionSerializable } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type {
  PublicWallet,
  WalletDefinition,
  WalletBalance,
} from "@sniper/core";
import type { SecretProvider } from "./secrets";
const definition = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    label: z.string().min(1).max(80),
    family: z.enum(["evm", "solana"]),
    chains: z.array(z.string().min(1)).min(1),
    enabled: z.boolean(),
    address: z.string().optional(),
    signerType: z.enum(["local-env", "local-file", "watch-only"]),
    secretRef: z.string().optional(),
  })
  .strict()
  .superRefine((wallet, ctx) => {
    if (wallet.signerType === "watch-only" && !wallet.address)
      ctx.addIssue({
        code: "custom",
        message: "Ví chỉ xem cần địa chỉ công khai",
      });
    if (wallet.signerType !== "watch-only" && !wallet.secretRef)
      ctx.addIssue({ code: "custom", message: "Ví ký cần tham chiếu bí mật" });
    if (
      wallet.signerType === "local-env" &&
      !wallet.secretRef?.startsWith("env:")
    )
      ctx.addIssue({
        code: "custom",
        message: "Tham chiếu môi trường không khớp",
      });
    if (
      wallet.signerType === "local-file" &&
      !wallet.secretRef?.startsWith("file:")
    )
      ctx.addIssue({ code: "custom", message: "Tham chiếu file không khớp" });
  });
export const walletsConfigSchema = z
  .object({ version: z.literal(1), wallets: z.array(definition).max(100) })
  .strict()
  .refine(
    (config) =>
      new Set(config.wallets.map((w) => w.id)).size === config.wallets.length,
    "Mã ví bị trùng",
  );
export async function loadWalletDefinitions(
  path?: string,
): Promise<WalletDefinition[]> {
  if (!path) return [];
  const content = await readFile(path, "utf8");
  if (content.length > 200000) throw new Error("WALLET_CONFIG_TOO_LARGE");
  return walletsConfigSchema.parse(JSON.parse(content)).wallets;
}
function text(secret: string | Uint8Array) {
  return typeof secret === "string" ? secret : new TextDecoder().decode(secret);
}
export class LocalEvmSigner {
  #account: PrivateKeyAccount;
  constructor(secret: string | Uint8Array) {
    const value = text(secret).trim();
    if (!/^0x[\da-fA-F]{64}$/.test(value))
      throw new Error("EVM_SIGNER_SECRET_INVALID");
    try {
      this.#account = privateKeyToAccount(value as `0x${string}`);
    } catch {
      throw new Error("EVM_SIGNER_SECRET_INVALID");
    }
  }
  address(): Address {
    return this.#account.address;
  }
  async sign(transaction: TransactionSerializable): Promise<`0x${string}`> {
    return this.#account.signTransaction(transaction);
  }
}
export class LocalSolanaSigner {
  #keypair: Keypair;
  constructor(secret: string | Uint8Array) {
    let bytes: Uint8Array | undefined;
    try {
      const encoded = text(secret).trim();
      const value =
        secret instanceof Uint8Array && secret.length === 64
          ? Array.from(secret)
          : encoded.startsWith("[")
            ? JSON.parse(encoded)
            : encoded.length <= 128
              ? Array.from(bs58.decode(encoded))
              : [];
      bytes = Uint8Array.from(
        z.array(z.number().int().min(0).max(255)).length(64).parse(value),
      );
      // web3.js giữ tham chiếu secretKey; chỉ xóa buffer tạm, không xóa khóa signer.
      this.#keypair = Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      throw new Error("SOLANA_SIGNER_SECRET_INVALID");
    } finally {
      bytes?.fill(0);
    }
  }
  address(): string {
    return this.#keypair.publicKey.toBase58();
  }
  sign(transaction: VersionedTransaction): Uint8Array {
    if (
      transaction.message.staticAccountKeys[0]?.toBase58() !== this.address() ||
      transaction.message.header.numRequiredSignatures !== 1
    )
      throw new Error("SOLANA_SIGNER_AUTHORITY_MISMATCH");
    transaction.sign([this.#keypair]);
    return transaction.serialize();
  }
}
export class LocalWalletManager {
  #definitions: Map<string, WalletDefinition>;
  #secrets: SecretProvider;
  constructor(definitions: WalletDefinition[], secrets: SecretProvider) {
    this.#definitions = new Map(
      definitions.map((item) => [item.id, structuredClone(item)]),
    );
    this.#secrets = secrets;
    if (this.#definitions.size !== definitions.length)
      throw new Error("WALLET_ID_DUPLICATE");
  }
  private definition(id: string, chainId?: string) {
    const wallet = this.#definitions.get(id);
    if (
      !wallet ||
      !wallet.enabled ||
      (chainId && !wallet.chains.includes(chainId))
    )
      throw new Error("WALLET_UNAVAILABLE");
    return wallet;
  }
  async signer(
    id: string,
    chainId: string,
  ): Promise<LocalEvmSigner | LocalSolanaSigner> {
    const wallet = this.definition(id, chainId);
    if (!wallet.secretRef || wallet.signerType === "watch-only")
      throw new Error("SIGNER_UNAVAILABLE");
    const secret = await this.#secrets.getSecret(wallet.secretRef);
    try {
      const signer =
        wallet.family === "evm"
          ? new LocalEvmSigner(secret)
          : new LocalSolanaSigner(secret);
      if (wallet.address) {
        const expected =
          wallet.family === "evm"
            ? getAddress(wallet.address)
            : new PublicKey(wallet.address).toBase58();
        if (signer.address() !== expected)
          throw new Error("WALLET_ADDRESS_MISMATCH");
      }
      return signer;
    } finally {
      if (secret instanceof Uint8Array) secret.fill(0);
    }
  }
  async publicWallet(id: string): Promise<PublicWallet> {
    const wallet = this.definition(id);
    let address = wallet.address;
    if (wallet.signerType !== "watch-only") {
      const signer = await this.signer(id, wallet.chains[0]!);
      address = signer.address();
    }
    if (!address) throw new Error("WALLET_ADDRESS_UNAVAILABLE");
    return {
      id: wallet.id,
      label: wallet.label,
      address,
      family: wallet.family,
      chains: [...wallet.chains],
      enabled: wallet.enabled,
      signerType: wallet.signerType,
    };
  }
  async list(): Promise<PublicWallet[]> {
    const result: PublicWallet[] = [];
    for (const wallet of this.#definitions.values()) {
      if (!wallet.enabled) continue;
      try {
        result.push(await this.publicWallet(wallet.id));
      } catch {
        if (wallet.address)
          result.push({
            id: wallet.id,
            label: wallet.label,
            address: wallet.address,
            family: wallet.family,
            chains: [...wallet.chains],
            enabled: wallet.enabled,
            signerType: wallet.signerType,
          });
      }
    }
    return result;
  }
  async health(id: string, chainId: string) {
    try {
      const wallet = await this.publicWallet(id);
      this.definition(id, chainId);
      const signer =
        wallet.signerType === "watch-only"
          ? false
          : !!(await this.signer(id, chainId));
      return {
        walletId: id,
        status: signer ? ("READY" as const) : ("DEGRADED" as const),
        reasons: signer ? [] : ["WATCH_ONLY"],
        checkedAt: Date.now(),
      };
    } catch {
      return {
        walletId: id,
        status: "DOWN" as const,
        reasons: ["WALLET_OR_SIGNER_UNAVAILABLE"],
        checkedAt: Date.now(),
      };
    }
  }
}
export interface WalletBalanceReader {
  read(
    wallet: PublicWallet,
    chainId: string,
    tokens?: { address: string; decimals: number }[],
  ): Promise<WalletBalance>;
}
