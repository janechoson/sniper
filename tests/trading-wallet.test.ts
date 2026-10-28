import { describe, it, expect } from "vitest";
import { TradingWallet } from "@sniper/wallet";
import { chainsFromEnv, loadEnv } from "@sniper/config";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createPublicKey, verify } from "node:crypto";
import { createRequire } from "node:module";
const chains = chainsFromEnv(loadEnv({}));
describe("Danh tính ví cố định", () => {
  it("đọc khóa Solana base58 và giữ chữ ký hợp lệ sau khi xóa buffer tạm", async () => {
    const req = createRequire(
      new URL("../packages/wallet/package.json", import.meta.url),
    );
    const bs58 = req("bs58").default;
    const key = Keypair.fromSeed(new Uint8Array(32).fill(9));
    for (const secret of [
      JSON.stringify([...key.secretKey]),
      bs58.encode(key.secretKey),
    ]) {
      const manager = new TradingWallet(chains, { SOLANA_PRIVATE_KEY: secret });
      const signer = await manager.signer("trading-solana", "solana");
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: key.publicKey,
          recentBlockhash: key.publicKey.toBase58(),
          instructions: [],
        }).compileToV0Message(),
      );
      if (
        !("sign" in signer) ||
        signer.constructor.name !== "LocalSolanaSigner"
      )
        throw Error("WRONG_SIGNER");
      const signed = await (
        signer as import("../packages/wallet/src/local").LocalSolanaSigner
      ).sign(tx);
      const parsed = VersionedTransaction.deserialize(signed);
      const publicKey = createPublicKey({
        key: Buffer.concat([
          Buffer.from("302a300506032b6570032100", "hex"),
          key.publicKey.toBuffer(),
        ]),
        format: "der",
        type: "spki",
      });
      expect(
        verify(
          null,
          parsed.message.serialize(),
          publicKey,
          parsed.signatures[0]!,
        ),
      ).toBe(true);
      expect(JSON.stringify(await manager.list())).not.toContain(secret);
    }
  });
  it("WS để trống vẫn chạy HTTP; chiến lược có thể bắt buộc WS qua policy", () => {
    const env = loadEnv({
      ROBINHOOD_RPC_WS: "",
      BNB_RPC_WS: "  ",
      SOLANA_RPC_WS: "",
    });
    expect(env.ROBINHOOD_RPC_WS).toBeUndefined();
    expect(env.BNB_RPC_WS).toBeUndefined();
    expect(env.SOLANA_RPC_WS).toBeUndefined();
  });
  it("một địa chỉ EVM cho hai chain, Solana riêng; không xuất khóa", async () => {
    const key = "0x" + "11".repeat(32),
      sol = Keypair.fromSeed(new Uint8Array(32).fill(7));
    const manager = new TradingWallet(chains, {
      EVM_PRIVATE_KEY: key,
      SOLANA_PRIVATE_KEY: JSON.stringify([...sol.secretKey]),
    });
    const publicWallets = await manager.list();
    expect(publicWallets).toHaveLength(2);
    expect((await manager.signer("legacy-bnb", "bnb")).address()).toBe(
      (await manager.signer("legacy-rh", "robinhood")).address(),
    );
    expect((await manager.signer("legacy-sol", "solana")).address()).toBe(
      sol.publicKey.toBase58(),
    );
    expect(JSON.stringify(publicWallets)).not.toContain(key);
    expect(JSON.stringify(publicWallets)).not.toContain("secretRef");
  });
  it("watch-only không thể ký, khai báo địa chỉ không khớp bị từ chối", async () => {
    const address = "0x" + "22".repeat(20);
    const watch = new TradingWallet(chains, { EVM_WALLET_ADDRESS: address });
    expect((await watch.list())[0]?.address.toLowerCase()).toBe(address);
    await expect(watch.signer("trading-evm", "bnb")).rejects.toThrow();
    const mismatch = new TradingWallet(chains, {
      EVM_WALLET_ADDRESS: address,
      EVM_PRIVATE_KEY: "0x" + "11".repeat(32),
    });
    expect((await mismatch.health("trading-evm", "bnb")).status).toBe("DOWN");
  });
});
