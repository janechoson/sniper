import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
} from "viem";
import { z } from "zod";
import { JsonRpcClient } from "@sniper/chains";
const abi = parseAbi([
  "function allPairsLength() view returns(uint256)",
  "function getPair(address,address) view returns(address)",
  "function allPairs(uint256) view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function decimals() view returns(uint8)",
  "function symbol() view returns(string)",
]);
/** Bounded sample only; real pairs, no whole-chain scan or invented candidate. */
export async function liquidNativeCandidate(
  rpc: JsonRpcClient,
  factory: Address,
  wrapped: Address,
  amount: bigint,
  index = 0,
  tokenHint?: Address,
) {
  const call = async (
    to: Address,
    name:
      | "allPairsLength"
      | "allPairs"
      | "token0"
      | "token1"
      | "getReserves"
      | "decimals"
      | "symbol",
    args?: readonly [bigint],
  ) =>
    decodeFunctionResult({
      abi,
      functionName: name,
      data: await rpc.request(
        "eth_call",
        [
          { to, data: encodeFunctionData({ abi, functionName: name, args }) },
          "latest",
        ],
        z.custom<`0x${string}`>(
          (v) => typeof v === "string" && /^0x[\da-f]*$/i.test(v),
        ),
      ),
    });
  if (tokenHint) {
    const data = encodeFunctionData({
      abi,
      functionName: "getPair",
      args: [wrapped, tokenHint],
    });
    const pair = decodeFunctionResult({
      abi,
      functionName: "getPair",
      data: await rpc.request(
        "eth_call",
        [{ to: factory, data }, "latest"],
        z.custom<`0x${string}`>(),
      ),
    });
    const [a, b, reserves, decimals, symbol] = await Promise.all([
      call(pair, "token0"),
      call(pair, "token1"),
      call(pair, "getReserves"),
      call(tokenHint, "decimals"),
      call(tokenHint, "symbol"),
    ]);
    if (
      ![a, b].every(
        (t) =>
          typeof t === "string" &&
          [wrapped.toLowerCase(), tokenHint.toLowerCase()].includes(
            t.toLowerCase(),
          ),
      ) ||
      a === b
    )
      throw Error("PREFLIGHT_POOL_IDENTITY_INVALID");
    const r = reserves as readonly [bigint, bigint, number];
    if (
      r[String(a).toLowerCase() === wrapped.toLowerCase() ? 0 : 1] <
        amount * 50n ||
      typeof decimals !== "number" ||
      typeof symbol !== "string"
    )
      throw Error("PREFLIGHT_POOL_LIQUIDITY_LOW");
    return {
      address: tokenHint,
      decimals,
      symbol,
      pool: pair,
      inspectedPools: 1,
      qualifyingNativePools: 1,
    };
  }
  const count = (await call(factory, "allPairsLength")) as bigint;
  const indices =
    count <= 512n
      ? Array.from({ length: Number(count) }, (_, i) => BigInt(i))
      : [
          ...new Set(
            [
              ...Array.from({ length: 20 }, (_, i) => BigInt(i)),
              ...Array.from({ length: 20 }, (_, i) => count - 1n - BigInt(i)),
              ...Array.from(
                { length: 60 },
                (_, i) => (BigInt(i) * count) / 60n,
              ),
            ].filter((i) => i >= 0n && i < count),
          ),
        ];
  const candidates: {
    address: string;
    symbol: string;
    decimals: number;
    nativeReserve: bigint;
    pool: string;
  }[] = [];
  for (const i of indices) {
    try {
      const pair = (await call(factory, "allPairs", [i])) as Address;
      const reserves = (await call(pair, "getReserves")) as readonly [
        bigint,
        bigint,
        number,
      ];
      if (reserves[0] === 0n || reserves[1] === 0n) continue;
      const [a, b] = await Promise.all([
        call(pair, "token0") as Promise<Address>,
        call(pair, "token1") as Promise<Address>,
      ]);
      const native0 = a.toLowerCase() === wrapped.toLowerCase();
      if (!native0 && b.toLowerCase() !== wrapped.toLowerCase()) continue;
      const nativeReserve = reserves[native0 ? 0 : 1];
      if (nativeReserve < amount * 50n) continue;
      const address = native0 ? b : a;
      const [decimals, symbol] = await Promise.all([
        call(address, "decimals"),
        call(address, "symbol"),
      ]);
      if (
        typeof decimals !== "number" ||
        typeof symbol !== "string" ||
        symbol.length > 32
      )
        continue;
      candidates.push({ address, decimals, symbol, nativeReserve, pool: pair });
    } catch {
      /* An unreadable sampled pool cannot certify a route. */
    }
  }
  candidates.sort((a, b) => (a.nativeReserve > b.nativeReserve ? -1 : 1));
  const best = candidates[index];
  if (!best) throw Error("NO_LIQUID_NATIVE_PAIR_IN_BOUNDED_SAMPLE");
  return {
    address: best.address,
    decimals: best.decimals,
    symbol: best.symbol,
    pool: best.pool,
    inspectedPools: indices.length,
    qualifyingNativePools: candidates.length,
  };
}
