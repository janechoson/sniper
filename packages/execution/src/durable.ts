import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  approvedIntentSchema,
  type ApprovedTradeIntent,
  type ExecutionRecord,
} from "@sniper/core";
import { KeyedLock } from "@sniper/shared";
import type { Repository } from "@sniper/storage";
export const executionRecordSchema = z
  .object({
    id: z.string(),
    intentId: z.string(),
    idempotencyKey: z.string(),
    walletId: z.string(),
    chainId: z.string(),
    mode: z.enum(["PAPER", "LIVE_DRY_RUN", "LIVE"]),
    state: z.enum([
      "APPROVED",
      "BUILDING",
      "SIMULATING",
      "DRY_RUN_SUCCEEDED",
      "SUBMITTING",
      "PENDING",
      "CONFIRMED",
      "FAILED",
      "UNKNOWN",
    ]),
    updatedAt: z.number(),
    transactionId: z.string().optional(),
    approvalTransactionIds: z.array(z.string()).optional(),
    actualAmountIn: z.string().regex(/^\d+$/).optional(),
    actualAmountOut: z.string().regex(/^\d+$/).optional(),
    networkFee: z.string().regex(/^\d+$/).optional(),
    operation: z.enum(["SWAP", "APPROVAL"]).optional(),
    stages: z.record(z.string(), z.number().finite()).optional(),
    approval: z
      .object({
        token: z.string(),
        spender: z.string(),
        amount: z.string().regex(/^\d+$/),
      })
      .optional(),
    simulation: z
      .object({
        amountIn: z.string().regex(/^\d+$/),
        amountOut: z.string().regex(/^\d+$/),
        evidence: z.enum(["CALL_RETURN", "BALANCE_DELTA"]),
      })
      .optional(),
    reasons: z.array(z.string()),
  })
  .strict();
export class DurableExecutionStore {
  readonly lock = new KeyedLock();
  private readonly writes = new KeyedLock();
  private records = new Map<string, ExecutionRecord>();
  private intents = new Map<string, ApprovedTradeIntent>();
  constructor(private readonly repository: Repository) {}
  async restore() {
    for (const row of await this.repository.read()) {
      if (row.kind === "execution.intent") {
        const intent = approvedIntentSchema.parse(row.payload);
        this.intents.set(intent.id, intent);
      }
      if (row.kind === "execution.record") {
        const record = executionRecordSchema.parse(row.payload);
        this.records.set(record.idempotencyKey, record);
      }
    }
  }
  intent(id: string) {
    const value = this.intents.get(id);
    return value ? structuredClone(value) : undefined;
  }
  get(key: string) {
    const value = this.records.get(key);
    return value ? structuredClone(value) : undefined;
  }
  all() {
    return [...this.records.values()].map((value) => structuredClone(value));
  }
  async put(record: ExecutionRecord) {
    return this.writes.run(record.idempotencyKey, async () => {
      const currentRecord = this.records.get(record.idempotencyKey);
      const value = executionRecordSchema.parse({
        ...record,
        stages: {
          ...currentRecord?.stages,
          ...record.stages,
          [record.state]: currentRecord?.stages?.[record.state] ?? Date.now(),
        },
      });
      const current = this.records.get(value.idempotencyKey);
      if (
        current &&
        (current.id !== value.id ||
          current.intentId !== value.intentId ||
          (current.transactionId &&
            value.transactionId &&
            current.transactionId !== value.transactionId))
      )
        throw new Error("EXECUTION_IDENTITY_CONFLICT");
      if (current && ["CONFIRMED", "FAILED"].includes(current.state))
        return structuredClone(current);
      await this.repository.append({
        id: randomUUID(),
        kind: "execution.record",
        chainId: value.chainId,
        payload: value,
        createdAt: Date.now(),
      });
      this.records.set(value.idempotencyKey, structuredClone(value));
      return value;
    });
  }
  async begin(intent: ApprovedTradeIntent) {
    const old = this.get(intent.idempotencyKey);
    if (old) return old;
    const safe = approvedIntentSchema.parse(intent);
    await this.repository.append({
      id: randomUUID(),
      kind: "execution.intent",
      chainId: intent.chainId,
      payload: safe,
      createdAt: Date.now(),
    });
    this.intents.set(intent.id, safe);
    return this.put({
      id: randomUUID(),
      intentId: intent.id,
      idempotencyKey: intent.idempotencyKey,
      walletId: intent.walletId,
      chainId: intent.chainId,
      mode: intent.mode,
      state: "APPROVED",
      updatedAt: Date.now(),
      reasons: [],
    });
  }
}
