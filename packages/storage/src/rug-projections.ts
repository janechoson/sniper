import {
  rugSnapshotSchema,
  jevRiskSchema,
  securitySections,
} from "@sniper/core";
import { z } from "zod";
import type { Prisma } from "../generated/client/client";
import type { JournalEntry } from "./index";
import { toJson } from "./projections";
export async function projectRugEntry(
  tx: Prisma.TransactionClient,
  entry: JournalEntry,
  namespace: string,
) {
  const base = {
    namespace,
    chainId: entry.chainId ?? "UNKNOWN",
    tokenAddress: entry.tokenAddress ?? "UNKNOWN",
    observedAt: new Date(entry.createdAt),
  };
  if (entry.kind === "rug.holder-funding") {
    await tx.pipelineObservation.create({
      data: {
        ...base,
        id: entry.id,
        kind: entry.kind,
        payload: toJson(entry.payload),
      },
    });
    return;
  }
  if (
    entry.kind === "rug.creator-observation" ||
    entry.kind === "rug.creator-incident"
  ) {
    const subject = z
      .object({ chainId: z.string(), tokenAddress: z.string() })
      .parse(entry.payload);
    await tx.creatorSecurityHistory.create({
      data: {
        ...base,
        ...subject,
        id: entry.id,
        kind: entry.kind,
        payload: toJson(entry.payload),
      },
    });
    return;
  }
  if (entry.kind === "rug.jev-risk") {
    const { chainId, tokenAddress, ...result } = z
      .object({ chainId: z.string(), tokenAddress: z.string() })
      .passthrough()
      .parse(entry.payload);
    const value = jevRiskSchema.parse(result);
    await tx.jevRiskResult.create({
      data: {
        ...base,
        chainId,
        tokenAddress,
        id: entry.id,
        snapshotHash: value.featureSnapshotHash,
        status: value.status,
        payload: toJson(value),
      },
    });
    return;
  }
  if (entry.kind === "rug.trade-validation") {
    const value = z
      .object({
        chainId: z.string(),
        tokenAddress: z.string(),
        trading: z.record(z.string(), z.unknown()),
        decision: z.unknown(),
      })
      .parse(entry.payload);
    const data = {
      ...base,
      id: entry.id,
      chainId: value.chainId,
      tokenAddress: value.tokenAddress,
      payload: toJson(value.trading),
    };
    await tx.sellabilitySecurityCheck.create({ data });
    await tx.roundTripSecurityCheck.create({ data });
    return;
  }
  if (entry.kind !== "rug.snapshot" && entry.kind !== "rug.monitor") return;
  const payload =
    entry.kind === "rug.monitor"
      ? z.object({ snapshot: z.unknown() }).parse(entry.payload).snapshot
      : entry.payload;
  const value = rugSnapshotSchema.parse(payload),
    snapshotId = entry.id;
  const data = {
    ...base,
    id: snapshotId,
    chainId: value.chainId,
    tokenAddress: value.tokenAddress,
    observedAt: new Date(value.dataQuality.collectedAt),
  };
  await tx.rugCheckSnapshot.create({
    data: {
      ...data,
      poolAddress: value.poolAddress,
      snapshotHash: value.snapshotHash,
      source: value.source,
      decision: value.decision?.decision,
      payload: toJson(value),
    },
  });
  const evidence = securitySections.flatMap((section) =>
    Object.entries(value[section]).map(([field, e]) => ({
      id: `${snapshotId}:${section}.${field}`,
      namespace,
      snapshotId,
      field: `${section}.${field}`,
      provider: e.source,
      origin: e.origin,
      state: e.state,
      payload: toJson(e),
      observedAt: new Date(e.observedAt),
    })),
  );
  await tx.securityEvidence.createMany({ data: evidence });
  await tx.holderSecuritySnapshot.create({
    data: { ...data, payload: toJson(value.holders) },
  });
  if (value.holderClusters.length)
    await tx.holderSecurityCluster.createMany({
      data: value.holderClusters.map((cluster, i) => ({
        ...data,
        id: `${snapshotId}:cluster:${i}`,
        confidence: cluster.confidence,
        payload: toJson(cluster),
      })),
    });
  await tx.liquiditySecuritySnapshot.create({
    data: { ...data, payload: toJson(value.liquidity) },
  });
  await tx.sellabilitySecurityCheck.create({
    data: {
      ...data,
      payload: toJson({
        sellability: value.trading.sellability,
        honeypot: value.trading.honeypot,
      }),
    },
  });
  await tx.roundTripSecurityCheck.create({
    data: { ...data, payload: toJson(value.trading) },
  });
  if (value.externalProviders.length)
    await tx.externalSecurityResult.createMany({
      data: value.externalProviders.map((provider) => ({
        ...data,
        id: `${snapshotId}:${provider.provider}`,
        provider: provider.provider,
        status: provider.status,
        payload: toJson(provider),
        observedAt: new Date(provider.checkedAt),
      })),
    });
  if (value.decision) {
    await tx.securityRiskDecision.create({
      data: {
        ...data,
        decision: value.decision.decision,
        payload: toJson(value.decision),
      },
    });
    if (value.decision.reasonCodes.length)
      await tx.securityRiskReason.createMany({
        data: [...new Set(value.decision.reasonCodes)].map((code) => ({
          id: `${snapshotId}:${code}`,
          namespace,
          decisionId: snapshotId,
          code,
          observedAt: new Date(value.decision!.decidedAt),
        })),
      });
  }
}
