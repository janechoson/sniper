import {createServer} from "node:http";
import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {chromium} from "@playwright/test";
import assert from "node:assert/strict";
import {KRONOS} from "../dist/kronos-domain.js";

// Isolated GET-only fixture server. No Engine, Store, RPC, wallet or live control API.
const now=Date.now(),mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const fill=(exit=false)=>({at:now-(exit?10000:120000),quantityAtomic:"1012345",tradingLamports:exit?"15000000":"9800000",networkFeeLamports:"10000",priceSol:exit?"0.014817":"0.0096805",priceUsd:exit?"1.4817":"0.96805",signature:(exit?"B":"A").repeat(88)});
function trial(i,open=false,paper=false){return{id:(open?"open-":"closed-")+i,mint,symbol:open?"ALPHA":"CLOSED"+i,mode:paper?"PAPER":"LIVE",status:open?"OPEN":"CLOSED",entry:{value:0.96805,observedAt:now-120000,source:paper?"GMGN_TOKEN_INFO":"RECONCILED_USD"},exit:open?undefined:{value:1.4817,observedAt:now-10000,source:paper?"GMGN_TOKEN_INFO":"RECONCILED_USD"},current:{value:1.2,observedAt:now,source:"GMGN_TOKEN_INFO"},gates:{},evaluation:{stages:{CHEAP_FILTER:"PASS",SECURITY:"PASS",COMPATIBILITY:"PASS",HISTORY:"PASS",CAPITAL_FLOW:"PASS",KRONOS:"PASS",EXECUTION:"PASS"}},latest:{action:open?"HOLD":"PAPER_SELL",reason:"ALL_SAMPLED_TERMINALS_LOWER",at:now},execution:paper?undefined:{state:"RECONCILED",side:open?"BUY":"SELL"},live:paper?undefined:{state:open?"OPEN":"CLOSED",entry:fill(),exit:open?undefined:fill(true),decimals:6,quantity:open?"1012345":"0",grossPnlLamports:open?null:"5200000",feesLamports:open?"10000":"20000",netPnlLamports:open||i===55?null:"5180000",feesPrincipalPct:0.2,marketPnlPct:23.96,mfePct:25,maePct:-3},pnlPct:paper?10:undefined,mfePct:paper?12:undefined,maePct:paper?-2:undefined};}
const records=Array.from({length:55},(_,i)=>({...trial(i+1,false,i<2),cursor:i+1}));
records[53].symbol='<img src=x onerror="window.PWNED=1">';
records.push({...trial(1,true),cursor:56},{...trial(2,true),cursor:57});
const events=Array.from({length:120},(_,i)=>({id:i+1,at:now-(119-i)*1000,trial_id:"open-1",kind:["KRONOS_STAGE_PASS","KRONOS_INFERENCE_RESULT","BUY_RECONCILED","KRONOS_SECURITY_REJECT"][i%4],payload:{stage:i%4===3?"SECURITY":"HISTORY",reason:i%4===3?"LAB_SECURITY_REJECT":"fixture evidence",action:i%4===1?"HOLD":undefined}})).reverse();
const overview={tradingMode:"LIVE",paperOnly:false,dryRun:false,enabled:true,active:true,queueDepth:1,current:records.at(-1),queue:[],positions:{rows:records.filter(p=>p.status==="OPEN"),hasMore:false},logs:events.slice(0,5),inference:{loaded:true},providers:{gmgn:{state:"OK"},rpc:{state:"OK"}},recordsCount:records.length};
const requests=[],errors=[];let mutations=0;
const server=createServer((req,res)=>{
  requests.push({url:req.url,method:req.method});
  if(req.method!=="GET"){mutations++;res.writeHead(405);res.end();return;}
  const url=new URL(req.url,"http://localhost");const files={"/":"public/index.html","/overview.js":"public/overview.js","/style.css":"public/style.css","/token-avatar.js":"public/token-avatar.js"};
  if(files[url.pathname]){res.writeHead(200,{"Content-Type":url.pathname.endsWith(".js")?"text/javascript":url.pathname.endsWith(".css")?"text/css":"text/html"});res.end(readFileSync(files[url.pathname]));return;}
  let data;
  if(url.pathname==="/api/status")data={name:"Kronos fixture",mode:"live",csrf:"FIXTURE_ONLY",credentials:{gmgn:"configured"},settings:{trendingMaxAgeSeconds:2592000,minLiquidityUsd:10000,maxTaxPercent:20,maxSnapshotAgeMs:45000},sizing:{positionSizePercent:1,editable:false,baseReserveLamports:"20000000",reservePerOpenLamports:"5000000"}};
  else if(url.pathname==="/api/overview")data=overview;
  else if(url.pathname==="/api/kronos")data={policy:KRONOS,summary:{records:records.length,open:2,closed:55},records:records.slice(-50)};
  else if(["/api/history","/api/positions"].includes(url.pathname)){
    let rows=[...records].reverse();const state=url.searchParams.get("state"),mode=url.searchParams.get("mode"),cursor=Number(url.searchParams.get("cursor")||0),limit=Number(url.searchParams.get("limit")||50);
    if(url.pathname==="/api/positions")rows=rows.filter(r=>r.status==="OPEN");
    if(state&&state!=="ALL")rows=rows.filter(r=>r.status===state);
    if(mode&&mode!=="ALL")rows=rows.filter(r=>r.mode===mode);
    if(cursor)rows=rows.filter(r=>r.cursor<cursor);
    data={rows:rows.slice(0,limit),hasMore:rows.length>limit,nextCursor:rows.length>limit?rows[limit-1].cursor:null};
  }else if(url.pathname==="/api/logs"){const cursor=Number(url.searchParams.get("cursor")||0);data={rows:events.filter(e=>!cursor||e.id<cursor).slice(0,100)};}
  else if(url.pathname==="/api/trial")data={trial:records.find(r=>r.id===url.searchParams.get("id")),decisions:[],executions:[{state:"RECONCILED",accounting:fill()}]};
  else {res.writeHead(404);res.end();return;}
  res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(data));
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const port=server.address().port,browser=await chromium.launch({headless:true,channel:"chrome"});
mkdirSync("docs/previews/screen-parity",{recursive:true});
const geometry=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1050},acceptDownloads:true});
  page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/*",r=>{const u=new URL(r.request().url());return u.hostname==="127.0.0.1"&&u.port===String(port)?r.continue():r.abort();});
  await page.goto(`http://127.0.0.1:${port}`);await page.waitForSelector(".central-token");
  await page.locator('nav [data-view="positions"]').click();await page.waitForSelector(".position-card");
  assert.equal(await page.locator("#positionRows .position-card").count(),2);
  assert.match(await page.locator("#positionRows").textContent(),/1\.012345/);
  assert.equal(await page.locator("[data-sell-percent]").count(),0);
  await page.locator("#positionRows details").first().locator("summary").click();
  await page.evaluate(()=>window.KronosOverview.view("positions"));await page.waitForTimeout(150);
  assert.equal(await page.locator("#positionRows details").first().evaluate(d=>d.open),true);
  await page.locator('nav [data-view="history"]').click();await page.waitForSelector("#historyRows .history-record");
  assert.equal(await page.locator("#historyRows .history-record").count(),50);
  assert.equal(await page.locator("#historyState").inputValue(),"CLOSED");
  const first=await page.locator("#historyRows .history-record").first().getAttribute("data-position-id");assert.equal(first,"closed-55");
  assert.match(await page.locator("#historyRows .history-record").first().locator(":scope > summary").textContent(),/Net —/);
  await page.locator("#historyRows .history-record").first().locator(":scope > summary").click();
  await page.locator("#historyRows .history-record").first().locator(".history-executions summary").click();await page.waitForSelector(".kronos-json");
  await page.evaluate(()=>window.KronosOverview.view("history"));await page.waitForTimeout(120);
  assert.equal(await page.locator("#historyRows .history-executions").first().evaluate(d=>d.open),true);
  assert.equal(await page.evaluate(()=>window.PWNED),undefined);assert.equal(await page.locator("#historyRows img[onerror]").count(),0);
  await page.locator("#historyNext").click();await page.waitForFunction(()=>document.querySelectorAll("#historyRows .history-record").length===5);
  await page.locator("#historyMode").selectOption("PAPER");await page.waitForFunction(()=>document.querySelectorAll("#historyRows .history-record").length===2);
  await page.locator("#historyMode").selectOption("LIVE");await page.waitForFunction(()=>document.querySelectorAll("#historyRows .history-record").length===50);
  await page.locator('nav [data-view="logs"]').click();await page.waitForSelector("#terminalAllLogs .insights-log-row");
  assert.equal(await page.locator("#terminalAllLogs .insights-log-row").count(),40);
  assert.match(await page.locator(".insights-log-time").first().textContent(),/^\d{2}:\d{2}:\d{2}/);
  await page.locator('#logTypeFilters [data-type="KRONOS"]').click();
  assert.equal(await page.locator('#terminalAllLogs .insights-type-badge:not([data-type="KRONOS"])').count(),0);
  await page.locator('#logTypeFilters [data-type="ALL"]').click();await page.locator("#logSearch").fill("ALPHA");
  assert((await page.locator("#terminalAllLogs .insights-log-row").count())>0);
  await page.locator("#logPause").click();assert.equal(await page.locator("#logPause").getAttribute("aria-pressed"),"true");assert.equal(mutations,0);assert.equal(overview.enabled,true);
  const download=page.waitForEvent("download");await page.locator("#logExport").click();const exported=await download;assert.match(exported.suggestedFilename(),/kronos-logs/);
  await page.locator("#logClear").click();assert.equal(events.length,120);assert.equal(await page.locator("#terminalAllLogs .insights-log-row").count(),0);assert.equal(mutations,0);
  await page.locator("#logPause").click();await page.locator("#logSearch").fill("");
  await page.locator('nav [data-view="settings"]').click();await page.waitForSelector("#positionSizePercent");
  assert.equal(await page.locator("#positionSizePercent").inputValue(),"1");
  assert.equal(await page.locator("#positionSizePercent").evaluate(e=>e.readOnly),true);
  assert.match(await page.locator("#configuration").textContent(),/Kronos/);
  assert.equal(await page.locator("#settings input:not([readonly])").count(),0);
  assert.equal(await page.locator("#collectionEnable").isDisabled(),true);
  for(const width of [1440,1024,390]){
    await page.setViewportSize({width,height:1050});
    for(const view of ["positions","history","logs","settings"]){
      await page.locator(`nav [data-view="${view}"]`).click();await page.waitForTimeout(100);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view}/${width} page overflow`);
      geometry.push({view,width,panel:await page.locator(`#${view}`).boundingBox()});
      await page.screenshot({path:`docs/previews/screen-parity/fixture-${view}-${width}.png`,fullPage:true});
    }
  }
  assert.deepEqual(errors,[]);assert.equal(mutations,0);assert(requests.every(r=>r.method==="GET"));
  writeFileSync("evidence/ui-screen-parity-browser.json",JSON.stringify({at:new Date().toISOString(),passed:true,errors,mutations,requests:requests.map(r=>({path:r.url.split('?')[0],method:r.method})),geometry,fixtureOnly:true,backendDatasetModified:false},null,2));
  console.log("PASS: positions/cards, closed history/expansion/paging/mode/XSS, log filters/time/local pause/clear/export, read-only fixed1% settings, 1440/1024/390; zero mutation requests.");
}finally{await browser.close();await new Promise(r=>server.close(r));}
