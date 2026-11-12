import assert from "node:assert/strict";
import { test } from "node:test";
import { ChartKnowledgeRepository, tradingKnowledgeSchema } from "../src/chart-knowledge.js";
import { CodexAIGuard } from "../src/codex-ai-guard.js";
import { ChartValidationEngine } from "../src/chart-validation-engine.js";
import { env } from "../src/config.js";
import type { ReasoningRuntime } from "../src/codex-runtime.js";
import { normalizeMarket } from "../src/gmgn.js";
import { parseMarketHistory } from "../src/market-history.js";
import { Store } from "../src/store.js";
import { candidate, info } from "./fixtures.js";
import { candles } from "./one-shot-fixtures.js";

const base={id:"KN-LIFECYCLE",title:"Distribution after a rapid pump",category:"DISTRIBUTION" as const,applicableStage:"PRE_BUY" as const,description:"Rapid appreciation weakens as buying pressure fades and repeated highs fail.",marketContext:"Solana token",observedBehaviors:["weakening buying pressure","failed highs"],variations:["timing varies"],supportingIndicators:["relative volume loss"],counterexamples:["sustained demand"],invalidationConditions:["fresh high with sustained volume"],supportingCaseIds:[],contradictoryCaseIds:[]};
function install(db:Store["db"]){const repo=new ChartKnowledgeRepository(db),draft=repo.createDraft(base),valid={...draft,version:2,validationStatus:"VALIDATED" as const,validationId:"v1",validationMetrics:{precision:1,recall:1}};db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,?,?,?,?)").run(valid.id,valid.version,valid.category,valid.applicableStage,"VALIDATED",valid.createdAt,valid.updatedAt+1,JSON.stringify(valid));const report={validationId:"v1",knowledgeId:valid.id,knowledgeVersion:draft.version,labelPolicy:{name:"DANGEROUS_TRADE_V1"},qualityGate:{passed:true},lifecycleState:"VALIDATED"};db.prepare("INSERT INTO chart_knowledge_validations VALUES(?,?,?,?,?,?,?,?)").run("v1",valid.id,draft.version,valid.updatedAt+1,"[]","[]",JSON.stringify({precision:1,recall:1}),JSON.stringify(report));return{repo,valid};}
function input(){const c=candidate();return{candidate:c,market:normalizeMarket(info()),history:parseMarketHistory(candles(60),c),mode:"demo" as const,attemptId:"lifecycle-test",maxAgeMs:45000,maxPriceMovePercent:10};}
function response(payload:any,matchedKnowledge:any[]=[]){return{action:"PASS",riskLevel:"LOW",confidence:.8,summary:"fixture",matchedKnowledge,marketObservations:[{evidenceId:payload.history.candles[0].evidenceId,explanation:"market evidence"}],uncertaintyReasons:[],evidenceCutoffAt:payload.evidenceCutoffAt};}
function runtime(answer:(payload:any)=>unknown|Promise<unknown>):ReasoningRuntime{return{status:()=>({state:"READY",model:"MOCK",promptVersion:"test"}),analyze:async()=>{throw Error("not used")},analyzeGuard:async(payload)=>answer(payload)};}

test("DISABLED and DELETED knowledge are excluded from Guard and restore returns them to service",async()=>{
  for(const control of ["disable","delete"] as const){
    const store=new Store(":memory:"),{repo,valid}=install(store.db);
    try{
      assert.equal(repo.validatedPreBuy().length,1);
      repo[control](valid.id,valid.version,`fixture ${control}`);
      assert.equal(repo.validatedPreBuy().length,0);
      assert.equal(repo.all()[0]!.validationStatus,control==="disable"?"DISABLED":"DELETED");
      let loaded=0;const guard=new CodexAIGuard(store.learningDb,runtime((payload)=>{loaded=payload.validatedKnowledge.length;return response(payload);}));
      const result=await guard.evaluate(input(),async()=>({market:input().market,authorityValid:true}));
      assert.notEqual(result.action,"ERROR");assert.equal(loaded,0);
      repo.restore(valid.id,valid.version,"fixture restore");
      assert.equal(repo.validatedPreBuy().length,1);
      assert.equal(repo.all()[0]!.validationStatus,"VALIDATED");
      assert.throws(()=>store.db.prepare("UPDATE chart_knowledge_control_events SET reason='tamper'" ).run(),/Immutable chart evidence/);
      await guard.stop();
    }finally{store.close();}
  }
});

test("user rejection suppresses equivalent future drafts until explicit restore",()=>{
  const store=new Store(":memory:"),{repo,valid}=install(store.db);
  try{
    repo.reject(valid.id,valid.version,"false pattern");
    assert.equal(repo.validatedPreBuy().length,0);
    assert.throws(()=>repo.createDraft({...base,id:"KN-RECREATED"}),/SUPPRESSED_BY_USER/);
    repo.restore(valid.id,valid.version,"user reviewed evidence and restored");
    const recreated=repo.createDraft({...base,id:"KN-RECREATED"});
    assert.ok(recreated);
    assert.equal(repo.validatedPreBuy().length,1);
  }finally{store.close();}
});

test("an in-flight PASS is rejected when an operator changes the active knowledge revision",async()=>{
  const store=new Store(":memory:"),{repo,valid}=install(store.db);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>((resolve)=>{entered=resolve;}),gate=new Promise<void>((resolve)=>{release=resolve;});
  const match={knowledgeId:valid.id,version:valid.version,similarity:.9,matchingEvidence:[{evidenceId:"CANDLE-1",explanation:"fixture match"}],differences:[],contradictoryEvidence:[]};
  const guard=new CodexAIGuard(store.learningDb,runtime(async(payload)=>{entered();await gate;return response(payload,[match]);}));
  try{
    const pending=guard.evaluate(input(),async()=>({market:input().market,authorityValid:true}));
    await started;repo.disable(valid.id,valid.version,"operator disabled during inference");release();
    const result=await pending;
    assert.equal(result.action,"ERROR");assert.equal(result.runtimeOutcome,"AI_GUARD_KNOWLEDGE_REVISION_CHANGED");
    assert.equal(repo.validatedPreBuy().length,0);
  }finally{release();await guard.stop();store.close();}
});

test("soft deletion and control events preserve immutable trading and audit history",()=>{
  const store=new Store(":memory:"),{repo,valid}=install(store.db);
  try{
    const before=Number(store.db.prepare("SELECT count(*) n FROM executions").get()!.n);
    repo.delete(valid.id,valid.version,"remove from learning view");
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM executions").get()!.n),before);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_control_events").get()!.n),1);
    assert.throws(()=>store.db.prepare("DELETE FROM chart_knowledge_control_events").run(),/Immutable chart history/);
  }finally{store.close();}
});

test("post-deployment drift uses new independent Guard cases and suspends deteriorating knowledge",()=>{
  const previous={enabled:env.AUTO_CHART_LEARNING_ENABLED,min:env.KNOWLEDGE_DRIFT_MIN_CASES,max:env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE};
  env.AUTO_CHART_LEARNING_ENABLED=true;env.KNOWLEDGE_DRIFT_MIN_CASES=5;env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE=0.3;
  const store=new Store(":memory:"),now=Date.now(),deployedAt=now-2*86400000;
  try{
    const draft=tradingKnowledgeSchema.parse({...base,version:1,validationStatus:"DRAFT",createdAt:deployedAt-1000,updatedAt:deployedAt});
    store.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'DRAFT',?,?,?)").run(draft.id,1,draft.category,draft.applicableStage,draft.createdAt,draft.updatedAt,JSON.stringify(draft));
    const valid=tradingKnowledgeSchema.parse({...draft,version:2,validationStatus:"VALIDATED",validationId:"drift-validation",validationMetrics:{precision:1,recall:1},updatedAt:deployedAt+1000});
    store.db.prepare("INSERT INTO chart_knowledge_versions VALUES(?,?,?,?,'VALIDATED',?,?,?)").run(valid.id,2,valid.category,valid.applicableStage,valid.createdAt,valid.updatedAt,JSON.stringify(valid));
    store.db.prepare("INSERT INTO chart_knowledge_validations VALUES(?,?,?,?,?,?,?,?)").run("drift-validation",valid.id,1,deployedAt,"[]","[]","{}","{}");
    for(let i=0;i<10;i++){
      const caseId=`drift-${i}`,mint=`drift-mint-${i}`,buyAt=now-(i+1)*2*3600000,pnl=-30;
      store.db.prepare("INSERT INTO chart_learning_cases(position_id,mint,mode,account_id,buy_confirmed_at,learning_started_at,entry_price_usd,entry_quantity,status,entry_snapshot_id,exit_snapshot_id,realized_pnl_lamports,realized_pnl_pct,created_at,updated_at,payload) VALUES(?,?,'demo','fixture',?,?,1,'1','CLOSED',NULL,NULL,'0',?,?,?,?)").run(caseId,mint,buyAt,buyAt,pnl,buyAt,buyAt,JSON.stringify({positionId:caseId,mint,closedAt:buyAt+1800000,simulated:true}));
      const decisionPayload={matchedKnowledge:[{knowledgeId:valid.id,version:valid.version}]};
      store.db.prepare("INSERT INTO chart_ai_guard_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`decision-${i}`,`attempt-${i}`,mint,"demo",buyAt-1000,"PASS",40,0,"COMPLETED","MOCK","fixture",3,"hash",null,JSON.stringify(decisionPayload));
    }
    const engine=new ChartValidationEngine(store.learningDb,{status:()=>({state:"READY",model:"MOCK",promptVersion:"test"}),analyze:async()=>{throw Error("not needed")}});
    engine.pump(now);
    const repo=new ChartKnowledgeRepository(store.learningDb);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_drift_cases WHERE knowledge_id=?").get(valid.id)!.n),10);
    assert.equal(repo.validatedPreBuy().length,0);assert.equal(repo.all()[0]!.validationStatus,"DISABLED");
    const suspension=store.db.prepare("SELECT action,actor,reason FROM chart_knowledge_control_events WHERE knowledge_id=? ORDER BY at DESC LIMIT 1").get(valid.id) as {action:string;actor:string;reason:string};
    assert.equal(suspension.action,"SUSPEND");assert.equal(suspension.actor,"SYSTEM");assert.match(suspension.reason,/dangerous outcome rate/);
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous.enabled;env.KNOWLEDGE_DRIFT_MIN_CASES=previous.min;env.KNOWLEDGE_DRIFT_MAX_DANGEROUS_RATE=previous.max;}
});
