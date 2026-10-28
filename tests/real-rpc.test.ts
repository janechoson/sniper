import { afterEach, describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  parseAbi,
  encodeFunctionResult,
  decodeFunctionData,
  type Address,
} from "viem";
import { BorshInstructionCoder, BN, utils } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import {
  JsonRpcClient,
  ResilientHttp,
  RequestScheduler,
  EvmFactoryDiscovery,
  SolanaProgramDiscovery,
  RollingMarketBook,
  RpcQuoteUsdPriceProvider,
} from "@sniper/chains";
import { dexDeploymentSchema } from "@sniper/config";
import type { TokenDiscoveryEvent } from "@sniper/core";
import { loadVerifiedIdl } from "../packages/chains/src/real/idl";
const clients: JsonRpcClient[] = [];
afterEach(() => {
  for (const rpc of clients.splice(0)) rpc.close();
});
function fixture(
  handler: (method: string, params: unknown[]) => unknown | Promise<unknown>,
) {
  const rpc = new JsonRpcClient("fixture", "http://127.0.0.1/unused", {
    rps: 10000,
    timeoutMs: 1000,
    fetcher: async (_url, init) => {
      const request = z
        .object({
          id: z.number(),
          method: z.string(),
          params: z.array(z.unknown()),
        })
        .parse(JSON.parse(String(init?.body)));
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: await handler(request.method, request.params),
      });
    },
  });
  clients.push(rpc);
  return rpc;
}
const a = "0x" + "11".repeat(20),
  b = "0x" + "22".repeat(20),
  pool = "0x" + "33".repeat(20),
  factoryAddress = "0x" + "44".repeat(20),
  hash = "0x" + "aa".repeat(32);
const pairEvent = parseAbiItem(
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)",
);
describe("RPC thật qua phản hồi fixture, không truy cập mạng", () => {
  it("không retry lỗi 401 và đánh dấu provider DOWN", async () => {
    let calls = 0;
    const http = new ResilientHttp(
      "fixture",
      new RequestScheduler(10000),
      1000,
      async () => {
        calls++;
        return Response.json(
          { error: "UNTRUSTED_ERROR_WITH_SECRET" },
          { status: 401 },
        );
      },
    );
    await expect(http.json("https://fixture.invalid")).rejects.toThrow(
      /^HTTP_401$/,
    );
    expect(calls).toBe(1);
    expect(http.health().status).toBe("DOWN");
    expect(JSON.stringify(http.health())).not.toContain("SECRET");
    http.close();
  });
  it("retry 429 có giới hạn rồi khôi phục health", async () => {
    let calls = 0;
    const http = new ResilientHttp(
      "fixture",
      new RequestScheduler(10000),
      1000,
      async () =>
        ++calls === 1
          ? Response.json({}, { status: 429 })
          : Response.json({ ok: true }),
    );
    expect(await http.json("https://fixture.invalid")).toEqual({ ok: true });
    expect(calls).toBe(2);
    http.close();
  });
  it("từ chối id phản hồi không khớp", async () => {
    const rpc = new JsonRpcClient("bad-id", "http://127.0.0.1/unused", {
      fetcher: async () =>
        Response.json({ jsonrpc: "2.0", id: 999, result: "0x38" }),
    });
    clients.push(rpc);
    await expect(rpc.request("eth_chainId", [], z.string())).rejects.toThrow(
      "RPC_RESPONSE_ID_MISMATCH",
    );
  });
  it("V2 giải mã đúng base/quote, timestamp on-chain và cursor sau ghi sự kiện", async () => {
    const cursors = new Map<string, string>();
    const events: TokenDiscoveryEvent[] = [];
    const log = {
      address: factoryAddress,
      topics: encodeEventTopics({
        abi: [pairEvent],
        eventName: "PairCreated",
        args: { token0: a as Address, token1: b as Address },
      }),
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [pool as Address, 1n],
      ),
      blockNumber: "0x64",
      blockHash: hash,
      transactionHash: hash,
      logIndex: "0x0",
    };
    const rpc = fixture((method) =>
      method === "eth_getCode"
        ? "0x1234"
        : method === "eth_blockNumber"
          ? "0x66"
          : method === "eth_getLogs"
            ? [log]
            : method === "eth_getBlockByNumber"
              ? { hash, timestamp: "0x64" }
              : null,
    );
    const scanner = new EvmFactoryDiscovery(
      "bnb",
      rpc,
      dexDeploymentSchema.parse({
        id: "v2",
        chainId: "bnb",
        family: "uniswap-v2",
        factoryAddress,
        fromBlock: "100",
        verifiedSource: "https://github.com/Uniswap/v2-core",
      }),
      [{ address: b, symbol: "Q", decimals: 6 }],
      {
        readCursor: async (key) => cursors.get(key),
        writeCursor: async (key, value) => {
          expect(events).toHaveLength(1);
          cursors.set(key, value);
        },
      },
    );
    await scanner.poll(async (event) => {
      events.push(event);
    });
    expect(events[0]).toMatchObject({
      source: "RPC",
      tokenAddress: a,
      poolAddress: pool,
      quoteTokenAddress: b,
      chainTimestamp: 100000,
      pairClassification: "TRUSTED_QUOTE",
    });
    await scanner.poll(async (event) => {
      events.push(event);
    });
    expect(events).toHaveLength(1);
    cursors.delete("discovery:bnb:v2");
    await scanner.poll(async () => {});
    expect(cursors.get("discovery:bnb:v2")).toBe("100");
    cursors.set(
      "discovery:bnb:v2:checkpoint",
      JSON.stringify({
        block: cursors.get("discovery:bnb:v2"),
        hash: "0x" + "ff".repeat(32),
      }),
    );
    await expect(scanner.poll(async () => {})).rejects.toThrow(
      "DISCOVERY_REORG_REQUIRES_RECONCILIATION",
    );
  });
  it("không tiến cursor khi ghi sự kiện thất bại", async () => {
    let writes = 0;
    const rpc = fixture((method) =>
      method === "eth_getCode"
        ? "0x1234"
        : method === "eth_blockNumber"
          ? "0x66"
          : method === "eth_getLogs"
            ? [
                {
                  address: factoryAddress,
                  topics: encodeEventTopics({
                    abi: [pairEvent],
                    eventName: "PairCreated",
                    args: { token0: a as Address, token1: b as Address },
                  }),
                  data: encodeAbiParameters(
                    [{ type: "address" }, { type: "uint256" }],
                    [pool as Address, 1n],
                  ),
                  blockNumber: "0x64",
                  blockHash: hash,
                  transactionHash: hash,
                  logIndex: "0x0",
                },
              ]
            : { hash, timestamp: "0x64" },
    );
    const scanner = new EvmFactoryDiscovery(
      "bnb",
      rpc,
      dexDeploymentSchema.parse({
        id: "v2",
        chainId: "bnb",
        family: "uniswap-v2",
        factoryAddress,
        fromBlock: "100",
        verifiedSource: "https://github.com/Uniswap/v2-core",
      }),
      [{ address: b, symbol: "Q", decimals: 6 }],
      {
        readCursor: async () => undefined,
        writeCursor: async () => {
          writes++;
        },
      },
    );
    await expect(
      scanner.poll(async () => {
        throw new Error("DISK_FAILURE");
      }),
    ).rejects.toThrow("DISK_FAILURE");
    expect(writes).toBe(0);
  });
  it.each([false, true])(
    "Raydium IDL initialize, chế độ quan sát=%s",
    async (observationOnly) => {
      const idl = loadVerifiedIdl("raydium-cpmm").idl;
      const definition = idl.instructions.find(
        (ix) => ix.name === "initialize",
      )!;
      const keys = definition.accounts.map((_, index) =>
        Keypair.fromSeed(
          new Uint8Array(32).fill(index + 1),
        ).publicKey.toBase58(),
      );
      const program = idl.address;
      const ix = new BorshInstructionCoder(idl).encode("initialize", {
        init_amount_0: new BN(100),
        init_amount_1: new BN(200),
        open_time: new BN(0),
      });
      const mint0 =
          keys[
            definition.accounts.findIndex((x) => x.name === "token_0_mint")
          ]!,
        mint1 =
          keys[
            definition.accounts.findIndex((x) => x.name === "token_1_mint")
          ]!,
        poolKey =
          keys[definition.accounts.findIndex((x) => x.name === "pool_state")]!;
      const events: TokenDiscoveryEvent[] = [];
      const cursors = new Map<string, string>();
      const rpc = fixture((method) =>
        method === "getSlot"
          ? 101
          : method === "getBlockTime"
            ? 100
            : method === "getSignaturesForAddress"
              ? [
                  {
                    signature: "fixture-signature",
                    slot: 100,
                    err: null,
                    blockTime: 100,
                  },
                ]
              : {
                  slot: 100,
                  blockTime: 100,
                  version: observationOnly ? 1 : 0,
                  transaction: {
                    message: {
                      accountKeys: [...keys, program],
                      instructions: [
                        {
                          programIdIndex: keys.length,
                          accounts: keys.map((_, i) => i),
                          data: utils.bytes.bs58.encode(ix),
                        },
                      ],
                    },
                  },
                  meta: { err: null, innerInstructions: [], logMessages: [] },
                },
      );
      const scanner = new SolanaProgramDiscovery(
        "solana",
        rpc,
        dexDeploymentSchema.parse({
          id: "cpmm",
          chainId: "solana",
          family: "raydium-cpmm",
          programId: program,
          verifiedSource: "https://github.com/raydium-io/raydium-idl",
        }),
        [{ address: mint1, symbol: "Q", decimals: 9 }],
        {
          readCursor: async (key) => cursors.get(key),
          writeCursor: async (key, value) => {
            cursors.set(key, value);
          },
        },
        undefined,
        undefined,
        undefined,
        { observationOnly },
      );
      if (observationOnly)
        scanner.hint({
          value: {
            signature: "not-pool-initialization",
            err: null,
            logs: ["Program log: Instruction: InitializeAccount3"],
          },
        });
      if (observationOnly)
        scanner.hint({
          value: {
            signature: "fixture-signature",
            err: null,
            logs: ["Program log: Instruction: Initialize"],
          },
        });
      await scanner.poll(async (event) => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
      if (observationOnly)
        expect(events[0]?.rawEvent).toMatchObject({
          transactionVersion: 1,
          discoveryCoverage: "OPPORTUNISTIC_RPC_WS",
        });
      expect(events[0]).toMatchObject({
        tokenAddress: mint0,
        poolAddress: poolKey,
        quoteTokenAddress: mint1,
        source: "RPC",
      });
      await scanner.poll(async (event) => {
        events.push(event);
      });
      expect(events).toHaveLength(1);
    },
  );
});
describe("Cửa sổ thị trường và oracle", () => {
  it("đếm giao dịch đã phủ đủ, giữ unique wallet UNKNOWN và không dùng giá 20 giây trước cho cửa sổ 5 giây", () => {
    const book = new RollingMarketBook(2, 100);
    const now = 100000;
    book.startCompleteStream("p", 0);
    book.advanceStream("p", now);
    book.observe("p", { at: now - 20000, priceUsd: 1, liquidityUsd: 100 });
    book.observe("p", {
      at: now - 1000,
      trade: { id: "a", side: "BUY", volumeUsd: 10 },
    });
    book.observe("p", { at: now, priceUsd: 2, liquidityUsd: 200 });
    book.observe("p", {
      at: now - 1000,
      trade: { id: "a", side: "BUY", volumeUsd: 10 },
    });
    const state = book.features("p", now);
    expect(state.buys5s).toBe(1);
    expect(state.volume5s).toBe(10);
    expect(state.uniqueBuyers).toBeUndefined();
    expect(state.priceChange5s).toBeUndefined();
    expect(state.priceUsd).toBe(2);
    book.invalidateStream("p");
    expect(book.features("p", now).volume5s).toBeUndefined();
  });
  it("không chuyển volume thiếu định giá thành 0", () => {
    const book = new RollingMarketBook();
    book.startCompleteStream("p", 0);
    book.advanceStream("p", 100000);
    book.observe("p", { at: 100000, priceUsd: 1 });
    book.observe("p", { at: 99000, trade: { id: "a", side: "BUY" } });
    expect(book.features("p", 100000).buys5s).toBe(1);
    expect(book.features("p", 100000).volume5s).toBeUndefined();
  });
  it("oracle sai description hoặc quá hạn không trả giá thay thế $1", async () => {
    const abi = parseAbi([
      "function decimals() view returns (uint8)",
      "function description() view returns (string)",
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    ]);
    const rpc = fixture((method, params) => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getCode") return "0x1234";
      const call = z.object({ data: z.string() }).parse(params[0]);
      const decoded = decodeFunctionData({
        abi,
        data: call.data as `0x${string}`,
      });
      if (decoded.functionName === "decimals")
        return encodeFunctionResult({
          abi,
          functionName: "decimals",
          result: 8,
        });
      if (decoded.functionName === "description")
        return encodeFunctionResult({
          abi,
          functionName: "description",
          result: "OTHER / USD",
        });
      return encodeFunctionResult({
        abi,
        functionName: "latestRoundData",
        result: [1n, 100000000n, 1n, 1n, 1n],
      });
    });
    const prices = new RpcQuoteUsdPriceProvider(
      new Map([["bnb", { rpc, evmChainId: 56 }]]),
    );
    expect(
      await prices.resolve("bnb", {
        address: a,
        symbol: "Q",
        decimals: 6,
        usdPrice: "1",
        priceSource: "old",
        priceVerifiedAt: 0,
        usdOracle: {
          chainId: "bnb",
          address: b,
          expectedDescription: "Q / USD",
          maxAgeSec: 60,
          verifiedSource: "https://docs.chain.link",
        },
      }),
    ).toBeUndefined();
  });
});
