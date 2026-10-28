import { describe, it, expect } from "vitest";
import { z } from "zod";
import { JsonRpcClient } from "@sniper/chains";
const enabled = process.env.RUN_LIVE_TESTS === "true";
const networks = [
  { id: "solana", url: process.env.SOLANA_RPC_HTTP, chainId: undefined },
  { id: "bnb", url: process.env.BNB_RPC_HTTP, chainId: 56 },
  { id: "robinhood", url: process.env.ROBINHOOD_RPC_HTTP, chainId: 4663 },
];
// Cờ opt-in chỉ bật kiểm tra mạng đọc; file này không có signer hoặc send RPC.
describe.skipIf(!enabled)(
  "RPC thật tùy chọn, chỉ đọc và không tiêu tài sản",
  () => {
    it("được cấu hình ít nhất một RPC khi chủ động bật kiểm tra mạng", () => {
      expect(networks.some((n) => n.url)).toBe(true);
    });
    for (const network of networks)
      it.skipIf(!network.url)(
        `xác minh danh tính ${network.id}`,
        async () => {
          const rpc = new JsonRpcClient(`verify-${network.id}`, network.url!, {
            timeoutMs: 3000,
            rps: 2,
            concurrency: 1,
          });
          try {
            if (network.id === "solana") {
              expect(process.env.SOLANA_EXPECTED_GENESIS_HASH).toBeTruthy();
              const genesis = await rpc.request(
                "getGenesisHash",
                [],
                z.string(),
              );
              expect(genesis === process.env.SOLANA_EXPECTED_GENESIS_HASH).toBe(
                true,
              );
              expect(
                await rpc.request(
                  "getSlot",
                  [{ commitment: "confirmed" }],
                  z.number().int().positive(),
                ),
              ).toBeGreaterThan(0);
            } else {
              const identity = await rpc.request(
                "eth_chainId",
                [],
                z.string().regex(/^0x[\da-fA-F]+$/),
              );
              expect(BigInt(identity) === BigInt(network.chainId!)).toBe(true);
            }
          } finally {
            rpc.close();
          }
        },
        20000,
      );
  },
);
