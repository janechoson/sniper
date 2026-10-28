import { createPublicClient, http, isAddress } from "viem";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DomainError,
  type ChainAdapter,
  type ChainConfig,
  type HealthStatus,
  type TokenDiscoveryEvent,
  type Unsubscribe,
  type SecurityAnalysis,
} from "@sniper/core";
import { retry, withTimeout } from "@sniper/shared";
export * from "./rpc";
export * from "./security/solana";
export * from "./security/evm";
export * from "./security/holders";
export * from "./real/evm-discovery";
export * from "./real/evm-launch-discovery";
export * from "./real/evm-discovery-reader";
export * from "./real/evm-source-decoder";
export * from "./real/evm-source-abis";
export * from "./real/evm-abi-verification";
export * from "./real/solana-discovery";
export * from "./real/pump-discovery";
export * from "./real/pump-market";
export * from "./real/solana-transaction";
export * from "./real/market";
export * from "./real/cursors";
export * from "./real/adapter";
export * from "./real/prices";

abstract class ReadOnlyFoundation implements ChainAdapter {
  abstract readonly type: "evm" | "solana";
  readonly chainId: string;
  constructor(protected readonly config: ChainConfig) {
    this.chainId = config.id;
  }
  async connect() {
    const h = await this.healthCheck();
    if (h.status !== "healthy") throw new DomainError("RPC_ERROR", h.detail);
  }
  async disconnect() {}
  abstract healthCheck(): Promise<HealthStatus>;
  async watchNewTokens(
    _callback: (event: TokenDiscoveryEvent) => Promise<void>,
  ): Promise<Unsubscribe> {
    throw new DomainError(
      "CONFIGURATION_ERROR",
      "Phát hiện token cần nguồn sự kiện DEX đã cấu hình; kiểm tra RPC không đồng nghĩa với phát hiện token",
    );
  }
  async getTokenInfo(address: string) {
    return { address };
  }
  async getLiquidity(_address: string) {
    return {};
  }
  async getHolders(_address: string) {
    return {};
  }
  abstract analyzeSecurity(address: string): Promise<SecurityAnalysis>;
}
export class EvmChainAdapter extends ReadOnlyFoundation {
  readonly type = "evm" as const;
  private client() {
    if (!this.config.rpcHttpUrl)
      throw new DomainError("CONFIGURATION_ERROR", "Thiếu URL RPC");
    return createPublicClient({
      transport: http(this.config.rpcHttpUrl, { timeout: 5000, retryCount: 2 }),
    });
  }
  async healthCheck(): Promise<HealthStatus> {
    if (!this.config.rpcHttpUrl || !this.config.evmChainId)
      return {
        status: "unconfigured",
        detail: "Cần URL RPC và mã chuỗi EVM đã xác minh",
        checkedAt: Date.now(),
      };
    try {
      const id = await retry(() => this.client().getChainId());
      return {
        status: id === this.config.evmChainId ? "healthy" : "unhealthy",
        detail:
          id === this.config.evmChainId
            ? "Đã kết nối RPC chỉ đọc"
            : "Mã chuỗi không khớp",
        checkedAt: Date.now(),
      };
    } catch {
      return {
        status: "unhealthy",
        detail: "RPC không khả dụng",
        checkedAt: Date.now(),
      };
    }
  }
  async analyzeSecurity(address: string): Promise<SecurityAnalysis> {
    if (!isAddress(address))
      return { validToken: false, evidence: ["Địa chỉ EVM không hợp lệ"] };
    const code = await this.client().getCode({ address });
    const present = code !== undefined && code !== "0x";
    return {
      bytecodePresent: present,
      ...(!present ? { validToken: false } : {}),
      evidence: [
        "Chỉ xác nhận sự tồn tại của mã byte; quyền sở hữu, proxy, phí và khả năng bán vẫn chưa rõ",
      ],
    };
  }
}
export class SolanaChainAdapter extends ReadOnlyFoundation {
  readonly type = "solana" as const;
  private connection() {
    if (!this.config.rpcHttpUrl)
      throw new DomainError("CONFIGURATION_ERROR", "Thiếu URL RPC");
    return new Connection(this.config.rpcHttpUrl, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    });
  }
  async healthCheck(): Promise<HealthStatus> {
    if (!this.config.rpcHttpUrl)
      return {
        status: "unconfigured",
        detail: "Cần URL RPC",
        checkedAt: Date.now(),
      };
    try {
      await retry(() => withTimeout(this.connection().getSlot(), 5000));
      return {
        status: "healthy",
        detail: "Đã đọc số slot; người vận hành cần xác minh danh tính mạng",
        checkedAt: Date.now(),
      };
    } catch {
      return {
        status: "unhealthy",
        detail: "RPC không khả dụng",
        checkedAt: Date.now(),
      };
    }
  }
  async analyzeSecurity(address: string): Promise<SecurityAnalysis> {
    let key: PublicKey;
    try {
      key = new PublicKey(address);
    } catch {
      return { validToken: false, evidence: ["Khóa công khai không hợp lệ"] };
    }
    const account = await withTimeout(
      this.connection().getAccountInfo(key),
      5000,
    );
    return {
      ...(account === null ? { validToken: false } : {}),
      evidence: [
        "Chỉ xác nhận tài khoản tồn tại; cần bộ phân tích chương trình token đã xác minh để giải mã mint, quyền hạn, phần mở rộng và quan hệ tài khoản",
      ],
    };
  }
}
export class MockChainAdapter implements ChainAdapter {
  readonly chainId: string;
  readonly type: "evm" | "solana";
  constructor(config: ChainConfig) {
    this.chainId = config.id;
    this.type = config.type;
  }
  async connect() {}
  async disconnect() {}
  async healthCheck(): Promise<HealthStatus> {
    return {
      status: "healthy",
      detail: "Nguồn dữ liệu giả lập · chưa kết nối blockchain",
      checkedAt: Date.now(),
    };
  }
  async watchNewTokens(
    _callback: (event: TokenDiscoveryEvent) => Promise<void>,
  ): Promise<Unsubscribe> {
    return async () => {};
  }
  async getTokenInfo(address: string) {
    return { address };
  }
  async getLiquidity(_address: string) {
    return {};
  }
  async getHolders(_address: string) {
    return {};
  }
  async analyzeSecurity(_address: string): Promise<SecurityAnalysis> {
    return {
      evidence: ["Bộ kết nối giả lập tổng quát không đưa ra kết luận an toàn"],
    };
  }
}
export * from "./security/rug-provider";
export * from "./security/solana-liquidity";
