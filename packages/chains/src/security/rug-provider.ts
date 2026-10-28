import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  type Address,
} from "viem";
import { z } from "zod";
import type {
  TokenSecurityProvider,
  TokenSecurityRequest,
  TokenSecurityProviderResult,
  SecurityAnalysis,
  SecurityEvidence,
} from "@sniper/core";
import { ratioToNumber } from "@sniper/shared";
import { rpcEvidence } from "./evidence";
import { hexSchema } from "./evm";
import type { JsonRpcClient } from "../rpc/http";
import type { RpcHolderDataProvider } from "./holders";
export class OnChainSecurityProvider implements TokenSecurityProvider {
  readonly id = "on-chain";
  constructor(
    private readonly analyzers: Map<
      string,
      (address: string) => Promise<SecurityAnalysis>
    >,
    private readonly invalidators: Map<
      string,
      (address: string) => void
    > = new Map(),
  ) {}
  invalidate(chainId: string, tokenAddress: string) {
    this.invalidators.get(chainId)?.(tokenAddress);
  }
  supports(chainId: string) {
    return this.analyzers.has(chainId);
  }
  async healthCheck() {
    return {
      id: this.id,
      status: "READY" as const,
      reasons: [],
      checkedAt: Date.now(),
    };
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const start = Date.now(),
      security = await this.analyzers.get(request.chainId)!(
        request.tokenAddress,
      );
    const findings = [...(security.onChainFindings ?? [])];
    if (["bnb", "robinhood"].includes(request.chainId)) {
      for (const field of ["mintAuthority", "freezeAuthority"])
        findings.push({
          section: "contract",
          field,
          evidence: rpcEvidence(null, "NOT_APPLICABLE", undefined, [
            "SPL_AUTHORITY_NOT_APPLICABLE_TO_EVM",
          ]),
        });
    }
    if (
      security.validToken !== undefined &&
      !findings.some((f) => f.field === "validToken")
    )
      findings.push({
        section: "contract",
        field: "validToken",
        evidence: rpcEvidence(
          security.validToken,
          security.validToken ? "SAFE" : "RISK",
        ),
      });
    return {
      provider: this.id,
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
      status: "OK",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      findings,
    };
  }
}
export interface VerifiedExclusion {
  chainId: string;
  address: string;
  kind: "POOL" | "BURN" | "ROUTER" | "SYSTEM" | "PROTOCOL";
  verifiedSource: string;
}
export class OnChainHolderSecurityProvider implements TokenSecurityProvider {
  readonly id = "rpc-holders";
  constructor(
    private readonly holders: RpcHolderDataProvider,
    private readonly exclusions: VerifiedExclusion[] = [],
  ) {}
  supports(chainId: string) {
    return chainId === "solana";
  }
  async healthCheck() {
    return {
      id: this.id,
      status: "READY" as const,
      reasons: [],
      checkedAt: Date.now(),
    };
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const start = Date.now(),
      distribution = await this.holders.getVerifiedDistribution(
        request.chainId,
        request.tokenAddress,
      );
    const result: TokenSecurityProviderResult = {
      provider: this.id,
      chainId: request.chainId,
      tokenAddress: request.tokenAddress,
      status: "OK",
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      findings: [],
    };
    if (!distribution) return result;
    const add = (field: string, value: SecurityEvidence["value"]) =>
      result.findings.push({
        section: "holders",
        field,
        evidence: {
          ...rpcEvidence(
            value,
            "SAFE",
            `full supply; slot=${distribution.slot}`,
          ),
          observedAt: distribution.observedAt,
        },
      });
    const supply = BigInt(distribution.supply);
    const excluded = this.exclusions.filter(
      (e) => e.chainId === request.chainId && e.verifiedSource,
    );
    const excludedSet = new Set(excluded.map((e) => e.address));
    const raw = distribution.holders
      .filter((h) => BigInt(h.amount) > 0n)
      .sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1));
    const adjusted = raw.filter((h) => !excludedSet.has(h.address));
    const excludedAmount = raw
      .filter((h) => excludedSet.has(h.address))
      .reduce((sum, h) => sum + BigInt(h.amount), 0n);
    const adjustedSupply = supply - excludedAmount;
    add("count", raw.length);
    add("coverage", "COMPLETE");
    for (const n of [1, 5, 10, 20]) {
      const top = ratioToNumber(
        raw.slice(0, n).reduce((s, h) => s + BigInt(h.amount), 0n) * 100n,
        supply,
      );
      if (top !== undefined) add(`top${n}Pct`, top);
      // Không gọi raw là adjusted khi chưa xác minh inventory pool/system cần loại.
      if (excluded.length && adjustedSupply > 0n) {
        const pct = ratioToNumber(
          adjusted.slice(0, n).reduce((s, h) => s + BigInt(h.amount), 0n) *
            100n,
          adjustedSupply,
        );
        if (pct !== undefined) add(`adjustedTop${n}Pct`, pct);
      }
    }
    if (excluded.length) {
      add(
        "exclusions",
        excluded
          .map((e) => `${e.kind}:${e.address}`)
          .join(";")
          .slice(0, 1024),
      );
      const pct = ratioToNumber(excludedAmount * 100n, supply);
      if (pct !== undefined) add("excludedSupplyPct", pct);
    }
    return result;
  }
}
const pairAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
export class OnChainLiquiditySecurityProvider implements TokenSecurityProvider {
  readonly id = "rpc-liquidity";
  constructor(
    private readonly networks: Map<
      string,
      { rpc: JsonRpcClient; factories: string[] }
    >,
    private readonly creator: (
      request: TokenSecurityRequest,
    ) => Promise<string | undefined>,
  ) {}
  supports(chainId: string) {
    return this.networks.has(chainId);
  }
  async healthCheck() {
    return {
      id: this.id,
      status: "READY" as const,
      reasons: [],
      checkedAt: Date.now(),
    };
  }
  async analyze(
    request: TokenSecurityRequest,
  ): Promise<TokenSecurityProviderResult> {
    const at = Date.now(),
      result: TokenSecurityProviderResult = {
        provider: this.id,
        chainId: request.chainId,
        tokenAddress: request.tokenAddress,
        status: "OK",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        findings: [],
      };
    if (!request.poolAddress || !isAddress(request.poolAddress)) return result;
    const network = this.networks.get(request.chainId)!;
    const block = await network.rpc.request("eth_blockNumber", [], hexSchema);
    const read = async (
      name:
        | "factory"
        | "token0"
        | "token1"
        | "getReserves"
        | "totalSupply"
        | "balanceOf",
      args?: readonly [Address],
    ) => {
      const data =
        name === "balanceOf"
          ? encodeFunctionData({
              abi: pairAbi,
              functionName: name,
              args: args!,
            })
          : encodeFunctionData({ abi: pairAbi, functionName: name });
      const raw = await network.rpc.request(
        "eth_call",
        [{ to: request.poolAddress, data }, block],
        hexSchema,
      );
      return decodeFunctionResult({
        abi: pairAbi,
        functionName: name,
        data: raw,
      });
    };
    const factory = await read("factory");
    if (
      typeof factory !== "string" ||
      !network.factories.some((f) => f.toLowerCase() === factory.toLowerCase())
    )
      return result;
    const [token0, token1, reserves, total] = await Promise.all([
      read("token0"),
      read("token1"),
      read("getReserves"),
      read("totalSupply"),
    ]);
    if (
      typeof token0 !== "string" ||
      typeof token1 !== "string" ||
      ![token0, token1].some(
        (t) => t.toLowerCase() === request.tokenAddress.toLowerCase(),
      ) ||
      !Array.isArray(reserves) ||
      typeof total !== "bigint" ||
      total <= 0n
    )
      return result;
    const values = z
      .tuple([z.bigint(), z.bigint(), z.number()])
      .parse(reserves);
    const base0 = token0.toLowerCase() === request.tokenAddress.toLowerCase();
    const add = (
      field: string,
      value: SecurityEvidence["value"],
      state: SecurityEvidence["state"] = "SAFE",
    ) =>
      result.findings.push({
        section: "liquidity",
        field,
        evidence: rpcEvidence(
          value,
          state,
          `V2 pool=${request.poolAddress}; block=${BigInt(block)}`,
        ),
      });
    add("baseAmount", values[base0 ? 0 : 1].toString());
    add("quoteAmount", values[base0 ? 1 : 0].toString());
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    const burned = await read("balanceOf", [zero]);
    if (typeof burned === "bigint") {
      const pct = ratioToNumber(burned * 100n, total);
      if (pct !== undefined) add("lpBurned", pct);
    }
    const creator = await this.creator(request);
    if (creator && isAddress(creator)) {
      const balance = await read("balanceOf", [creator]);
      if (typeof balance === "bigint") {
        const pct = ratioToNumber(balance * 100n, total);
        if (pct !== undefined)
          add("creatorLpPct", pct, pct > 0 ? "RISK" : "SAFE");
      }
    }
    result.latencyMs = Date.now() - at;
    return result;
  }
}
