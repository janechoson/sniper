import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { sqliteAtomic } from "./learning-database.js";

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
  validationStatus: z.enum(["DRAFT", "VALIDATING", "NEEDS_MORE_DATA", "VALIDATED", "REJECTED", "DISABLED", "DELETED"]),
  validationId: z.string().optional(), validationMetrics: z.record(z.string(), z.unknown()).optional(),
  rejectionReason: z.string().max(1000).optional(),
  provenance: z.array(z.object({ caseId: z.string(), mode: z.enum(["demo", "live"]), accountId: z.string(), simulated: z.boolean() }).strict()).max(200).optional(),
  createdAt: z.number().int().positive(), updatedAt: z.number().int().positive(),
}).strict();
export type TradingKnowledge = z.infer<typeof tradingKnowledgeSchema>;
type ControlAction = "DISABLE" | "REJECT" | "DELETE" | "RESTORE" | "SUSPEND";
const tokens = (item: Pick<TradingKnowledge, "title" | "description" | "category" | "applicableStage" | "observedBehaviors">) =>
  [...new Set(`${item.category} ${item.applicableStage} ${item.title} ${item.description} ${item.observedBehaviors.join(" ")}`.toLowerCase().match(/[a-z0-9_]+/g) ?? [])].sort();
export function knowledgeFingerprint(item: Pick<TradingKnowledge, "title" | "description" | "category" | "applicableStage" | "observedBehaviors">) {
  return createHash("sha256").update(JSON.stringify(tokens(item))).digest("hex");
}
function jaccard(left: string[], right: string[]) {
  const a = new Set(left), b = new Set(right), intersection = [...a].filter((term) => b.has(term)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

/** Immutable knowledge versions and append-only user/system controls share the Learning DB. */
export class ChartKnowledgeRepository {
  constructor(private db: DatabaseSync) {}
  revision() {
    return Number(this.db.prepare("SELECT (SELECT count(*) FROM chart_knowledge_versions)+(SELECT count(*) FROM chart_knowledge_control_events) n").get()!.n);
  }
  latestControl(id: string) {
    return this.db.prepare("SELECT * FROM chart_knowledge_control_events WHERE knowledge_id=? ORDER BY at DESC,rowid DESC LIMIT 1").get(id) as { action: ControlAction; reason: string; actor: string; at: number; fingerprint: string } | undefined;
  }
  controlState(id: string) {
    const action = this.latestControl(id)?.action;
    return action === "DISABLE" || action === "SUSPEND" ? "DISABLED" : action === "DELETE" ? "DELETED" : action === "REJECT" ? "REJECTED" : null;
  }
  isSuppressed(item: Pick<TradingKnowledge, "title" | "description" | "category" | "applicableStage" | "observedBehaviors">) {
    const signature = knowledgeFingerprint(item), candidateTerms = tokens(item);
    const history = this.db.prepare("SELECT action,fingerprint,payload FROM chart_knowledge_control_events WHERE action IN ('REJECT','DELETE','RESTORE') ORDER BY at DESC,rowid DESC LIMIT 2000").all() as { action: ControlAction; fingerprint: string; payload: string }[];
    const latest = new Map<string, { action: ControlAction; payload: string }>();
    for (const row of history) if (!latest.has(row.fingerprint)) latest.set(row.fingerprint, row);
    for (const [fingerprint, row] of latest) {
      if (row.action !== "REJECT" && row.action !== "DELETE") continue;
      let payload: { category?: string; applicableStage?: string; terms?: string[] } = {};
      try { payload = JSON.parse(row.payload); } catch { continue; }
      if (payload.category !== item.category || payload.applicableStage !== item.applicableStage) continue;
      const score = fingerprint === signature ? 1 : jaccard(candidateTerms, payload.terms ?? []);
      if (score >= 0.8) return { fingerprint, action: row.action, similarity: score };
    }
    return null;
  }
  validatedPreBuy() {
    return this.db.prepare(`SELECT k.payload FROM chart_knowledge_versions k
      WHERE k.applicable_stage='PRE_BUY' AND k.status='VALIDATED'
      AND NOT EXISTS (SELECT 1 FROM chart_knowledge_versions newer WHERE newer.id=k.id AND newer.version>k.version)
      AND coalesce((SELECT c.action FROM chart_knowledge_control_events c WHERE c.knowledge_id=k.id ORDER BY c.at DESC,c.rowid DESC LIMIT 1),'RESTORE')='RESTORE'
      ORDER BY k.updated_at DESC LIMIT 100`)
      .all().map((row: any) => tradingKnowledgeSchema.parse(JSON.parse(String(row.payload))));
  }
  createDraft(input: Omit<TradingKnowledge, "version" | "validationStatus" | "createdAt" | "updatedAt" | "validationId" | "validationMetrics">) {
    const now = Date.now(), initial = tradingKnowledgeSchema.parse({ ...input, version: 1, validationStatus: "DRAFT", createdAt: now, updatedAt: now });
    const suppressed = this.isSuppressed(initial);
    if (suppressed) throw Error(`KNOWLEDGE_SUPPRESSED_BY_USER:${suppressed.action}:${suppressed.similarity.toFixed(2)}`);
    const sourceTerms = new Set(tokens(initial));
    const draftRows=this.db.prepare("SELECT payload FROM chart_knowledge_versions WHERE status='DRAFT' AND category=? AND applicable_stage=? AND NOT EXISTS (SELECT 1 FROM chart_knowledge_versions n WHERE n.id=chart_knowledge_versions.id AND n.version>chart_knowledge_versions.version) ORDER BY updated_at DESC LIMIT 50").all(initial.category,initial.applicableStage) as {payload:string}[];
    let mergeTarget:TradingKnowledge|undefined, mergeScore=0;
    for(const row of draftRows){const candidate=tradingKnowledgeSchema.parse(JSON.parse(row.payload)), score=jaccard([...sourceTerms],tokens(candidate));if(score>mergeScore){mergeScore=score;mergeTarget=candidate;}}
    if(mergeTarget&&mergeScore>=0.45){
      const merged=tradingKnowledgeSchema.parse({...mergeTarget,version:mergeTarget.version+1,updatedAt:now,
        observedBehaviors:[...new Set([...mergeTarget.observedBehaviors,...initial.observedBehaviors])].slice(0,20),
        variations:[...new Set([...mergeTarget.variations,...initial.variations,`Merged similar DRAFT ${initial.title} (lexical overlap ${mergeScore.toFixed(2)}).`])].slice(0,20),
        supportingIndicators:[...new Set([...mergeTarget.supportingIndicators,...initial.supportingIndicators])].slice(0,20),
        counterexamples:[...new Set([...mergeTarget.counterexamples,...initial.counterexamples])].slice(0,20),
        supportingCaseIds:[...new Set([...mergeTarget.supportingCaseIds,...initial.supportingCaseIds])].slice(0,100),
        contradictoryCaseIds:[...new Set([...mergeTarget.contradictoryCaseIds,...initial.contradictoryCaseIds])].slice(0,100),
        validationId:undefined,validationMetrics:undefined});
      const value=tradingKnowledgeSchema.parse({...merged,provenance:this.provenance(merged)});
      this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'DRAFT',?,?,?)").run(value.id,value.version,value.category,value.applicableStage,value.createdAt,now,JSON.stringify(value));
      return value;
    }
    const value = tradingKnowledgeSchema.parse({ ...initial, provenance: this.provenance(initial) });
    this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'DRAFT',?,?,?)")
      .run(value.id, value.version, value.category, value.applicableStage, now, now, JSON.stringify(value));
    return value;
  }
  private provenance(item: TradingKnowledge) {
    const ids=[...new Set([...item.supportingCaseIds,...item.contradictoryCaseIds])];
    return ids.length ? this.db.prepare(`SELECT position_id,mode,account_id,payload FROM chart_learning_cases WHERE position_id IN (${ids.map(()=>"?").join(",")})`).all(...ids).map((row:any)=>({caseId:String(row.position_id),mode:String(row.mode),accountId:String(row.account_id),simulated:JSON.parse(String(row.payload)).simulated===true})) : [];
  }
  validateDraft(id: string, version: number, validationCaseIds: string[], approved: boolean) {
    void id; void version; void validationCaseIds; void approved;
    throw Error("KNOWLEDGE_AUTOMATIC_VALIDATION_ONLY");
  }
  recordControl(id: string, version: number, action: ControlAction, reason: string, actor: "USER" | "SYSTEM" = "USER") {
    const cleanReason=reason.trim().slice(0,1000);
    if(!cleanReason)throw Error("KNOWLEDGE_CONTROL_REASON_REQUIRED");
    const row=this.db.prepare("SELECT payload FROM chart_knowledge_versions WHERE id=? AND version=?").get(id,version) as {payload:string}|undefined;
    if(!row)throw Error("KNOWLEDGE_VERSION_NOT_FOUND");
    const item=tradingKnowledgeSchema.parse(JSON.parse(row.payload)), fingerprint=knowledgeFingerprint(item), now=Date.now(), eventId=randomUUID();
    sqliteAtomic(this.db,()=>this.db.prepare("INSERT INTO chart_knowledge_control_events(id,knowledge_id,knowledge_version,action,actor,reason,fingerprint,at,payload) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(eventId,id,version,action,actor,cleanReason,fingerprint,now,JSON.stringify({terms:tokens(item),category:item.category,applicableStage:item.applicableStage})));
    return {id:eventId,knowledgeId:id,version,action,actor,reason:cleanReason,fingerprint,at:now};
  }
  disable(id:string,version:number,reason="Disabled by user"){return this.recordControl(id,version,"DISABLE",reason);}
  reject(id:string,version:number,reason:string){return this.recordControl(id,version,"REJECT",reason);}
  delete(id:string,version:number,reason="Deleted by user"){return this.recordControl(id,version,"DELETE",reason);}
  restore(id:string,version:number,reason="Restored by user"){return this.recordControl(id,version,"RESTORE",reason);}
  rejectDraft(id: string, version: number, reason: string) { return this.reject(id,version,reason); }
  all(limit = 100) {
    const rows=this.db.prepare(`SELECT k.payload,k.id,k.version,k.status FROM chart_knowledge_versions k WHERE NOT EXISTS (SELECT 1 FROM chart_knowledge_versions newer WHERE newer.id=k.id AND newer.version>k.version) ORDER BY k.updated_at DESC LIMIT ?`).all(Math.max(1,Math.min(500,limit))) as {payload:string;id:string;version:number;status:string}[];
    return rows.map((row)=>{
      const item=tradingKnowledgeSchema.parse(JSON.parse(row.payload)), control=this.latestControl(String(row.id));
      let validationStatus=control ? this.controlState(String(row.id)) ?? item.validationStatus : item.validationStatus;
      const job=this.db.prepare(`SELECT state,error,report FROM chart_validation_jobs WHERE knowledge_id=? AND knowledge_version ${row.status==="DRAFT"?"=":"<"} ? ORDER BY knowledge_version DESC,requested_at DESC,rowid DESC LIMIT 1`).get(row.id,row.version) as {state:string;error:string|null;report:string|null}|undefined;
      if(!control&&item.validationStatus==="DRAFT"&&(job?.state==="PENDING"||job?.state==="RUNNING"))validationStatus="VALIDATING";
      if(!control&&item.validationStatus==="DRAFT"&&job?.report){const report=JSON.parse(job.report);if(report.lifecycleState==="NEEDS_MORE_DATA")validationStatus="NEEDS_MORE_DATA";}
      return {...item,validationStatus,controlReason:control?.reason??null,controlAction:control?.action??null,latestValidation:job?.report?JSON.parse(job.report):null,latestValidationError:job?.error??null};
    });
  }
  detail(id:string) {
    const current=this.all(500).find((item)=>item.id===id);if(!current)throw Error("KNOWLEDGE_NOT_FOUND");
    const versions=this.db.prepare("SELECT version,status,created_at,updated_at,payload FROM chart_knowledge_versions WHERE id=? ORDER BY version DESC LIMIT 100").all(id).map((row:any)=>({version:Number(row.version),status:String(row.status),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),knowledge:tradingKnowledgeSchema.parse(JSON.parse(String(row.payload)))}));
    const validations=this.db.prepare("SELECT id,knowledge_version,at,training_case_ids,validation_case_ids,metrics,payload FROM chart_knowledge_validations WHERE knowledge_id=? ORDER BY at DESC LIMIT 100").all(id).map((row:any)=>({...row,trainingCaseIds:JSON.parse(row.training_case_ids),validationCaseIds:JSON.parse(row.validation_case_ids),metrics:JSON.parse(row.metrics),report:JSON.parse(row.payload)}));
    const supportingTrades=this.db.prepare(`SELECT c.position_id,c.mint,c.mode,c.account_id,c.buy_confirmed_at,c.realized_pnl_pct,c.payload FROM chart_learning_cases c WHERE c.position_id IN (${[...new Set([...current.supportingCaseIds,...current.contradictoryCaseIds])].map(()=>"?").join(",")||"NULL"})`).all(...[...new Set([...current.supportingCaseIds,...current.contradictoryCaseIds])]);
    const decisions=this.db.prepare(`SELECT DISTINCT d.id,d.at,d.action,d.runtime_outcome,d.payload FROM chart_ai_guard_decisions d,json_each(d.payload,'$.matchedKnowledge') m WHERE json_extract(m.value,'$.knowledgeId')=? ORDER BY d.at DESC LIMIT 200`).all(id);
    const controls=this.db.prepare("SELECT id,knowledge_version,action,actor,reason,fingerprint,at FROM chart_knowledge_control_events WHERE knowledge_id=? ORDER BY at DESC LIMIT 200").all(id);
    const drift=this.db.prepare("SELECT knowledge_version,count(*) sample_count,sum(dangerous) dangerous_count,max(observed_at) latest_at FROM chart_knowledge_drift_cases WHERE knowledge_id=? GROUP BY knowledge_version ORDER BY knowledge_version DESC LIMIT 20").all(id);
    return {knowledge:current,versions,validations,supportingTrades,matchedDecisions:decisions.map((row:any)=>({...row,payload:JSON.parse(String(row.payload))})),controls,drift};
  }
}
