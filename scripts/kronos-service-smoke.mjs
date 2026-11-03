// Standalone TEMP Lab only; never start production server/Engine or collection.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const runtime=mkdtempSync(join(tmpdir(),'gmgn-kronos-service-'));
const child=spawn(process.execPath,['--import','./scripts/kronos-env.mjs','--import','tsx','./src/kronos-server.ts'],{cwd:process.cwd(),windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,KRONOS_RUNTIME:runtime,LOCALAPPDATA:runtime,USERPROFILE:runtime,TEMP:runtime,TMP:runtime},stdio:['ignore','pipe','pipe']});
try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('LAB_START_TIMEOUT')),20000);child.stdout.on('data',x=>{if(String(x).includes('collection PAUSED')){clearTimeout(timeout);resolve();}});child.on('exit',code=>{clearTimeout(timeout);reject(Error('LAB_EXIT_'+code));});child.stderr.on('data',x=>{if(String(x).includes('Error:')){clearTimeout(timeout);reject(Error(String(x).slice(-400)));}});});
  const state=await(await fetch('http://127.0.0.1:8792/state')).json();assert.equal(state.paperOnly,true);assert.equal(state.enabled,false);assert.equal(state.summary.records,0);assert.equal(state.market.requests,0);
  const bad=await fetch('http://127.0.0.1:8792/control',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"enable"}'});assert.equal(bad.status,403);
  const headers={'Content-Type':'application/json',Origin:'http://127.0.0.1:8792','X-Kronos-CSRF':state.csrf};
  const no=await fetch('http://127.0.0.1:8792/control',{method:'POST',headers,body:JSON.stringify({action:'reset',confirmation:'no'})});assert.equal(no.status,400);
  const yes=await fetch('http://127.0.0.1:8792/control',{method:'POST',headers,body:JSON.stringify({action:'reset',confirmation:'RESET KRONOS PAPER EXPERIMENT'})});assert.equal(yes.status,200);
  assert.equal((await(await fetch('http://127.0.0.1:8792/state')).json()).market.requests,0);
  console.log('PASS: standalone PAPER Lab starts paused with TEMP DB, localhost CSRF/reset guarded, zero GMGN reads. No production server/process started.');
}finally{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
