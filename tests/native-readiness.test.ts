import { describe, it, expect } from "vitest";
import {
  parseAbi,
  encodeFunctionResult,
  decodeFunctionData,
  type Address,
} from "viem";
import { z } from "zod";
import { JsonRpcClient, RecoveringRpcSocket } from "@sniper/chains";
import { EvmRouterSwapProvider } from "@sniper/dex";
import { validateEvmSwap } from "@sniper/execution";
import { trustedQuoteSchema, productionPriceAllowed } from "@sniper/config";
import type { ApprovedTradeIntent } from "@sniper/core";
import { resolveCoinbase } from "../packages/chains/src/real/coinbase";
import {
  tracedNativeDelta,
  callTraceNativeDelta,
  transferTopic,
} from "../packages/execution/src/native-transfers";
import { solanaNativeReceiptDelta } from "../packages/execution/src/solana-native";
import { deriveReadiness } from "../packages/execution/src/readiness";
const address = (n: string) => `0x${n.repeat(40)}` as Address;
const native = address("0"),
  wrapped = address("1"),
  token = address("2"),
  router = address("3"),
  factory = address("4"),
  wallet = address("5");
const abi = parseAbi([
  "function factory() view returns(address)",
  "function WETH() view returns(address)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])",
  "function swapExactTokensForETH(uint256,uint256,address[],address,uint256) returns(uint256[])",
]);
function fixture(chain = "bnb") {
  let writes = 0;
  const rpc = new JsonRpcClient("native-test", "http://fixture.invalid", {
    rps: 100,
    readOnly: true,
    fetcher: async (_, init) => {
      const q = JSON.parse(String(init?.body));
      let result: unknown;
      if (q.method === "eth_chainId")
        result = chain === "bnb" ? "0x38" : "0x1237";
      else if (q.method === "eth_getCode") result = "0x6000";
      else if (q.method === "eth_call") {
        const d = decodeFunctionData({ abi, data: q.params[0].data });
        result =
          d.functionName === "factory"
            ? encodeFunctionResult({
                abi,
                functionName: "factory",
                result: factory,
              })
            : d.functionName === "WETH"
              ? encodeFunctionResult({
                  abi,
                  functionName: "WETH",
                  result: wrapped,
                })
              : encodeFunctionResult({
                  abi,
                  functionName: "getAmountsOut",
                  result: [
                    BigInt(d.args![0] as bigint),
                    BigInt(d.args![0] as bigint) * 2n,
                  ],
                });
      } else {
        writes++;
        throw Error("UNEXPECTED_RPC_METHOD");
      }
      return Response.json({ jsonrpc: "2.0", id: q.id, result });
    },
  });
  const provider = new EvmRouterSwapProvider(rpc, {
    id: "native-v2",
    chainId: chain,
    evmChainId: chain === "bnb" ? 56 : 4663,
    family: "v2",
    router,
    factory,
    wrappedNative: wrapped,
  });
  return { rpc, provider, writes: () => writes };
}
describe("Đường native và readiness", () => {
  it.each([
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "sendTransaction",
    "sendBundle",
    "eth_sign",
    "wallet_sendCalls",
    "personal_sendTransaction",
  ])("dry-run RPC chặn %s trước transport", async (method) => {
    let calls = 0;
    const rpc = new JsonRpcClient("no-send", "http://fixture.invalid", {
      readOnly: true,
      fetcher: async () => {
        calls++;
        return Response.json({});
      },
    });
    await expect(rpc.request(method, [], z.unknown())).rejects.toThrow(
      "DRY_RUN_RPC_METHOD_FORBIDDEN",
    );
    expect(calls).toBe(0);
    rpc.close();
  });
  it.each(["bnb", "robinhood"])(
    "%s: native BUY payable không approval, SELL unwrap đúng calldata",
    async (chain) => {
      const f = fixture(chain);
      try {
        const buy = await f.provider.getQuote({
          chainId: chain,
          tokenIn: native,
          tokenOut: token,
          amountIn: "100000",
          decimalsIn: 18,
          decimalsOut: 18,
          slippageBps: 100,
        });
        const b = await f.provider.buildSwap(buy, wallet);
        expect(b.family).toBe("evm");
        if (b.family !== "evm") throw Error();
        expect(b.value).toBe("100000");
        expect(b.approval).toBeUndefined();
        const call = decodeFunctionData({ abi, data: b.data });
        expect(call.functionName).toBe("swapExactETHForTokens");
        const intent = {
          chainId: chain,
          tokenIn: native,
          tokenOut: token,
          amountIn: buy.amountIn,
          expiresAt: buy.expiresAt,
          route: { providerId: f.provider.id, quote: buy },
        } as ApprovedTradeIntent;
        expect(() => validateEvmSwap(intent, b)).not.toThrow();
        expect(() =>
          validateEvmSwap(intent, { ...b, value: "100001" }),
        ).toThrow();
        expect(() =>
          validateEvmSwap(intent, { ...b, wrappedNative: token }),
        ).toThrow();
        const sell = await f.provider.getQuote({
          chainId: chain,
          tokenIn: token,
          tokenOut: native,
          amountIn: "100000",
          decimalsIn: 18,
          decimalsOut: 18,
          slippageBps: 100,
        });
        const s = await f.provider.buildSwap(sell, wallet);
        if (s.family !== "evm") throw Error();
        expect(s.value).toBe("0");
        expect(s.approval?.token).toBe(token);
        expect(decodeFunctionData({ abi, data: s.data }).functionName).toBe(
          "swapExactTokensForETH",
        );
        expect(f.writes()).toBe(0);
        expect(chain).toBeTruthy();
      } finally {
        f.rpc.close();
      }
    },
  );
  it("V3 chưa có cơ chế native đã xác minh phải từ chối native", () => {
    const f = fixture();
    try {
      const p = new EvmRouterSwapProvider(f.rpc, {
        id: "v3",
        chainId: "bnb",
        evmChainId: 56,
        family: "v3",
        router,
        factory,
        wrappedNative: wrapped,
      });
      expect(
        p.supports({
          chainId: "bnb",
          tokenIn: native,
          tokenOut: token,
          amountIn: "1",
          decimalsIn: 18,
          decimalsOut: 18,
          slippageBps: 100,
        }),
      ).toBe(false);
    } finally {
      f.rpc.close();
    }
  });
  it("native trace không đếm DELEGATECALL hoặc subtree reverted", () => {
    expect(
      callTraceNativeDelta(
        {
          type: "CALL",
          from: wallet,
          to: router,
          value: "0x64",
          calls: [
            { type: "DELEGATECALL", from: wallet, to: token, value: "0x64" },
            { type: "CALL", from: router, to: wallet, value: "0x14" },
            {
              type: "CALL",
              from: router,
              to: wallet,
              value: "0x99",
              error: "revert",
            },
          ],
        },
        wallet,
      ),
    ).toBe(-80n);
    expect(() =>
      callTraceNativeDelta({ type: "SELFDESTRUCT" }, wallet),
    ).toThrow();
    const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    expect(
      tracedNativeDelta(
        [
          {
            address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            topics: [transferTopic, topic(wallet), topic(router)],
            data: "0x64",
          },
        ],
        wallet,
      ),
    ).toBe(-100n);
    expect(tracedNativeDelta([], wallet)).toBe(0n);
  });
  it("native SOL receipt tách fee/rent; không đoán giá trị khi thiếu dữ liệu", () => {
    const row = {
      transaction: {
        signatures: ["sig"],
        message: { accountKeys: ["wallet", "ata"] },
      },
      meta: {
        fee: 5,
        preBalances: [1000, 0],
        postBalances: [885, 10],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: "USDC",
            owner: "wallet",
            uiTokenAmount: { amount: "200" },
          },
        ],
      },
    };
    expect(solanaNativeReceiptDelta(row, "wallet", "sig")).toBe(-100n);
    expect(() => solanaNativeReceiptDelta(row, "other", "sig")).toThrow();
    expect(() =>
      solanaNativeReceiptDelta(
        { ...row, transaction: undefined },
        "wallet",
        "sig",
      ),
    ).toThrow();
    const sell = {
      ...row,
      meta: {
        ...row.meta,
        preBalances: [885, 10],
        postBalances: [990, 0],
        preTokenBalances: row.meta.postTokenBalances,
        postTokenBalances: [],
      },
    };
    expect(solanaNativeReceiptDelta(sell, "wallet", "sig")).toBe(100n);
  });
  it("quote/signer không biến thành simulation hoặc LIVE READY", () => {
    const r = deriveReadiness({ QUOTE_READY: true, SIGNER_READY: true });
    expect(r.executionPreflightReady).toBe(false);
    expect(r.liveDryRunReady).toBe(false);
    expect(r.liveReady).toBe(false);
    expect(r.broadcast).toBe("LOCKED");
  });
  it("WS chưa start khác kết nối lỗi", async () => {
    const s = new RecoveringRpcSocket("ws", "ws://127.0.0.1:1", 20);
    expect(s.health().reasons).toContain("WS_NOT_STARTED");
    await s.close();
  });
});
describe("Nguồn giá USD có provenance", () => {
  const asset = () =>
    trustedQuoteSchema.parse({
      address: "native",
      symbol: "SOL",
      decimals: 9,
      coinbaseOracle: { product: "SOL-USD", maxAgeSec: 30, maxSpreadBps: 100 },
    });
  const fetcher = (
    time: string,
    price = "100",
    bid = "99.99",
    ask = "100.01",
  ) => (async () => Response.json({ price, bid, ask, time })) as typeof fetch;
  it("giá độc lập chain có timestamp và không nhận feed của tài sản khác", async () => {
    const p = await resolveCoinbase(asset(), fetcher(new Date().toISOString()));
    expect(p?.priceObservation.source).toBe("EXTERNAL:COINBASE_EXCHANGE");
    expect(productionPriceAllowed("solana", p!)).toBe(true);
    await expect(
      resolveCoinbase(
        { ...asset(), symbol: "ETH" },
        fetcher(new Date().toISOString()),
      ),
    ).rejects.toThrow("PRICE_ASSET_MISMATCH");
  });
  it.each(["stale", "future", "wide", "zero"])("từ chối %s", async (kind) => {
    const time = new Date(
      Date.now() + (kind === "stale" ? -60000 : kind === "future" ? 60000 : 0),
    ).toISOString();
    await expect(
      resolveCoinbase(
        asset(),
        fetcher(
          time,
          kind === "zero" ? "0" : "100",
          "99.99",
          kind === "wide" ? "200" : "100.01",
        ),
      ),
    ).rejects.toThrow();
  });
  it("không chứng nhận cross-chain feed hoặc provenance giả", () => {
    const a = trustedQuoteSchema.parse({
      address: token,
      symbol: "WETH",
      decimals: 18,
      usdPrice: "100",
      usdOracle: {
        chainId: "bnb",
        address: router,
        expectedDescription: "ETH / USD",
        maxAgeSec: 60,
        verifiedSource: "https://data.chain.link",
      },
      priceObservation: {
        asset: "ETH / USD",
        source: "REAL_ONCHAIN:CHAINLINK",
        sourceChain: "bnb",
        observedAt: Date.now(),
        maxAgeMs: 60000,
        status: "VALID",
      },
    });
    expect(productionPriceAllowed("robinhood", a)).toBe(false);
    expect(productionPriceAllowed("bnb", a)).toBe(true);
    expect(
      productionPriceAllowed("bnb", {
        ...a,
        priceObservation: { ...a.priceObservation!, source: "UNVERIFIED" },
      }),
    ).toBe(false);
  });
});
