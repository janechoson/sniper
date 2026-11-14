import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../src/store.js";
import { ChartKnowledgeRepository } from "../src/chart-knowledge.js";
import { ChartValidationEngine, validationMetrics } from "../src/chart-validation-engine.js";
import { ChartStore } from "../src/chart-store.js";
import { ChartAnalyzer } from "../src/chart-analyzer.js";
import { env } from "../src/config.js";
import type { ReasoningRuntime } from "../src/codex-runtime.js";

const knowledge={id:"KN-HOLDOUT",title:"Distribution after rapid pump",category:"DISTRIBUTION" as const,applicableStage:"PRE_BUY" as const,description:"Rapid appreciation followed by weakening demand and failed highs.",marketContext:"Meme token",observedBehaviors:["weakening demand"],variations:["timing can vary"],supportingIndicators:["relative volume loss"],counterexamples:["sustained demand"],invalidationConditions:["fresh sustained breakout"],supportingCaseIds:["train"],contradictoryCaseIds:[]};
function caseRow(store:Store,id:string,mint:string,buyAt:number,pnl:number,variant=id){
  store.db.prepare("INSERT INTO chart_learning_cases(position_id,mint,mode,account_id,buy_confirmed_at,learning_started_at,entry_price_usd,entry_quantity,status,entry_snapshot_id,exit_snapshot_id,realized_pnl_lamports,realized_pnl_pct,created_at,updated_at,payload) VALUES(?,?,'demo','fixture',?,?,1,'1','CLOSED',NULL,NULL,'0',?,?,?,?)")
    .run(id,mint,buyAt,buyAt,pnl,buyAt,buyAt,JSON.stringify({positionId:id,mint,closedAt:buyAt+60000,simulated:true}));
  store.db.prepare("INSERT INTO chart_case_collection(case_id,status,data_quality,updated_at,payload) VALUES(?,'READY_FOR_ANALYSIS','COMPLETE',?,'{}')").run(id,buyAt+60000);
  for(let i=0;i<12;i++){
    const at=buyAt-(12-i)*60000, evidenceId=`${id}-c${i}`, variantCode=[...variant].reduce((sum,char)=>(sum*31+char.charCodeAt(0))%100000,1), value=1+(i%3)*0.01+variantCode*0.00000001;
    const payload={at,open:value,high:value*1.01,low:value*.99,close:value*(i===11?1.005:1),volumeUsd:100+i,complete:true,source:"FIXTURE"};
    store.db.prepare("INSERT INTO chart_candles VALUES(?,?,?,?,?,?)").run(evidenceId,mint,"FIXTURE",at,at+60000,JSON.stringify(payload));
    store.db.prepare("INSERT INTO chart_case_evidence VALUES(?,?, 'CANDLE','PRE_BUY_CONTEXT',?)").run(id,evidenceId,at+60000);
  }
  return id;
}
function runtime(evaluate:(_input:any)=>any):ReasoningRuntime{return{status:()=>({state:"READY",model:"MOCK_ONLY",promptVersion:"test"}),analyze:async()=>({action:"REVIEW",reason:"fixture",ruleIds:[],supportingEventIds:[],contradictoryEventIds:[],uncertainty:"fixture",hypothesis:null}),evaluateKnowledge:async(input)=>evaluate(input)};}
async function waitUntil(done:()=>boolean){for(let i=0;i<200&&!done();i++)await new Promise((resolve)=>setTimeout(resolve,5));assert.ok(done(),"operation did not settle in time");}
async function replayFixture(knowledgeId:string,decide:(index:number,dangerous:boolean)=>"BLOCK"|"PASS"|"UNCERTAIN"){
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","train-mint",now-60*86400000,-30);
    for(let i=0;i<30;i++)caseRow(store,`sample-${i}`,`sample-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft({...knowledge,id:knowledgeId});
    const engine=new ChartValidationEngine(store.learningDb,runtime((input)=>{const index=Number(input.case.caseId.split("-")[1]);return{prediction:decide(index,index%2===0),summary:"fixture",supportingEvidenceIds:[input.evidence[0].evidenceId],contradictoryEvidenceIds:[],uncertaintyReasons:[]};}));
    engine.pump(now);
    await waitUntil(()=>{const row=store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=? ORDER BY requested_at DESC LIMIT 1").get(draft.id) as {state:string}|undefined;return ["COMPLETED","DEAD_LETTER"].includes(row?.state??"")&&!engine.status().active;});
    const job=store.db.prepare("SELECT state,report FROM chart_validation_jobs WHERE knowledge_id=? ORDER BY requested_at DESC LIMIT 1").get(draft.id) as {state:string;report:string|null};
    return{state:job.state,report:JSON.parse(job.report!),knowledge:repo.all()[0]};
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
}

test("holdout replay calculates explicit confusion metrics; abstentions and zero denominators stay visible",()=>{
  const metrics=validationMetrics([
    {prediction:"BLOCK",dangerous:true,pnlPct:-40},{prediction:"BLOCK",dangerous:false,pnlPct:5},
    {prediction:"PASS",dangerous:false,pnlPct:2},{prediction:"PASS",dangerous:true,pnlPct:-25},
    {prediction:"UNCERTAIN",dangerous:true,pnlPct:-10},{prediction:"ERROR",dangerous:false,pnlPct:1},
  ]);
  assert.deepEqual([metrics.TP,metrics.FP,metrics.TN,metrics.FN],[1,1,1,1]);
  assert.equal(metrics.precision,.5);assert.equal(metrics.recall,.5);assert.equal(metrics.specificity,.5);
  assert.equal(metrics.falsePositiveRate,.5);assert.equal(metrics.falseNegativeRate,.5);assert.equal(metrics.f1,.5);
  assert.equal(metrics.sampleCount,6);assert.equal(metrics.abstentions,2);assert.equal(metrics.coverage,4/6);
  assert.equal(metrics.precisionLower95!==null,true);assert.equal(metrics.recallLower95!==null,true);
  assert.equal(metrics.groups.BLOCK.meanPnlPct,-17.5);
  const undefinedMetrics=validationMetrics([{prediction:"UNCERTAIN",dangerous:true,pnlPct:-30}]);
  assert.equal(undefinedMetrics.precision,null);assert.equal(undefinedMetrics.recall,null);assert.equal(undefinedMetrics.falsePositiveRate,null);assert.equal(undefinedMetrics.abstentionRate,1);
});

test("frozen holdout excludes same-mint, overlapping, duplicate examples and only uses pre-BUY evidence",()=>{
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","mint-train",now-30*86400000,-30);
    const draft=repo.createDraft(knowledge);
    caseRow(store,"same-mint","mint-train",now-7*86400000,-25);
    caseRow(store,"overlap","mint-overlap",now-30*86400000+30*60000,-25);
    caseRow(store,"valid","mint-valid",now-5*86400000,5);
    caseRow(store,"duplicate","mint-duplicate",now-6*86400000,8,"valid");
    const engine=new ChartValidationEngine(store.learningDb,runtime(()=>({prediction:"PASS",summary:"fixture",supportingEvidenceIds:["valid-c0"],contradictoryEvidenceIds:[],uncertaintyReasons:[]})));
    engine.enqueueDrafts();
    const job=store.db.prepare("SELECT dataset_case_ids FROM chart_validation_jobs WHERE knowledge_id=? AND knowledge_version=?").get(draft.id,draft.version) as {dataset_case_ids:string};
    const frozen=JSON.parse(job.dataset_case_ids);
    assert.deepEqual(frozen.map((item:any)=>item.caseId),["valid"]);
    assert.ok(frozen[0].evidence.every((item:any)=>item.at+60000<=frozen[0].buyAt));
  }finally{store.close();}
});

test("passing independent replay automatically promotes a draft without approval",async()=>{
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","train-mint",now-60*86400000,-30);
    for(let i=0;i<30;i++)caseRow(store,`holdout-${i}`,`holdout-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft(knowledge);
    const model=runtime((input)=>{const i=Number(input.case.caseId.split("-")[1]);return{prediction:i%2===0?"BLOCK":"PASS",summary:"fixture prediction",supportingEvidenceIds:[input.evidence[0].evidenceId],contradictoryEvidenceIds:[],uncertaintyReasons:[]};});
    const engine=new ChartValidationEngine(store.learningDb,model);
    engine.pump(now);
    await waitUntil(()=>{const row=store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as {state:string}|undefined;return row?.state==="COMPLETED"&&!engine.status().active;});
    const job=store.db.prepare("SELECT * FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as any,report=JSON.parse(job.report);
    assert.equal(report.metrics.TP,15);assert.equal(report.metrics.TN,15);assert.equal(report.metrics.FP,0);assert.equal(report.metrics.FN,0);
    assert.equal(report.qualityGate.passed,true);assert.equal(report.predictions.length,30);assert.equal(report.lifecycleState,"VALIDATED");assert.ok(report.predictions.every((p:any)=>p.decisionAt&&p.evidenceIds.length));
    assert.equal(repo.validatedPreBuy()[0]!.id,draft.id);assert.equal(repo.validatedPreBuy()[0]!.version,draft.version+1);
    assert.throws(()=>engine.approve(draft.id,draft.version,true),/AUTOMATIC_PROMOTION_ONLY/);
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
});

test("excess abstention automatically rejects knowledge; no approval endpoint can bypass policy",async()=>{
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","train-fail-mint",now-60*86400000,-30);
    for(let i=0;i<30;i++)caseRow(store,`uncertain-${i}`,`uncertain-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft({...knowledge,id:"KN-UNCERTAIN",title:"Liquidity collapse"});
    const engine=new ChartValidationEngine(store.learningDb,runtime((_input)=>({prediction:"UNCERTAIN",summary:"insufficient",supportingEvidenceIds:[],contradictoryEvidenceIds:[],uncertaintyReasons:["mock abstention"]})));
    engine.pump(now);
    await waitUntil(()=>{const row=store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as {state:string}|undefined;return ["COMPLETED","DEAD_LETTER"].includes(row?.state??"")&&!engine.status().active;});
    const completedJob=store.db.prepare("SELECT state,report,error FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as {state:string;report:string|null;error:string|null};
    assert.equal(completedJob.state,"COMPLETED",completedJob.error??"validation replay did not complete");
    const report=JSON.parse(completedJob.report!);
    assert.equal(report.qualityGate.passed,false);assert.equal(report.metrics.abstentionRate,1);
    assert.throws(()=>engine.approve(draft.id,draft.version,true),/AUTOMATIC_PROMOTION_ONLY/);
    assert.equal(repo.validatedPreBuy().length,0);
    assert.equal(repo.all()[0]!.validationStatus,"REJECTED");
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
});

test("automatic promotion gates reject low precision, low recall and excessive false-positive rate",async(t)=>{
  await t.test("precision",async()=>{const result=await replayFixture("KN-PRECISION",() => "BLOCK");assert.equal(result.report.metrics.precision,.5);assert.ok(result.report.qualityGate.failures.includes("MIN_PRECISION"));assert.equal(result.knowledge?.validationStatus,"REJECTED");});
  await t.test("recall",async()=>{const result=await replayFixture("KN-RECALL",(i)=>i%2===0&&i<10?"BLOCK":"PASS");assert.equal(result.report.metrics.precision,1);assert.equal(result.report.metrics.recall,1/3);assert.ok(result.report.qualityGate.failures.includes("MIN_RECALL"));});
  await t.test("false-positive rate",async()=>{const result=await replayFixture("KN-FPR",(i)=>i%2===0?"BLOCK":i<12?"BLOCK":"PASS");assert.equal(result.report.metrics.precision,15/21);assert.equal(result.report.metrics.falsePositiveRate,.4);assert.ok(result.report.qualityGate.failures.includes("MAX_FALSE_POSITIVE_RATE"));});
});

test("validation restart recovery completes an interrupted job without duplicating promotion",async()=>{
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","restart-train",now-60*86400000,-30);
    for(let i=0;i<30;i++)caseRow(store,`restart-${i}`,`restart-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft(knowledge),model=runtime((input)=>{const i=Number(input.case.caseId.split("-")[1]);return{prediction:i%2===0?"BLOCK":"PASS",summary:"fixture",supportingEvidenceIds:[input.evidence[0].evidenceId],contradictoryEvidenceIds:[],uncertaintyReasons:[]};});
    const first=new ChartValidationEngine(store.learningDb,model);first.enqueueDrafts(now);
    store.db.prepare("UPDATE chart_validation_jobs SET state='RUNNING',attempt_count=1 WHERE knowledge_id=?").run(draft.id);
    const restarted=new ChartValidationEngine(store.learningDb,model);
    assert.equal((store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as {state:string}).state,"PENDING");
    restarted.pump(now+1000);
    await waitUntil(()=>{const state=(store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id) as {state:string}).state;return state==="COMPLETED"&&!restarted.status().active;});
    assert.equal(repo.validatedPreBuy().length,1);assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_versions WHERE id=?").get(draft.id)!.n),2);
    restarted.pump(now+5000);assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_versions WHERE id=?").get(draft.id)!.n),2);
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
});

test("concurrent validation snapshots preserve both reports but create only one current validated revision",async()=>{
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();
  try{
    caseRow(store,"train","concurrent-train",now-60*86400000,-30);
    for(let i=0;i<30;i++)caseRow(store,`concurrent-${i}`,`concurrent-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft(knowledge),model=runtime((input)=>{const suffix=Number(input.case.caseId.split("-").at(-1));return{prediction:suffix%2===0?"BLOCK":"PASS",summary:"fixture",supportingEvidenceIds:[input.evidence[0].evidenceId],contradictoryEvidenceIds:[],uncertaintyReasons:[]};});
    const first=new ChartValidationEngine(store.learningDb,model),second=new ChartValidationEngine(store.learningDb,model);
    first.enqueueDrafts(now);caseRow(store,"concurrent-new","concurrent-mint-new",now-3600000,5);second.enqueueDrafts(now+1000);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id)!.n),2);
    first.pump(now+2000);second.pump(now+3000);
    await waitUntil(()=>!first.status().active&&!second.status().active&&Number(store.db.prepare("SELECT count(*) n FROM chart_validation_jobs WHERE knowledge_id=? AND state='COMPLETED'").get(draft.id)!.n)===2);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_versions WHERE id=? AND status='VALIDATED'").get(draft.id)!.n),1);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_knowledge_validations WHERE knowledge_id=?").get(draft.id)!.n),2);
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
});

test("insufficient holdout stays NEEDS_MORE_DATA and only a changed dataset schedules a fresh replay",async()=>{
  const previous=env.AUTO_CHART_LEARNING_ENABLED;env.AUTO_CHART_LEARNING_ENABLED=true;
  const store=new Store(":memory:"),repo=new ChartKnowledgeRepository(store.db),now=Date.now();let calls=0;
  try{
    caseRow(store,"train","train-mint",now-60*86400000,-30);
    for(let i=0;i<9;i++)caseRow(store,`few-${i}`,`few-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    const draft=repo.createDraft(knowledge),engine=new ChartValidationEngine(store.learningDb,runtime((input)=>{calls++;const i=Number(input.case.caseId.split("-")[1]);return{prediction:i%2===0?"BLOCK":"PASS",summary:"fixture",supportingEvidenceIds:[input.evidence[0].evidenceId],contradictoryEvidenceIds:[],uncertaintyReasons:[]};}));
    engine.enqueueDrafts(now);
    assert.equal(repo.all()[0]!.validationStatus,"NEEDS_MORE_DATA");assert.equal(calls,0);
    const before=Number(store.db.prepare("SELECT count(*) n FROM chart_validation_jobs").get()!.n);
    assert.deepEqual(engine.enqueueDrafts(now+5000),[]);assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_validation_jobs").get()!.n),before);
    for(let i=9;i<30;i++)caseRow(store,`few-${i}`,`few-mint-${i}`,now-(i+2)*4*3600000,i%2===0?-30:5);
    assert.equal(engine.enqueueDrafts(now+10000).length,1);
    assert.equal(Number(store.db.prepare("SELECT count(*) n FROM chart_validation_jobs WHERE knowledge_id=?").get(draft.id)!.n),2);
    engine.pump(now+20000);
    await waitUntil(()=>{const row=store.db.prepare("SELECT state FROM chart_validation_jobs WHERE knowledge_id=? ORDER BY requested_at DESC LIMIT 1").get(draft.id) as {state:string};return row.state==="COMPLETED"&&!engine.status().active;});
    assert.equal(calls,30);assert.equal(repo.validatedPreBuy()[0]!.id,draft.id);
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=previous;}
});

test("automatic analyzer persists eligibility and waits the configured minimum delay across restart",async()=>{
  const prev={enabled:env.AUTO_CHART_LEARNING_ENABLED,delay:env.AUTO_CHART_LEARNING_DELAY_MS,min:env.AUTO_CHART_LEARNING_MIN_CANDLES};
  env.AUTO_CHART_LEARNING_ENABLED=true;env.AUTO_CHART_LEARNING_DELAY_MS=30000;env.AUTO_CHART_LEARNING_MIN_CANDLES=10;
  const store=new Store(":memory:"),charts=new ChartStore(store),now=Date.now();let calls=0;
  try{
    caseRow(store,"auto-case","auto-mint",now-60000,5);
    store.db.prepare("INSERT INTO chart_replays VALUES(?,?,?,?,?)").run("auto-case","demo","fixture",now,JSON.stringify({positionId:"auto-case",candles:[],accounting:{}}));
    const rt=runtime(()=>({}));rt.analyze=async()=>{calls++;return{action:"REVIEW",reason:"auto fixture",ruleIds:[],supportingEventIds:[],contradictoryEventIds:[],uncertainty:"fixture",hypothesis:null};};
    const analyzer=new ChartAnalyzer(charts,rt);
    const eligibleAt=now;
    analyzer.pump(now);
    let row=store.db.prepare("SELECT * FROM chart_auto_learning_jobs WHERE case_id='auto-case'").get() as any;
    assert.equal(row.state,"PENDING");assert.equal(row.eligible_at,eligibleAt);assert.equal(row.next_attempt_at,eligibleAt+30000);assert.equal(calls,0);
    const restarted=new ChartAnalyzer(charts,rt);
    restarted.pump(eligibleAt+29999);assert.equal(calls,0);
    restarted.pump(eligibleAt+30000);
    await waitUntil(()=>!restarted.status().active);
    row=store.db.prepare("SELECT * FROM chart_auto_learning_jobs WHERE case_id='auto-case'").get() as any;
    assert.equal(calls,2);assert.equal(row.state,"COMPLETED");
  }finally{store.close();env.AUTO_CHART_LEARNING_ENABLED=prev.enabled;env.AUTO_CHART_LEARNING_DELAY_MS=prev.delay;env.AUTO_CHART_LEARNING_MIN_CANDLES=prev.min;}
});
