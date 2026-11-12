import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { env } from "./config.js";
import { sqliteAtomic } from "./learning-database.js";
import { ChartKnowledgeRepository, tradingKnowledgeSchema, type TradingKnowledge } from "./chart-knowledge.js";
import type { ReasoningRuntime } from "./codex-runtime.js";
import { knowledgeReplayResponseSchema } from "./codex-ai-guard-contract.js";

type FrozenCase = { caseId:string; mint:string; mode:"demo"|"live"; accountId:string; simulated:boolean; buyAt:number; closedAt:number; pnlPct:number; dangerous:boolean; evidence:{id:string;at:number;availableAt:number;open:number;high:number;low:number;close:number;volumeUsd:number|null}[] };
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median=(xs:number[])=>{if(!xs.length)return null;const values=[...xs].sort((a,b)=>a-b),middle=Math.floor(values.length/2);return values.length%2?values[middle]!:(values[middle-1]!+values[middle]!)/2;};
function wilsonLower(successes:number,total:number){if(total<=0)return null;const z=1.6448536269514722,p=successes/total,z2=z*z,denominator=1+z2/total,center=p+z2/(2*total),margin=z*Math.sqrt((p*(1-p)+z2/(4*total))/total);return Math.max(0,(center-margin)/denominator);}

export function validationMetrics(rows:{prediction:"BLOCK"|"PASS"|"UNCERTAIN"|"ERROR";dangerous:boolean;pnlPct:number}[]){
  let TP=0,FP=0,TN=0,FN=0,abstentions=0;
  for(const row of rows){if(row.prediction==="UNCERTAIN"||row.prediction==="ERROR"){abstentions++;continue;}if(row.prediction==="BLOCK"&&row.dangerous)TP++;else if(row.prediction==="BLOCK")FP++;else if(row.dangerous)FN++;else TN++;}
  const rate=(n:number,d:number)=>d?n/d:null,answered=rows.length-abstentions;
  const predicted=(prediction:string)=>rows.filter((r)=>r.prediction===prediction).map((r)=>r.pnlPct);
  const group=(prediction:string)=>{const xs=predicted(prediction);return{count:xs.length,meanPnlPct:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,medianPnlPct:median(xs)};};
  return{TP,FP,TN,FN,sampleCount:rows.length,positiveClassCount:rows.filter((r)=>r.dangerous).length,negativeClassCount:rows.filter((r)=>!r.dangerous).length,
    precision:rate(TP,TP+FP),recall:rate(TP,TP+FN),specificity:rate(TN,TN+FP),falsePositiveRate:rate(FP,FP+TN),falseNegativeRate:rate(FN,FN+TP),
    precisionLower95:wilsonLower(TP,TP+FP),recallLower95:wilsonLower(TP,TP+FN),f1:rate(2*TP,2*TP+FP+FN),coverage:rate(answered,rows.length),abstentionRate:rate(abstentions,rows.length),abstentions,
    groups:{BLOCK:group("BLOCK"),PASS:group("PASS"),UNCERTAIN:group("UNCERTAIN"),ERROR:group("ERROR")}};
}

/** Offline, read-only holdout replay; it cannot create execution intents or access signers. */
export class ChartValidationEngine {
  private active?:Promise<void>;
  private stopped=false;
  constructor(private db:DatabaseSync,private runtime:ReasoningRuntime){
    const now=Date.now();
    this.db.prepare("UPDATE chart_validation_jobs SET state=CASE WHEN attempt_count>=3 THEN 'DEAD_LETTER' ELSE 'PENDING' END,next_attempt_at=?,error='INTERRUPTED_RESTART_RECOVERY' WHERE state='RUNNING'").run(now);
  }
  private frozenDataset(draft:TradingKnowledge){
    const trainingIds=[...new Set([...draft.supportingCaseIds,...draft.contradictoryCaseIds])];
    const training=trainingIds.length?this.db.prepare(`SELECT position_id,mint,buy_confirmed_at,payload FROM chart_learning_cases WHERE position_id IN (${trainingIds.map(()=>"?").join(",")})`).all(...trainingIds) as any[]:[];
    if(training.length!==new Set(trainingIds).size)throw Error("VALIDATION_TRAINING_CASE_MISSING");
    const trainingWindows=training.map((r)=>({mint:String(r.mint),start:Number(r.buy_confirmed_at),end:Number(JSON.parse(String(r.payload)).closedAt??r.buy_confirmed_at)}));
    const candidates=this.db.prepare("SELECT position_id,mint,mode,account_id,buy_confirmed_at,realized_pnl_pct,payload FROM chart_learning_cases WHERE status='CLOSED' ORDER BY updated_at DESC LIMIT 2000").all() as any[];
    const selected:FrozenCase[]=[],fingerprints=new Set<string>();
    for(const row of candidates){
      const caseId=String(row.position_id),mint=String(row.mint),buyAt=Number(row.buy_confirmed_at),payload=JSON.parse(String(row.payload)),closedAt=Number(payload.closedAt??buyAt),pnlPct=Number(row.realized_pnl_pct);
      if(!Number.isFinite(pnlPct)||draft.supportingCaseIds.includes(caseId)||draft.contradictoryCaseIds.includes(caseId))continue;
      if(trainingWindows.some((w)=>w.mint===mint||(buyAt-3600000<=w.end&&w.start-3600000<=closedAt)))continue;
      if(selected.some((w)=>w.mint===mint||(buyAt-3600000<=w.closedAt&&w.buyAt-3600000<=closedAt)))continue;
      const candles=this.db.prepare("SELECT c.id,c.at,c.available_at,ce.available_at evidence_available_at,c.payload FROM chart_case_evidence ce JOIN chart_candles c ON ce.evidence_type='CANDLE' AND ce.evidence_id=c.id WHERE ce.case_id=? AND ce.phase='PRE_BUY_CONTEXT' AND ce.available_at<=? AND c.available_at<=? AND c.at+60000<=? ORDER BY c.at LIMIT 120").all(caseId,buyAt,buyAt,buyAt).map((c:any)=>({id:String(c.id),at:Number(c.at),availableAt:Math.max(Number(c.available_at),Number(c.evidence_available_at)),...JSON.parse(String(c.payload))}));
      if(candles.length<10)continue;
      const fingerprint=hash(candles.map((c:any)=>[c.open,c.high,c.low,c.close,c.volumeUsd]));if(fingerprints.has(fingerprint))continue;fingerprints.add(fingerprint);
      const rug=Boolean(this.db.prepare("SELECT 1 FROM chart_case_evidence ce JOIN chart_events e ON ce.evidence_type='EVENT' AND ce.evidence_id=e.id WHERE ce.case_id=? AND ce.phase='POST_BUY_OBSERVATION' AND e.kind='RUG_30' AND e.at>=? AND e.at<=? LIMIT 1").get(caseId,buyAt,closedAt));
      selected.push({caseId,mint,mode:String(row.mode)==="live"?"live":"demo",accountId:String(row.account_id),simulated:payload.simulated===true,buyAt,closedAt,pnlPct,dangerous:pnlPct<=env.KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT||rug,evidence:candles.map((c:any)=>({id:c.id,at:c.at,availableAt:c.availableAt,open:c.open,high:c.high,low:c.low,close:c.close,volumeUsd:Number.isFinite(c.volumeUsd)?c.volumeUsd:null}))});
      if(selected.length>=200)break;
    }
    return selected;
  }
  private gates(metrics:ReturnType<typeof validationMetrics>,predictions:number){
    const limits={minCases:env.KNOWLEDGE_VALIDATION_MIN_CASES,minPositive:env.KNOWLEDGE_VALIDATION_MIN_POSITIVE,minNegative:env.KNOWLEDGE_VALIDATION_MIN_NEGATIVE,minPrecision:env.KNOWLEDGE_VALIDATION_MIN_PRECISION,minRecall:env.KNOWLEDGE_VALIDATION_MIN_RECALL,maxFalsePositiveRate:env.KNOWLEDGE_VALIDATION_MAX_FALSE_POSITIVE_RATE,maxAbstentionRate:env.KNOWLEDGE_VALIDATION_MAX_ABSTENTION_RATE,minPrecisionLower95:env.KNOWLEDGE_VALIDATION_MIN_PRECISION_LCB,minRecallLower95:env.KNOWLEDGE_VALIDATION_MIN_RECALL_LCB};
    const failures:string[]=[];
    if(metrics.sampleCount<limits.minCases)failures.push("MIN_INDEPENDENT_CASES");
    if(metrics.sampleCount!==predictions||metrics.TP+metrics.FP+metrics.TN+metrics.FN+metrics.abstentions!==metrics.sampleCount)failures.push("METRIC_INTEGRITY");
    if(metrics.positiveClassCount<limits.minPositive)failures.push("MIN_POSITIVE_CLASS");if(metrics.negativeClassCount<limits.minNegative)failures.push("MIN_NEGATIVE_CLASS");
    if(metrics.precision===null||metrics.precision<limits.minPrecision)failures.push("MIN_PRECISION");if(metrics.recall===null||metrics.recall<limits.minRecall)failures.push("MIN_RECALL");
    if(metrics.precisionLower95===null||metrics.precisionLower95<limits.minPrecisionLower95)failures.push("MIN_PRECISION_LOWER_95");if(metrics.recallLower95===null||metrics.recallLower95<limits.minRecallLower95)failures.push("MIN_RECALL_LOWER_95");
    if(metrics.falsePositiveRate===null||metrics.falsePositiveRate>limits.maxFalsePositiveRate)failures.push("MAX_FALSE_POSITIVE_RATE");if(metrics.abstentionRate===null||metrics.abstentionRate>limits.maxAbstentionRate)failures.push("MAX_ABSTENTION_RATE");
    return{limits,failures,passed:failures.length===0};
  }
  private monitorDrift(now:number){
    const repo=new ChartKnowledgeRepository(this.db);
    for(const item of repo.validatedPreBuy()){
      const training=new Set([...item.supportingCaseIds,...item.contradictoryCaseIds]);
      if(item.validationId){
        const row=this.db.prepare("SELECT training_case_ids,validation_case_ids FROM chart_knowledge_validations WHERE id=?").get(item.validationId) as {training_case_ids:string;validation_case_ids:string}|undefined;
        if(row)for(const id of [...JSON.parse(row.training_case_ids),...JSON.parse(row.validation_case_ids)])training.add(String(id));
      }
      const matches=this.db.prepare(`SELECT c.position_id,c.mint,c.mode,c.account_id,c.buy_confirmed_at,c.realized_pnl_pct,c.payload case_payload,d.id decision_id,d.at decision_at,d.payload decision_payload
        FROM chart_learning_cases c JOIN chart_ai_guard_decisions d ON d.mint=c.mint AND d.action='PASS' AND d.at<=c.buy_confirmed_at AND d.at>=c.buy_confirmed_at-600000
        JOIN json_each(d.payload,'$.matchedKnowledge') m
        WHERE c.status='CLOSED' AND c.buy_confirmed_at>? AND json_extract(m.value,'$.knowledgeId')=? AND json_extract(m.value,'$.version')=?
        ORDER BY c.buy_confirmed_at DESC LIMIT 200`).all(item.updatedAt,item.id,item.version) as any[];
      for(const row of matches){
        const caseId=String(row.position_id);if(training.has(caseId))continue;
        const payload=JSON.parse(String(row.case_payload)),pnl=Number(row.realized_pnl_pct);
        const rug=Boolean(this.db.prepare("SELECT 1 FROM chart_case_evidence ce JOIN chart_events e ON ce.evidence_type='EVENT' AND ce.evidence_id=e.id WHERE ce.case_id=? AND ce.phase='POST_BUY_OBSERVATION' AND e.kind='RUG_30' AND e.at>=? AND e.at<=? LIMIT 1").get(caseId,Number(row.buy_confirmed_at),Number(payload.closedAt??now)));
        const prior=this.db.prepare("SELECT payload FROM chart_knowledge_drift_cases WHERE knowledge_id=? AND knowledge_version=?").all(item.id,item.version).map((entry:any)=>JSON.parse(String(entry.payload)));
        const closedAt=Number(payload.closedAt??now);
        if(prior.some((entry:any)=>entry.mint===row.mint||(Number(row.buy_confirmed_at)-3600000<=Number(entry.closedAt)&&Number(entry.buyAt)-3600000<=closedAt)))continue;
        const dangerous=Number.isFinite(pnl)&&(pnl<=env.KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT||rug);
        this.db.prepare("INSERT OR IGNORE INTO chart_knowledge_drift_cases VALUES(?,?,?,?,?,?,?)").run(item.id,item.version,caseId,String(row.decision_id),dangerous?1:0,now,JSON.stringify({mint:row.mint,mode:row.mode,accountId:row.account_id,buyAt:row.buy_confirmed_at,closedAt,decisionAt:row.decision_at,pnlPct:pnl,observedRug30:rug,simulated:payload.simulated===true}));
      }
      const recent=this.db.prepare("SELECT dangerous FROM chart_knowledge_drift_cases WHERE knowledge_id=? AND knowledge_version=? ORDER BY observed_at DESC LIMIT ?").all(item.id,item.version,env.KNOWLEDGE_DRIFT_MIN_CASES).map((r:any)=>Number(r.dangerous));
      if(recent.length>=env.KNOWLEDGE_DRIFT_MIN_CASES&&recent.reduce((sum,value)=>sum+value,0)/recent.length>env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE){
        repo.recordControl(item.id,item.version,"SUSPEND",`Automatic drift suspension: dangerous outcome rate ${ (recent.reduce((sum,value)=>sum+value,0)/recent.length).toFixed(3)} exceeds ${env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE} over ${recent.length} independent post-deployment cases.`,"SYSTEM");
      }
    }
  }
  private saveAttempt(draft:TradingKnowledge,dataset:FrozenCase[],datasetHash:string,now:number,lifecycleState:string,failures:string[]){
    const id=randomUUID(),metrics=validationMetrics([]),report={validationId:id,knowledgeId:draft.id,knowledgeVersion:draft.version,datasetHash,labelPolicy:{name:"DANGEROUS_TRADE_V1",dangerousWhen:`confirmed realized PnL <= ${env.KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT}% OR linked observed RUG_30 during the held position`},thresholds:{minCases:env.KNOWLEDGE_VALIDATION_MIN_CASES,minPositive:env.KNOWLEDGE_VALIDATION_MIN_POSITIVE,minNegative:env.KNOWLEDGE_VALIDATION_MIN_NEGATIVE},metrics,independentMintCount:new Set(dataset.map((x)=>x.mint)).size,qualityGate:{passed:false,failures},lifecycleState,createdAt:now};
    sqliteAtomic(this.db,()=>{
      this.db.prepare("INSERT OR IGNORE INTO chart_validation_jobs(id,knowledge_id,knowledge_version,draft_payload,dataset_case_ids,dataset_hash,state,requested_at,completed_at,next_attempt_at,error,report) VALUES(?,?,?,?,?,?,'COMPLETED',?,?,?,?,?)").run(id,draft.id,draft.version,JSON.stringify(draft),JSON.stringify(dataset),datasetHash,now,now,now,lifecycleState,JSON.stringify(report));
      const inserted=this.db.prepare("SELECT id FROM chart_validation_jobs WHERE knowledge_id=? AND knowledge_version=? AND dataset_hash=?").get(draft.id,draft.version,datasetHash) as {id:string}|undefined;
      if(inserted?.id===id)this.db.prepare("INSERT OR IGNORE INTO chart_knowledge_validations VALUES(?,?,?,?,?,?,?,?)").run(id,draft.id,draft.version,now,JSON.stringify([...draft.supportingCaseIds,...draft.contradictoryCaseIds]),JSON.stringify(dataset.map((x)=>x.caseId)),JSON.stringify(metrics),JSON.stringify(report));
    });
  }
  enqueueDrafts(now=Date.now()){
    const repo=new ChartKnowledgeRepository(this.db);
    const drafts=this.db.prepare("SELECT k.payload FROM chart_knowledge_versions k WHERE k.status='DRAFT' AND NOT EXISTS (SELECT 1 FROM chart_knowledge_versions n WHERE n.id=k.id AND n.version>k.version) ORDER BY k.updated_at DESC LIMIT 500").all().map((r:any)=>tradingKnowledgeSchema.parse(JSON.parse(String(r.payload))));
    const created:string[]=[];
    for(const draft of drafts){
      if(repo.controlState(draft.id))continue;
      try{
        const dataset=this.frozenDataset(draft),snapshot=JSON.stringify(dataset),datasetHash=hash(dataset);
        if(this.db.prepare("SELECT 1 FROM chart_validation_jobs WHERE knowledge_id=? AND knowledge_version=? AND dataset_hash=?").get(draft.id,draft.version,datasetHash))continue;
        const labelMetrics=validationMetrics(dataset.map((c)=>({prediction:"UNCERTAIN" as const,dangerous:c.dangerous,pnlPct:c.pnlPct}))),low=[] as string[];
        if(dataset.length<env.KNOWLEDGE_VALIDATION_MIN_CASES)low.push("MIN_INDEPENDENT_CASES");
        if(labelMetrics.positiveClassCount<env.KNOWLEDGE_VALIDATION_MIN_POSITIVE)low.push("MIN_POSITIVE_CLASS");if(labelMetrics.negativeClassCount<env.KNOWLEDGE_VALIDATION_MIN_NEGATIVE)low.push("MIN_NEGATIVE_CLASS");
        if(low.length){this.saveAttempt(draft,dataset,datasetHash,now,"NEEDS_MORE_DATA",low);continue;}
        const id=randomUUID();
        this.db.prepare("INSERT OR IGNORE INTO chart_validation_jobs(id,knowledge_id,knowledge_version,draft_payload,dataset_case_ids,dataset_hash,state,requested_at,next_attempt_at) VALUES(?,?,?,?,?,?,'PENDING',?,?)").run(id,draft.id,draft.version,JSON.stringify(draft),snapshot,datasetHash,now,now);
        const inserted=this.db.prepare("SELECT id FROM chart_validation_jobs WHERE knowledge_id=? AND knowledge_version=? AND dataset_hash=?").get(draft.id,draft.version,datasetHash) as {id:string}|undefined;if(inserted)created.push(inserted.id);
      }catch{/* Invalid drafts or missing training provenance remain visible and cannot promote. */}
    }
    return created;
  }
  pump(now=Date.now()){
    this.monitorDrift(now);
    if(!env.AUTO_CHART_LEARNING_ENABLED||this.stopped||this.active)return;
    this.enqueueDrafts(now);
    const row=this.db.prepare("SELECT * FROM chart_validation_jobs WHERE state='PENDING' AND next_attempt_at<=? ORDER BY requested_at LIMIT 1").get(now) as any;if(!row)return;
    this.active=this.run(String(row.id)).finally(()=>{this.active=undefined;});
  }
  private async run(id:string){
    const claimed=sqliteAtomic(this.db,()=>this.db.prepare("UPDATE chart_validation_jobs SET state='RUNNING',started_at=?,attempt_count=attempt_count+1,error=NULL WHERE id=? AND state='PENDING'").run(Date.now(),id).changes===1);
    if(!claimed)return;
    const row=this.db.prepare("SELECT * FROM chart_validation_jobs WHERE id=?").get(id) as any;
    try{
      const draft=tradingKnowledgeSchema.parse(JSON.parse(String(row.draft_payload))),dataset=JSON.parse(String(row.dataset_case_ids)) as FrozenCase[],predictions:any[]=[];
      if(dataset.length<env.KNOWLEDGE_VALIDATION_MIN_CASES)throw Error("VALIDATION_DATASET_BECAME_INSUFFICIENT");
      for(const item of dataset){
        if(this.stopped)throw Error("VALIDATION_CANCELLED");
        const evidence=item.evidence.map((c)=>({evidenceId:c.id,at:c.at,availableAt:c.availableAt,open:c.open,high:c.high,low:c.low,close:c.close,volumeUsd:c.volumeUsd}));
        try{
          if(!this.runtime.evaluateKnowledge)throw Error("CODEX_VALIDATION_RUNTIME_UNAVAILABLE");
          const result=knowledgeReplayResponseSchema.parse(await this.runtime.evaluateKnowledge({knowledge:draft,case:{caseId:item.caseId,mint:item.mint,mode:item.mode,accountId:item.accountId,simulated:item.simulated,decisionCutoffAt:item.buyAt},evidence,evidenceCutoffAt:item.buyAt}));
          const allowed=new Set(evidence.map((e)=>e.evidenceId));if([...result.supportingEvidenceIds,...result.contradictoryEvidenceIds].some((ref)=>!allowed.has(ref)))throw Error("VALIDATION_EVIDENCE_REFERENCE_INVALID");
          const cited=[...new Set([...result.supportingEvidenceIds,...result.contradictoryEvidenceIds])];
          predictions.push({caseId:item.caseId,mint:item.mint,mode:item.mode,accountId:item.accountId,simulated:item.simulated,decisionAt:item.buyAt,evidenceIds:cited,evidenceReferences:evidence.filter((e)=>cited.includes(e.evidenceId)).map((e)=>({evidenceId:e.evidenceId,at:e.at,availableAt:e.availableAt})),prediction:result.prediction,dangerous:item.dangerous,pnlPct:item.pnlPct,summary:result.summary,uncertaintyReasons:result.uncertaintyReasons});
        }catch(error){if(error instanceof Error&&/EVIDENCE_REFERENCE|INVALID_RESPONSE/.test(error.message)){predictions.push({caseId:item.caseId,mint:item.mint,decisionAt:item.buyAt,evidenceIds:[],prediction:"ERROR",dangerous:item.dangerous,pnlPct:item.pnlPct,summary:error.message,uncertaintyReasons:[error.message]});continue;}throw error;}
      }
      const metrics=validationMetrics(predictions),gate=this.gates(metrics,dataset.length),idValidation=randomUUID(),createdAt=Date.now();
      const report:any={validationId:idValidation,knowledgeId:draft.id,knowledgeVersion:draft.version,datasetHash:String(row.dataset_hash),labelPolicy:{name:"DANGEROUS_TRADE_V1",dangerousWhen:`confirmed realized PnL <= ${env.KNOWLEDGE_VALIDATION_DANGEROUS_PNL_PCT}% OR a linked observed RUG_30 event occurred during the held position`},thresholds:gate.limits,metrics,independentMintCount:new Set(dataset.map((x)=>x.mint)).size,predictions,qualityGate:{passed:gate.passed,failures:gate.failures},lifecycleState:"DRAFT",createdAt};
      sqliteAtomic(this.db,()=>{
        const current=this.db.prepare("SELECT version,status,payload FROM chart_knowledge_versions WHERE id=? ORDER BY version DESC LIMIT 1").get(draft.id) as {version:number;status:string;payload:string}|undefined;
        const repo=new ChartKnowledgeRepository(this.db),latestControl=repo.latestControl(draft.id);
        let promoted=false;
        if(gate.passed&&current?.version===draft.version&&current.status==="DRAFT"&&!latestControl){
          const latest=tradingKnowledgeSchema.parse(JSON.parse(current.payload));
          if(!repo.isSuppressed(latest)){
            const now=Date.now(),next=tradingKnowledgeSchema.parse({...latest,version:draft.version+1,validationStatus:"VALIDATED",validationId:idValidation,validationMetrics:metrics,updatedAt:now});
            this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'VALIDATED',?,?,?)").run(next.id,next.version,next.category,next.applicableStage,next.createdAt,now,JSON.stringify(next));promoted=true;
          }
        }
        if(!gate.passed&&current?.version===draft.version&&current.status==="DRAFT"&&!latestControl){
          const latest=tradingKnowledgeSchema.parse(JSON.parse(current.payload)),now=Date.now(),rejected=tradingKnowledgeSchema.parse({...latest,version:draft.version+1,validationStatus:"REJECTED",rejectionReason:`Automatic holdout quality gates failed: ${gate.failures.join(", ")}`.slice(0,1000),validationId:idValidation,validationMetrics:metrics,updatedAt:now});
          this.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'REJECTED',?,?,?)").run(rejected.id,rejected.version,rejected.category,rejected.applicableStage,rejected.createdAt,now,JSON.stringify(rejected));
        }
        report.lifecycleState=promoted?"VALIDATED":gate.passed?(repo.controlState(draft.id)??"STALE_OR_SUPPRESSED"):latestControl?(repo.controlState(draft.id)??"REJECTED"):"REJECTED";
        this.db.prepare("INSERT INTO chart_knowledge_validations VALUES(?,?,?,?,?,?,?,?)").run(idValidation,draft.id,draft.version,createdAt,JSON.stringify([...draft.supportingCaseIds,...draft.contradictoryCaseIds]),JSON.stringify(dataset.map((x)=>x.caseId)),JSON.stringify(metrics),JSON.stringify(report));
        this.db.prepare("UPDATE chart_validation_jobs SET state='COMPLETED',completed_at=?,report=?,error=? WHERE id=?").run(createdAt,JSON.stringify(report),promoted?null:gate.passed?"STALE_OR_SUPPRESSED":gate.failures.join(","),id);
      });
    }catch(error){
      const message=error instanceof Error?error.message:"VALIDATION_JOB_FAILED",attempts=Number(row.attempt_count)+1,transient=/HTTP_429|TIMEOUT|REQUEST_FAILED|BUSY|UNAVAILABLE|fetch failed|CANCELLED/.test(message),retry=transient&&attempts<3;
      this.db.prepare("UPDATE chart_validation_jobs SET state=?,next_attempt_at=?,completed_at=?,error=? WHERE id=?").run(retry?"PENDING":"DEAD_LETTER",Date.now()+Math.min(300000,30000*2**(attempts-1)),retry?null:Date.now(),message,id);
    }
  }
  approve(_knowledgeId:string,_version:number,_approved:boolean):never{throw Error("KNOWLEDGE_AUTOMATIC_PROMOTION_ONLY");}
  jobs(limit=100){return this.db.prepare("SELECT * FROM chart_validation_jobs ORDER BY requested_at DESC LIMIT ?").all(Math.max(1,Math.min(500,limit)));}
  status(){const counts=Object.fromEntries(this.db.prepare("SELECT state,count(*) n FROM chart_validation_jobs GROUP BY state").all().map((r:any)=>[String(r.state).toLowerCase(),Number(r.n)]));const drift=this.db.prepare("SELECT count(*) sample_count,coalesce(sum(dangerous),0) dangerous_count FROM chart_knowledge_drift_cases").get() as {sample_count:number;dangerous_count:number};return{active:Boolean(this.active),automatic:true,jobs:counts,drift:{...drift,minCases:env.KNOWLEDGE_DRIFT_MIN_CASES,maxDangerousRate:env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE}};}
  async stop(){this.stopped=true;await this.active;}
}
