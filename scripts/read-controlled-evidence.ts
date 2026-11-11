import { tradingDatabasePath } from "../src/database-session.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { env } from "../src/config.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import { json } from "../src/util.js";
const runId = process.argv[2];
if (!runId || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Controlled run UUID required");
const file=resolve(dirname(env.DATABASE_PATH),`controlled-live-${runId}.json`);
const run=JSON.parse(readFileSync(file,"utf8"));
if(run.status!=="REAL_CONTROLLED_ROUND_TRIP_VERIFIED")throw new Error("No verified completed run");
const rpc=new Solana(), executions=run.executions as {signature:string;intent:{side:string;amount:string};evidence:{solDelta:string;tokenDelta:string}}[];
const signatures=executions.map(e=>e.signature);
const statuses=(await rpc.connection.getSignatureStatuses(signatures,{searchTransactionHistory:true})).value;
const receipts=[];
for(let i=0;i<executions.length;i++){
  const e=executions[i]!,receipt=await rpc.receipt(e.signature),status=statuses[i];
  if(!receipt?.meta||receipt.meta.err||!status||status.err||!["confirmed","finalized"].includes(status.confirmationStatus??"")||receipt.transaction.signatures[0]!==e.signature)throw new Error("Receipt/status verification failed");
  const delta=rpc.deltas(receipt,env.WALLET_PUBLIC_KEY,run.selectedMint);
  if(delta.sol.toString()!==e.evidence.solDelta||delta.tokens.toString()!==e.evidence.tokenDelta)throw new Error("Stored delta differs from on-chain receipt");
  const keys=receipt.transaction.message.getAccountKeys({accountKeysFromLookups:receipt.meta.loadedAddresses});
  const principal=receipt.transaction.message.compiledInstructions.reduce((sum,ix)=>{const data=Buffer.from(ix.data);return keys.get(ix.programIdIndex)?.toBase58()==="11111111111111111111111111111111"&&keys.get(ix.accountKeyIndexes[0]!)?.toBase58()===env.WALLET_PUBLIC_KEY&&data.length===12&&data.readUInt32LE(0)===2?sum+data.readBigUInt64LE(4):sum;},0n);
  if(e.intent.side==="BUY"&&(principal>5000000n||principal.toString()!==e.intent.amount))throw new Error("Actual BUY principal exceeds or differs from approval");
  receipts.push({side:e.intent.side,signature:e.signature,status:status.confirmationStatus,slot:receipt.slot,...delta,networkFeeLamports:receipt.meta.fee,actualPrincipalLamports:e.intent.side==="BUY"?principal.toString():null,
    newWalletTokenAccountRentLamports:(receipt.meta.postTokenBalances??[]).filter(b=>b.owner===env.WALLET_PUBLIC_KEY&&b.mint===run.selectedMint&&receipt.meta!.preBalances[b.accountIndex]===0).reduce((sum,b)=>sum+BigInt(receipt.meta!.postBalances[b.accountIndex]!),0n)});
}
const store=new Store(tradingDatabasePath("live"),{readOnly:true});
try{
  const records=store.db.prepare("SELECT kind,mint,payload FROM records WHERE id>? ORDER BY id").all(run.run.startRecordId);
  const analyses=records.filter(r=>r.kind==="events"&&JSON.parse(String(r.payload)).type==="ANALYZE");
  const skips=records.filter(r=>r.kind==="risk_decisions").map(r=>JSON.parse(String(r.payload))).filter(r=>!r.allowed);
  const skipReasons=Object.fromEntries([...new Set(skips.map(r=>r.reason))].map(reason=>[reason,skips.filter(r=>r.reason===reason).length]));
  const token=await rpc.inspectMint(run.selectedMint);
  const evidence={at:new Date().toISOString(),runId,wallet:env.WALLET_PUBLIC_KEY,mint:run.selectedMint,token,receipts,candidatesAnalyzed:new Set(analyses.map(r=>r.mint)).size,onChainInspected:run.tokenChecks.length,token2022Candidates:new Set(run.tokenChecks.filter((r:{report:{tokenProgram:string}})=>r.report.tokenProgram==="TOKEN_2022").map((r:{mint:string})=>r.mint)).size,skipReasons,currentSolLamports:(await rpc.balance(env.WALLET_PUBLIC_KEY)).toString(),currentTokenBalance:(await rpc.tokenBalance(env.WALLET_PUBLIC_KEY,run.selectedMint)).toString(),openPositions:store.positions("live").filter(p=>["OPEN","PENDING_ENTRY","PENDING_EXIT"].includes(p.state)).length,pending:store.pending().length,entriesEnabled:store.entriesEnabled(),outcome:run.learning.outcome,broadcasts:0};
  writeFileSync(file+".verification.json",json(evidence)+"\n",{mode:0o600});
  process.stdout.write(json(evidence)+"\n");
}finally{store.close();}
