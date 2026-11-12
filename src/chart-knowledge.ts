import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

export const tradingKnowledgeSchema = z.object({
  id: z.string().min(1).max(160), version: z.number().int().positive(),
  title: z.string().min(1).max(160),
  category: z.enum(["RUG_RISK", "DISTRIBUTION", "MOMENTUM", "LIQUIDITY", "ENTRY_RISK", "EXIT_RISK", "OTHER"]),
  applicableStage: z.enum(["PRE_BUY", "POST_BUY"]),
  description: z.string().min(1).max(4000), marketContext: z.string().max(2000),
  observedBehaviors: z.array(z.string().max(500)).max(20),
  variations: z.array(z.string().max(500)).max(20),
  supportingIndicators: z.array(z.string().max(500)).max(20),
  counterexamples: z.array(z.string().max(500)).max(20),
  invalidationConditions: z.array(z.string().max(500)).max(20),
  supportingCaseIds: z.array(z.string().max(160)).max(100),
  contradictoryCaseIds: z.array(z.string().max(160)).max(100),
  validationStatus: z.enum(["DRAFT", "VALIDATED", "REJECTED"]),
  validationId: z.string().optional(), validationMetrics: z.record(z.string(), z.unknown()).optional(),
  rejectionReason: z.string().max(1000).optional(),
  provenance: z.array(z.object({ caseId: z.string(), mode: z.enum(["demo", "live"]), accountId: z.string(), simulated: z.boolean() }).strict()).max(200).optional(),
  createdAt: z.number().int().positive(), updatedAt: z.number().int().positive(),
}).strict();
export type TradingKnowledge = z.infer<typeof tradingKnowledgeSchema>;

export class ChartKnowledgeRepository {
  constructor(private db: DatabaseSync) {}
  revision() {
    return Number(this.db.prepare("SELECT coalesce(max(rowid),0) n FROM chart_knowledge_versions").get()!.n);
  }
  validatedPreBuy() {
    return this.db.prepare(`SELECT k.payload FROM chart_knowledge_versions k WHERE k.applicable_stage='PRE_BUY' AND k.status='VALIDATED' AND NOT EXISTS (SELECT 1 FROM chart_knowledge_versions newer WHERE newer.id=k.id AND newer.version>k.version) ORDER BY k.updated_at DESC LIMIT 100`)
      .all().map((row: any) => tradingKnowledgeSchema.parse(JSON.parse(String(row.payload))));
  }
  createDraft(input: Omit<TradingKnowledge, "version" | "validationStatus" | "createdAt" | "updatedAt" | "validationId" | "validationMetrics">) {
    const now = Date.now(), initial = tradingKnowledgeSchema.parse({ ...input, version: 1, validationStatus: "DRAFT", createdAt: now, updatedAt: now });
    const provenanceIds = [...new Set([...initial.supportingCaseIds, ...initial.contradictoryCaseIds])];
    const provenance = provenanceIds.length ? this.db.prepare(`SELECT position_id,mode,account_id,payload FROM chart_learning_cases WHERE position_id IN (${provenanceIds.map(() => "?").join(",")})`).all(...provenanceIds).map((row: any) => ({ caseId: String(row.position_id), mode: String(row.mode), accountId: String(row.account_id), simulated: JSON.parse(String(row.payload)).simulated === true })) : [];
    const value = tradingKnowledgeSchema.parse({ ...initial, provenance });
    this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'DRAFT',?,?,?)")
      .run(value.id, value.version, value.category, value.applicableStage, now, now, JSON.stringify(value));
    return value;
  }
  validateDraft(id: string, version: number, validationCaseIds: string[], approved: boolean) {
    if (approved !== true) throw Error("KNOWLEDGE_VALIDATION_APPROVAL_REQUIRED");
    const current = this.db.prepare("SELECT payload FROM chart_knowledge_versions WHERE id=? AND version=? AND status='DRAFT'").get(id, version) as {payload:string}|undefined;
    if (!current) throw Error("KNOWLEDGE_DRAFT_NOT_FOUND");
    const draft = tradingKnowledgeSchema.parse(JSON.parse(current.payload));
    const ids = [...new Set(validationCaseIds.map(String))];
    if (ids.length < 3 || ids.length > 100 || ids.some((value) => !value || value.length > 160)) throw Error("KNOWLEDGE_VALIDATION_SAMPLE_INVALID");
    if (ids.some((caseId) => draft.supportingCaseIds.includes(caseId) || draft.contradictoryCaseIds.includes(caseId))) throw Error("KNOWLEDGE_VALIDATION_LEAKAGE");
    const rows = this.db.prepare(`SELECT position_id,mint,buy_confirmed_at,realized_pnl_pct,payload FROM chart_learning_cases WHERE status='CLOSED' AND position_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
    if (rows.length !== ids.length) throw Error("KNOWLEDGE_VALIDATION_CASE_UNAVAILABLE");
    if (new Set(rows.map((row) => String(row.mint))).size < 3) throw Error("KNOWLEDGE_VALIDATION_DISTINCT_MINTS_REQUIRED");
    const windows = rows.map((row) => { const payload = JSON.parse(String(row.payload)); return { start: Number(row.buy_confirmed_at), end: Number(payload.closedAt ?? row.buy_confirmed_at) }; });
    for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++)
      if (windows[i]!.start - 3600000 <= windows[j]!.end && windows[j]!.start - 3600000 <= windows[i]!.end) throw Error("KNOWLEDGE_VALIDATION_TIME_OVERLAP");
    const trainingIds = [...draft.supportingCaseIds, ...draft.contradictoryCaseIds];
    if (trainingIds.length) {
      const training = this.db.prepare(`SELECT mint,buy_confirmed_at,payload FROM chart_learning_cases WHERE position_id IN (${trainingIds.map(() => "?").join(",")})`).all(...trainingIds) as any[];
      if (training.length !== new Set(trainingIds).size) throw Error("KNOWLEDGE_TRAINING_CASE_UNAVAILABLE");
      for (const validation of rows) for (const train of training) {
        if (validation.mint === train.mint) throw Error("KNOWLEDGE_VALIDATION_SAME_MINT");
        const a = JSON.parse(String(validation.payload)), b = JSON.parse(String(train.payload));
        const validationStart = Number(validation.buy_confirmed_at), validationEnd = Number(a.closedAt ?? validation.buy_confirmed_at), trainingStart = Number(train.buy_confirmed_at), trainingEnd = Number(b.closedAt ?? train.buy_confirmed_at);
        if (validationStart - 3600000 <= trainingEnd && trainingStart - 3600000 <= validationEnd) throw Error("KNOWLEDGE_VALIDATION_TIME_OVERLAP");
      }
    }
    const pnl = rows.map((row) => Number(row.realized_pnl_pct)).filter(Number.isFinite);
    if (pnl.length !== rows.length) throw Error("KNOWLEDGE_VALIDATION_OUTCOME_MISSING");
    const metrics = { caseCount: rows.length, distinctMints: new Set(rows.map((row) => row.mint)).size, positiveCases: pnl.filter((value) => value > 0).length, negativeCases: pnl.filter((value) => value < 0).length, meanPnlPercent: pnl.reduce((sum, value) => sum + value, 0) / pnl.length };
    const validationId = randomUUID(), now = Date.now(), next = tradingKnowledgeSchema.parse({ ...draft, version: version + 1, validationStatus: "VALIDATED", validationId, validationMetrics: metrics, updatedAt: now });
    this.db.prepare("INSERT INTO chart_knowledge_validations VALUES(?,?,?,?,?,?,?,?)").run(validationId, id, version, now, JSON.stringify(trainingIds), JSON.stringify(ids), JSON.stringify(metrics), JSON.stringify({ approved: true, independentSplit: true }));
    this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'VALIDATED',?,?,?)").run(id, next.version, next.category, next.applicableStage, next.createdAt, now, JSON.stringify(next));
    return next;
  }
  rejectDraft(id: string, version: number, reason: string) {
    const cleanReason = reason.trim().slice(0, 1000);
    if (!cleanReason) throw Error("KNOWLEDGE_REJECTION_REASON_REQUIRED");
    const current = this.db.prepare("SELECT payload FROM chart_knowledge_versions WHERE id=? AND version=? AND status='DRAFT'").get(id, version) as {payload:string}|undefined;
    if (!current) throw Error("KNOWLEDGE_DRAFT_NOT_FOUND");
    const now = Date.now(), draft = tradingKnowledgeSchema.parse(JSON.parse(current.payload));
    const rejected = tradingKnowledgeSchema.parse({ ...draft, version: version + 1, validationStatus: "REJECTED", rejectionReason: cleanReason, updatedAt: now });
    this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'REJECTED',?,?,?)")
      .run(id, rejected.version, rejected.category, rejected.applicableStage, rejected.createdAt, now, JSON.stringify(rejected));
    return rejected;
  }
  all(limit = 100) {
    return this.db.prepare("SELECT payload FROM chart_knowledge_versions ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))).map((row: any) => tradingKnowledgeSchema.parse(JSON.parse(String(row.payload))));
  }
}
