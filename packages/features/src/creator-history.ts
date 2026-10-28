import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CreatorProfile } from "@sniper/core";
import type { Repository } from "@sniper/storage";
import type { CreatorDataProvider } from "./providers";
const relationship = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
  creatorAddress: z.string(),
  transactionId: z.string(),
  observedAt: z.number(),
  evidence: z.enum([
    "CREATION_TRANSACTION",
    "PROGRAM_POOL_CREATOR",
    "PROGRAM_TOKEN_CREATOR",
  ]),
  outcome: z
    .enum(["OBSERVED", "SUSPICIOUS", "LIQUIDITY_REMOVED", "SUCCESSFUL"])
    .default("OBSERVED"),
});
export type CreatorRelationship = z.infer<typeof relationship>;
export class InternalCreatorHistoryProvider implements CreatorDataProvider {
  private records = new Map<string, CreatorRelationship>();
  constructor(private readonly repository: Repository) {}
  private key(chainId: string, tokenAddress: string) {
    return `${chainId}:${chainId === "solana" ? tokenAddress : tokenAddress.toLowerCase()}`;
  }
  async restore() {
    for (const row of await this.repository.read())
      if (row.kind === "creator.relationship") {
        const value = relationship.parse(row.payload);
        this.records.set(this.key(value.chainId, value.tokenAddress), value);
      }
  }
  async record(input: CreatorRelationship) {
    const value = relationship.parse(input);
    const key = this.key(value.chainId, value.tokenAddress);
    const old = this.records.get(key);
    if (
      old?.evidence === "PROGRAM_TOKEN_CREATOR" &&
      value.evidence === "PROGRAM_POOL_CREATOR"
    )
      return;
    if (
      old &&
      old.creatorAddress !== value.creatorAddress &&
      !(
        old.evidence === "PROGRAM_POOL_CREATOR" &&
        value.evidence === "PROGRAM_TOKEN_CREATOR"
      )
    )
      throw new Error("CREATOR_EVIDENCE_CONFLICT");
    if (old && old.outcome === value.outcome && old.evidence === value.evidence)
      return;
    await this.repository.append({
      id: randomUUID(),
      kind: "creator.relationship",
      chainId: value.chainId,
      tokenAddress: value.tokenAddress,
      payload: value,
      createdAt: Date.now(),
    });
    this.records.set(key, value);
  }
  async getCreatorAnalysis(
    chainId: string,
    tokenAddress: string,
  ): Promise<CreatorProfile> {
    const record = this.records.get(this.key(chainId, tokenAddress));
    if (!record) return {};
    const previous = [...this.records.values()].filter(
      (row) =>
        row.chainId === chainId &&
        row.creatorAddress === record.creatorAddress &&
        row.tokenAddress !== record.tokenAddress,
    );
    // Số đếm chỉ phản ánh dataset nội bộ. Không suy ra lịch sử toàn chuỗi hoặc nguồn tiền sạch.
    return {
      address: record.creatorAddress,
      role:
        record.evidence === "PROGRAM_TOKEN_CREATOR"
          ? "TOKEN_CREATOR"
          : record.evidence === "PROGRAM_POOL_CREATOR"
            ? "POOL_CREATOR"
            : "TOKEN_DEPLOYER",
      previousTokens: previous.length,
      suspiciousLaunches: previous.filter((row) => row.outcome === "SUSPICIOUS")
        .length,
      liquidityRemovals: previous.filter(
        (row) => row.outcome === "LIQUIDITY_REMOVED",
      ).length,
      successfulLaunches: previous.filter((row) => row.outcome === "SUCCESSFUL")
        .length,
    };
  }
}
