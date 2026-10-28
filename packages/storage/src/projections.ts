import { Prisma } from "../generated/client/client";
import { z } from "zod";
import { tokenStateSchema } from "@sniper/core";
const dimensions = z.object({
  chainId: z.string(),
  tokenAddress: z.string().optional(),
  poolAddress: z.string().optional(),
  dexId: z.string().optional(),
  strategyId: z.string().optional(),
});
const projectionSchema = z.object({
  candidate: z
    .object({
      id: z.string(),
      createdAt: z.number(),
      event: dimensions.extend({
        tokenAddress: z.string(),
        poolAddress: z.string(),
        dexId: z.string(),
      }),
      state: tokenStateSchema.optional(),
      ai: z.unknown().optional(),
      score: z.unknown().optional(),
      strategy: z.object({ strategyId: z.string() }).passthrough().optional(),
      risk: z.unknown().optional(),
      quote: z.object({ dexId: z.string() }).passthrough().optional(),
      action: z.enum(["BUY", "SKIP", "REJECT"]),
    })
    .passthrough()
    .optional(),
  positions: z
    .array(
      dimensions.extend({ id: z.string(), openedAt: z.number() }).passthrough(),
    )
    .optional(),
  outcomes: z
    .array(
      dimensions
        .extend({ candidateId: z.string(), createdAt: z.number() })
        .passthrough(),
    )
    .optional(),
  event: dimensions
    .partial()
    .extend({
      id: z.string(),
      type: z.string(),
      positionId: z.string().optional(),
    })
    .passthrough()
    .optional(),
  events: z
    .array(
      dimensions
        .partial()
        .extend({
          id: z.string(),
          type: z.string(),
          positionId: z.string().optional(),
        })
        .passthrough(),
    )
    .optional(),
});
export const toJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
interface ProjectionWrite {
  where: { id: string };
  create: {
    id: string;
    chainId: string;
    tokenAddress?: string;
    poolAddress?: string;
    dexId?: string;
    strategyId?: string;
    payload: Prisma.InputJsonValue;
    createdAt: Date;
  };
  update: { payload: Prisma.InputJsonValue };
}
export async function projectCommit(
  tx: Prisma.TransactionClient,
  payload: unknown,
  entryId: string,
  createdAt: number,
  executionMode: "PAPER" | "LIVE_DRY_RUN" | "LIVE" = "PAPER",
) {
  const commit = projectionSchema.parse(payload);
  const writers = {
    chain: (a: ProjectionWrite) => tx.chain.upsert(a),
    dex: (a: ProjectionWrite) => tx.dex.upsert(a),
    token: (a: ProjectionWrite) => tx.token.upsert(a),
    pool: (a: ProjectionWrite) => tx.pool.upsert(a),
    tokenObservation: (a: ProjectionWrite) => tx.tokenObservation.upsert(a),
    featureSnapshot: (a: ProjectionWrite) => tx.featureSnapshot.upsert(a),
    securityAnalysis: (a: ProjectionWrite) => tx.securityAnalysis.upsert(a),
    aiClassification: (a: ProjectionWrite) => tx.aIClassification.upsert(a),
    strategyDecision: (a: ProjectionWrite) => tx.strategyDecision.upsert(a),
    riskDecision: (a: ProjectionWrite) => tx.riskDecision.upsert(a),
    tradeQuote: (a: ProjectionWrite) => tx.tradeQuote.upsert(a),
    paperOrder: (a: ProjectionWrite) => tx.paperOrder.upsert(a),
    order: (a: ProjectionWrite) => tx.order.upsert(a),
    position: (a: ProjectionWrite) => tx.position.upsert(a),
    positionEvent: (a: ProjectionWrite) => tx.positionEvent.upsert(a),
    marketSnapshot: (a: ProjectionWrite) => tx.marketSnapshot.upsert(a),
    strategyRun: (a: ProjectionWrite) => tx.strategyRun.upsert(a),
    tokenOutcome: (a: ProjectionWrite) => tx.tokenOutcome.upsert(a),
  };
  const put = async (
    model: keyof typeof writers,
    id: string,
    dims: z.infer<typeof dimensions>,
    data: unknown,
    time = createdAt,
  ) => {
    const json = toJson(data);
    await writers[model]({
      where: { id },
      create: { id, ...dims, payload: json, createdAt: new Date(time) },
      update: { payload: json },
    });
  };
  if (commit.candidate) {
    const c = commit.candidate;
    const dims = { ...c.event, strategyId: c.strategy?.strategyId };
    // Chỉ dùng cột đã khai báo; mã sự kiện/thời gian nằm trong dữ liệu chi tiết, không tự tạo cột SQL.
    const d = {
      chainId: dims.chainId,
      tokenAddress: dims.tokenAddress,
      poolAddress: dims.poolAddress,
      dexId: dims.dexId,
      strategyId: dims.strategyId,
    };
    await put(
      "chain",
      d.chainId,
      { chainId: d.chainId },
      { id: d.chainId, source: c.state?.identity.source ?? "UNKNOWN" },
    );
    await put("dex", `${d.chainId}/${d.dexId}`, d, {
      id: d.dexId,
      source: c.state?.identity.source ?? "UNKNOWN",
    });
    await put(
      "token",
      `${d.chainId}/${d.tokenAddress}`,
      d,
      c.state?.identity ?? c.event,
    );
    await put("pool", `${d.chainId}/${d.poolAddress}`, d, c.event);
    await put("tokenObservation", c.id, d, c, c.createdAt);
    await put("strategyRun", c.id, d, c, c.createdAt);
    if (c.state) {
      await put("featureSnapshot", c.id, d, c.state, c.createdAt);
      await put("securityAnalysis", c.id, d, c.state.security, c.createdAt);
    }
    if (c.ai !== undefined)
      await put("aiClassification", c.id, d, c.ai, c.createdAt);
    if (c.strategy)
      await put("strategyDecision", c.id, d, c.strategy, c.createdAt);
    if (c.risk !== undefined)
      await put("riskDecision", c.id, d, c.risk, c.createdAt);
    if (c.quote)
      await put(
        "tradeQuote",
        c.id,
        { ...d, dexId: c.quote.dexId },
        c.quote,
        c.createdAt,
      );
    if (c.action === "BUY")
      await put(
        executionMode === "PAPER" ? "paperOrder" : "order",
        c.id,
        d,
        c,
        c.createdAt,
      );
  }
  for (const position of commit.positions ?? []) {
    const d = dimensions.parse(position);
    await put("position", position.id, d, position, position.openedAt);
    await put("marketSnapshot", `${entryId}/${position.id}`, d, position);
  }
  for (const outcome of commit.outcomes ?? [])
    await put(
      "tokenOutcome",
      outcome.candidateId,
      dimensions.parse(outcome),
      outcome,
      outcome.createdAt,
    );
  if (commit.event?.positionId)
    await put(
      "positionEvent",
      commit.event.id,
      {
        chainId: commit.event.chainId ?? "UNKNOWN",
        tokenAddress: commit.event.tokenAddress,
      },
      commit.event,
    );
  for (const event of commit.events ?? [])
    if (event.positionId)
      await put(
        "positionEvent",
        event.id,
        {
          chainId: event.chainId ?? "UNKNOWN",
          tokenAddress: event.tokenAddress,
        },
        event,
      );
}
