import { it, expect } from "vitest";
import { encodeAbiParameters, keccak256, toHex } from "viem";
import { JsonRpcClient } from "@sniper/chains";
import { EvmRoundTripSimulator } from "@sniper/execution";
import {
  atomicQuoteSchema,
  type SwapProvider,
  type RoundTripResult,
} from "@sniper/core";
const wallet = "0x5555555555555555555555555555555555555555",
  router = "0x3333333333333333333333333333333333333333",
  token = "0x2222222222222222222222222222222222222222",
  native = "0x0000000000000000000000000000000000000000";
it.each(["success", "sell-revert", "unavailable"])(
  "round-trip native %s giữ bằng chứng stateful, không sửa số dư",
  async (mode) => {
    const now = Date.now();
    const q = atomicQuoteSchema.parse({
      id: "b",
      providerId: "fixture",
      chainId: "bnb",
      tokenIn: native,
      tokenOut: token,
      amountIn: "10000000000000000",
      expectedAmountOut: "20000",
      minimumAmountOut: "19800",
      decimalsIn: 18,
      decimalsOut: 18,
      priceImpactPct: 0.1,
      quotedAt: now,
      expiresAt: now + 10000,
      source: "RPC",
      quality: "REAL",
      nativeInput: true,
    });
    const sell = atomicQuoteSchema.parse({
      ...q,
      id: "s",
      tokenIn: token,
      tokenOut: native,
      amountIn: "19800",
      expectedAmountOut: "9900000000000000",
      minimumAmountOut: "9801000000000000",
      nativeInput: false,
      nativeOutput: true,
    });
    const trip: RoundTripResult = {
      buy: q,
      sell,
      sellability: "UNKNOWN",
      evidence: "QUOTE_ONLY",
      reasons: [],
    };
    const p: SwapProvider = {
      id: "fixture",
      chainId: "bnb",
      supports: () => true,
      getQuote: async () => q,
      healthCheck: async () => ({
        id: "fixture",
        status: "READY",
        reasons: [],
        checkedAt: now,
      }),
      buildSwap: async (quote) => ({
        family: "evm",
        chainId: "bnb",
        evmChainId: 56,
        walletAddress: wallet,
        quoteId: quote.id,
        providerId: "fixture",
        to: router,
        data: quote.id === "b" ? "0xaaaa" : "0xbbbb",
        value: quote.id === "b" ? quote.amountIn : "0",
        validUntil: quote.expiresAt,
      }),
    };
    let broadcasts = 0;
    const rpc = new JsonRpcClient("trip-test", "http://fixture.invalid", {
      rps: 100,
      readOnly: true,
      fetcher: async (_, init) => {
        const req = JSON.parse(String(init?.body));
        let result: unknown;
        if (req.method === "eth_chainId") result = "0x38";
        else if (req.method === "eth_gasPrice") result = "0x1";
        else if (req.method === "eth_getBlockByNumber")
          result = {
            number: "0x1",
            timestamp: toHex(BigInt(Math.floor(now / 1000))),
          };
        else if (req.method === "eth_simulateV1") {
          if (mode === "unavailable") throw Error("RPC_UNAVAILABLE");
          const block = req.params[0].blockStateCalls[0];
          expect(block.stateOverrides).toBeUndefined();
          expect(Number(BigInt(block.blockOverrides.time))).toBeLessThanOrEqual(
            Math.floor(Date.now() / 1000) + 2,
          );
          expect(req.params[0].validation).toBe(true);
          expect(req.params[0].traceTransfers).toBe(true);
          let balance = 0n;
          const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
          result = [
            {
              calls: block.calls.map((c: { data: string; value: string }) => {
                const row = {
                  status: "0x1",
                  returnData: "0x",
                  gasUsed: "0x5208",
                  logs: [] as unknown[],
                  error: undefined as unknown,
                };
                if (c.data === "0xaaaa") {
                  expect(BigInt(c.value)).toBe(BigInt(q.amountIn));
                  balance = 20000n;
                  row.logs = [
                    {
                      address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                      topics: [
                        keccak256(toHex("Transfer(address,address,uint256)")),
                        topic(wallet),
                        topic(router),
                      ],
                      data: toHex(BigInt(q.amountIn)),
                    },
                  ];
                } else if (c.data === "0xbbbb") {
                  if (mode === "sell-revert") {
                    row.status = "0x0";
                    row.error = { code: 3 };
                  } else {
                    balance -= 19800n;
                    row.logs = [
                      {
                        address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                        topics: [
                          keccak256(toHex("Transfer(address,address,uint256)")),
                          topic(router),
                          topic(wallet),
                        ],
                        data: toHex(BigInt(sell.expectedAmountOut)),
                      },
                    ];
                  }
                } else
                  row.returnData = encodeAbiParameters(
                    [{ type: "uint256" }],
                    [c.data.startsWith("0x095ea7b3") ? 1n : balance],
                  );
                return row;
              }),
            },
          ];
        } else {
          broadcasts++;
          throw Error("UNEXPECTED_RPC");
        }
        return Response.json({ jsonrpc: "2.0", id: req.id, result });
      },
    });
    try {
      const result = await new EvmRoundTripSimulator(rpc, 56).simulate(
        trip,
        wallet,
        p,
        p,
        { nativeUsd: "100", quoteUsd: "100" },
      );
      expect(result.sellability).toBe(
        mode === "success"
          ? "SELLABLE"
          : mode === "sell-revert"
            ? "NOT_SELLABLE"
            : "UNKNOWN",
      );
      expect(broadcasts).toBe(0);
    } finally {
      rpc.close();
    }
  },
);
