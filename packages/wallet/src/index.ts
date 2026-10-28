import { DomainError } from "@sniper/core";
export * from "./secrets";
export * from "./local";
// Không chuyển kiểu dữ liệu khóa hoặc khóa bí mật sang AI hay trình duyệt.
export interface EvmSigner {
  readonly kind: "evm";
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}
export interface SolanaSigner {
  readonly kind: "solana";
  signTransaction(transaction: Uint8Array): Promise<Uint8Array>;
}
export interface WalletManager {
  signer(chainId: string): Promise<EvmSigner | SolanaSigner>;
}
export class DisabledWalletManager implements WalletManager {
  async signer(_chainId: string): Promise<never> {
    throw new DomainError(
      "CONFIGURATION_ERROR",
      "Chế độ mô phỏng không cần ví; chưa triển khai cơ chế ký giao dịch thật an toàn",
    );
  }
}
export * from "./balances";
export * from "./factory";
export * from "./trading-wallet";
