import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  keccak256,
  toHex,
  pad,
  type Address,
} from "viem";
import { z } from "zod";
import type { SecurityAnalysis, TokenInfo } from "@sniper/core";
import type { JsonRpcClient } from "../rpc/http";
import { rpcEvidence } from "./evidence";
export const erc20ReadAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);
export const hexSchema = z
  .string()
  .regex(/^0x[\da-fA-F]*$/)
  .transform((value) => value as `0x${string}`);
const metadataText = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)
    : undefined;
export class EvmTokenAnalyzer {
  invalidate(address: string) {
    this.cache.delete(address.toLowerCase());
  }
  private cache = new Map<
    string,
    {
      at: number;
      value: { info: TokenInfo; security: SecurityAnalysis; owner?: string };
    }
  >();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly ttlMs = 30000,
    private readonly observationLatest = false,
  ) {}
  async call(
    address: Address,
    functionName: "decimals" | "totalSupply" | "name" | "symbol" | "owner",
    block = "latest",
  ) {
    const data = encodeFunctionData({ abi: erc20ReadAbi, functionName });
    const result = await this.rpc.request(
      "eth_call",
      [{ to: address, data }, block],
      hexSchema,
    );
    return decodeFunctionResult({
      abi: erc20ReadAbi,
      functionName,
      data: result,
    });
  }
  async analyze(
    address: string,
  ): Promise<{ info: TokenInfo; security: SecurityAnalysis; owner?: string }> {
    if (!isAddress(address))
      return {
        info: { address },
        security: { validToken: false, evidence: ["Địa chỉ EVM không hợp lệ"] },
      };
    const cached = this.cache.get(address.toLowerCase());
    if (cached && Date.now() - cached.at < this.ttlMs)
      return structuredClone(cached.value);
    const block = await this.rpc.request("eth_blockNumber", [], hexSchema);
    const header = await this.rpc.request(
      "eth_getBlockByNumber",
      [block, false],
      z.object({ hash: hexSchema }),
    );
    const stateBlock = this.observationLatest ? "latest" : block;
    const code = await this.rpc.request(
      "eth_getCode",
      [address, stateBlock],
      hexSchema,
    );
    if (code === "0x")
      return {
        info: { address },
        security: {
          validToken: false,
          bytecodePresent: false,
          evidence: ["RPC eth_getCode không có mã hợp đồng"],
        },
      };
    const results = await Promise.allSettled(
      (["decimals", "totalSupply", "name", "symbol", "owner"] as const).map(
        (name) => this.call(address, name, stateBlock),
      ),
    );
    const get = (index: number) => {
      const result = results[index];
      return result?.status === "fulfilled" ? result.value : undefined;
    };
    const decimals = get(0);
    const supply = get(1);
    const owner = get(4);
    const info: TokenInfo = {
      address,
      decimals:
        typeof decimals === "number" &&
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= 255
          ? decimals
          : undefined,
      totalSupply: typeof supply === "bigint" ? supply.toString() : undefined,
      name: metadataText(get(2)),
      symbol: metadataText(get(3))?.slice(0, 32),
    };
    const slots = await Promise.allSettled(
      [
        "eip1967.proxy.implementation",
        "eip1967.proxy.admin",
        "eip1967.proxy.beacon",
      ].map(async (name) =>
        this.rpc.request(
          "eth_getStorageAt",
          [
            address,
            pad(toHex(BigInt(keccak256(toHex(name))) - 1n), { size: 32 }),
            stateBlock,
          ],
          hexSchema,
        ),
      ),
    );
    const proxy = slots.some(
      (result) => result.status === "fulfilled" && BigInt(result.value) !== 0n,
    );
    const security: SecurityAnalysis = {
      bytecodePresent: true,
      validToken:
        info.decimals !== undefined && info.totalSupply !== undefined
          ? true
          : undefined,
      upgradeRisk: proxy ? true : undefined,
      evidence: [
        "RPC eth_getCode + ERC-20 decimals/totalSupply; metadata không đáng tin",
        `EIP-1967 implementation/admin/beacon: ${proxy ? "có slot khác zero" : "chưa chứng minh không có proxy"}`,
        "Không suy ra mint/blacklist/pause/thuế/khả năng bán từ việc thiếu selector hoặc owner đã từ bỏ",
      ],
    };
    const at = new Date().toISOString();
    const findings: NonNullable<SecurityAnalysis["onChainFindings"]> = [];
    const add = (
      field: string,
      value: Parameters<typeof rpcEvidence>[0],
      state: Parameters<typeof rpcEvidence>[1] = "SAFE",
      reference?: string,
    ) =>
      findings.push({
        section: "contract",
        field,
        evidence: { ...rpcEvidence(value, state, reference), observedAt: at },
      });
    add("bytecodeHash", keccak256(code));
    if (security.validToken !== undefined)
      add(
        "validToken",
        security.validToken,
        security.validToken ? "SAFE" : "RISK",
      );
    if (info.totalSupply !== undefined) add("supply", info.totalSupply);
    if (info.decimals !== undefined) add("decimals", info.decimals);
    if (typeof owner === "string" && isAddress(owner)) {
      add(
        "owner",
        owner,
        "SAFE",
        "owner() selector only; không chứng minh không còn role khác",
      );
      add(
        "ownershipRenounced",
        BigInt(owner) === 0n,
        "SAFE",
        "owner() == zero; không chứng minh mọi đặc quyền đã từ bỏ",
      );
    }
    for (const [i, field] of [
      "implementation",
      "proxyAdmin",
      "beacon",
    ].entries()) {
      const slot = slots[i];
      if (
        slot?.status === "fulfilled" &&
        slot.value.length === 66 &&
        BigInt(slot.value) !== 0n
      ) {
        if (field === "implementation")
          add(field, "0x" + slot.value.slice(-40), "RISK", "EIP1967 storage");
        add("proxy", true, "RISK", `EIP1967 ${field}`);
      }
    }
    const minimal =
      /^0x363d3d373d3d3d363d73([a-fA-F0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(
        code,
      );
    if (minimal) {
      add(
        "implementation",
        "0x" + minimal[1],
        "RISK",
        "EIP1167 exact runtime pattern",
      );
      add("proxy", true, "RISK", "EIP1167");
    }
    const implementation = findings.find((f) => f.field === "implementation")
      ?.evidence.value;
    if (typeof implementation === "string" && isAddress(implementation)) {
      try {
        const implementationCode = await this.rpc.request(
          "eth_getCode",
          [implementation, stateBlock],
          hexSchema,
        );
        if (implementationCode !== "0x")
          add(
            "implementationCodeHash",
            keccak256(implementationCode),
            "SAFE",
            "Chỉ xác nhận code triển khai; chưa chứng minh đặc quyền hoặc bất biến",
          );
      } catch {
        /* Không có code triển khai giữ UNKNOWN. */
      }
    }
    const after = await this.rpc.request(
      "eth_getBlockByNumber",
      [block, false],
      z.object({ hash: hexSchema }),
    );
    if (after.hash !== header.hash) throw new Error("SECURITY_BLOCK_REORG");
    for (const finding of findings)
      finding.evidence.reference =
        `${this.observationLatest ? "OBSERVATION latest-state, non-atomic; observed head" : "block"}=${BigInt(block)}; hash=${header.hash}; ${finding.evidence.reference ?? "RPC read"}`.slice(
          0,
          300,
        );
    security.onChainFindings = findings;
    const value = {
      info,
      security,
      owner: typeof owner === "string" && isAddress(owner) ? owner : undefined,
    };
    if (this.cache.size >= 512)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(address.toLowerCase(), { at: Date.now(), value });
    return structuredClone(value);
  }
}
