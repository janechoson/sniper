import { z } from "zod";
import { approvedIntentSchema, managedPositionSchema } from "@sniper/core";
import { Prisma } from "../generated/client/client";
import type { JournalEntry } from "./index";
import { projectCommit, toJson } from "./projections";
import { projectRugEntry } from "./rug-projections";
export async function projectProductionEntry(
  tx: Prisma.TransactionClient,
  entry: JournalEntry,
) {
  const namespace = /^(real-(?:paper|live-dry-run|live|observation)):/.exec(
    entry.id,
  )?.[1];
  if (!namespace) return;
  if (entry.kind.startsWith("rug.")) {
    await projectRugEntry(tx, entry, namespace);
    return;
  }
  const id = (value: string) => `${namespace}:${value}`;
  const at = new Date(entry.createdAt);
  if (entry.kind === "real.pool" || entry.kind === "real.discovery") {
    const value = z
      .object({
        chainId: z.string(),
        tokenAddress: z.string(),
        poolAddress: z.string(),
        dexId: z.string(),
      })
      .parse(entry.payload);
    if (entry.kind === "real.pool")
      await tx.pool.upsert({
        where: {
          id: id(`${value.chainId}:${value.dexId}:${value.poolAddress}`),
        },
        create: {
          id: id(`${value.chainId}:${value.dexId}:${value.poolAddress}`),
          ...value,
          payload: toJson(entry.payload),
          createdAt: at,
        },
        update: { payload: toJson(entry.payload) },
      });
    else
      await tx.tokenObservation.upsert({
        where: { id: entry.id },
        create: {
          id: entry.id,
          ...value,
          payload: toJson(entry.payload),
          createdAt: at,
        },
        update: { payload: toJson(entry.payload) },
      });
    return;
  }
  if (entry.kind === "real.candidate") {
    await projectCommit(
      tx,
      { candidate: entry.payload },
      entry.id,
      entry.createdAt,
      namespace === "real-paper" || namespace === "real-observation"
        ? "PAPER"
        : namespace === "real-live"
          ? "LIVE"
          : "LIVE_DRY_RUN",
    );
    return;
  }
  if (entry.kind === "real.outcome") {
    await projectCommit(
      tx,
      { outcomes: [entry.payload] },
      entry.id,
      entry.createdAt,
    );
    return;
  }
  if (entry.kind === "position.atomic" || entry.kind === "position.mark") {
    const raw =
      entry.kind === "position.atomic"
        ? z.object({ position: managedPositionSchema }).parse(entry.payload)
            .position
        : managedPositionSchema.parse(entry.payload);
    await projectCommit(tx, { positions: [raw] }, entry.id, entry.createdAt);
    return;
  }
  if (entry.kind === "wallet.public" || entry.kind === "wallet.balance") return;
  if (entry.kind === "execution.intent") {
    const value = approvedIntentSchema.parse(entry.payload);
    await tx.tradeIntent.upsert({
      where: { id: id(value.id) },
      create: {
        id: id(value.id),
        namespace,
        walletId: value.walletId,
        chainId: value.chainId,
        idempotencyKey: value.idempotencyKey,
        mode: value.mode,
        side: value.side,
        payload: toJson(value),
        createdAt: new Date(value.createdAt),
        expiresAt: new Date(value.expiresAt),
      },
      update: {},
    });
    const q = value.route.quote;
    await tx.tradeQuote.upsert({
      where: { id: id(q.id) },
      create: {
        id: id(q.id),
        chainId: q.chainId,
        tokenAddress: value.side === "BUY" ? q.tokenOut : q.tokenIn,
        payload: toJson(q),
        createdAt: new Date(q.quotedAt),
      },
      update: { payload: toJson(q) },
    });
    return;
  }
  if (entry.kind === "execution.record") {
    const value = z
      .object({
        id: z.string(),
        intentId: z.string(),
        walletId: z.string(),
        chainId: z.string(),
        idempotencyKey: z.string(),
        mode: z.string(),
        state: z.string(),
        transactionId: z.string().optional(),
        operation: z.string().optional(),
        updatedAt: z.number(),
      })
      .parse(entry.payload);
    const data = {
      namespace,
      intentId: value.intentId,
      walletId: value.walletId,
      chainId: value.chainId,
      idempotencyKey: value.idempotencyKey,
      mode: value.mode,
      state: value.state,
      transactionId: value.transactionId,
      payload: toJson(entry.payload),
      updatedAt: new Date(value.updatedAt),
    };
    await tx.execution.upsert({
      where: { id: id(value.id) },
      create: { id: id(value.id), ...data },
      update: data,
    });
    if (value.operation === "APPROVAL") {
      const approval = {
        namespace,
        intentId: value.intentId,
        walletId: value.walletId,
        chainId: value.chainId,
        state: value.state,
        transactionId: value.transactionId,
        payload: toJson(entry.payload),
        updatedAt: new Date(value.updatedAt),
      };
      await tx.approvalTransaction.upsert({
        where: { id: id(value.id) },
        create: { id: id(value.id), ...approval },
        update: approval,
      });
    }
    if (value.transactionId) {
      const tid = id(`${value.chainId}:${value.transactionId}`);
      await tx.transaction.upsert({
        where: { id: tid },
        create: {
          id: tid,
          chainId: value.chainId,
          payload: toJson(entry.payload),
          createdAt: at,
        },
        update: { payload: toJson(entry.payload) },
      });
    }
    return;
  }
  if (entry.kind === "creator.relationship") {
    const value = z
      .object({
        chainId: z.string(),
        tokenAddress: z.string(),
        creatorAddress: z.string(),
        evidence: z.string(),
        observedAt: z.number(),
      })
      .parse(entry.payload);
    const rid = id(`${value.chainId}:${value.tokenAddress}:${value.evidence}`);
    const data = {
      namespace,
      ...value,
      observedAt: new Date(value.observedAt),
      payload: toJson(entry.payload),
    };
    await tx.creatorTokenRelationship.upsert({
      where: { id: rid },
      create: { id: rid, ...data },
      update: data,
    });
    const pid = id(`${value.chainId}:${value.creatorAddress}`);
    await tx.creatorProfile.upsert({
      where: { id: pid },
      create: {
        id: pid,
        namespace,
        chainId: value.chainId,
        creatorAddress: value.creatorAddress,
        payload: toJson(entry.payload),
        updatedAt: at,
      },
      update: { payload: toJson(entry.payload), updatedAt: at },
    });
    return;
  }
  if (entry.kind === "provider.health") {
    const value = z
      .object({ id: z.string(), status: z.string(), checkedAt: z.number() })
      .parse(entry.payload);
    await tx.providerHealth.create({
      data: {
        id: entry.id,
        namespace,
        chainId: entry.chainId,
        providerId: value.id,
        status: value.status,
        payload: toJson(entry.payload),
        checkedAt: new Date(value.checkedAt),
      },
    });
    return;
  }
  if (entry.kind === "discovery.cursor") {
    const value = z
      .object({ key: z.string(), value: z.string() })
      .parse(entry.payload);
    const data = {
      namespace,
      key: value.key,
      value: value.value,
      updatedAt: at,
    };
    await tx.discoveryCursor.upsert({
      where: { id: id(value.key) },
      create: { id: id(value.key), ...data },
      update: data,
    });
    return;
  }
  if (entry.kind === "real.control") {
    const value = z
      .object({ entryDisabled: z.boolean(), allTradingDisabled: z.boolean() })
      .parse(entry.payload);
    for (const [scope, active] of [
      ["ENTRY_DISABLED", value.entryDisabled],
      ["ALL_TRADING_DISABLED", value.allTradingDisabled],
    ] as const)
      await tx.killSwitchEvent.create({
        data: {
          id: `${entry.id}:${scope}`,
          namespace,
          scope,
          active,
          payload: toJson({ scope, active }),
          createdAt: at,
        },
      });
    return;
  }
  if (["real.market", "ai.telemetry"].includes(entry.kind)) {
    const value = z
      .object({
        chainId: z.string().optional(),
        tokenAddress: z.string().optional(),
        provider: z.string().optional(),
      })
      .parse(entry.payload);
    await tx.pipelineObservation.create({
      data: {
        id: entry.id,
        namespace,
        chainId: entry.chainId ?? value.chainId ?? "UNKNOWN",
        tokenAddress: entry.tokenAddress ?? value.tokenAddress,
        providerId: value.provider,
        kind: entry.kind,
        payload: toJson(entry.payload),
        observedAt: at,
      },
    });
  }
}
