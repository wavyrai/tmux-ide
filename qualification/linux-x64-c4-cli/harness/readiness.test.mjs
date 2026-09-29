import test from 'node:test';import assert from 'node:assert/strict';
import {nativeStatusGuard,reconcileSetupCapture,boundedDaemonOutput} from './readiness.mjs';
import {reconcile} from './accounting.mjs';
const initial={environmentId:'e',serverScope:{serverId:'s',generation:'g'},method:'native-journal',coverage:'declared-capabilities',capabilityVersion:2,commands:['capture-pane','send-keys'],effects:['snapshot-produced','input-enqueued'],cursor:null,lastGap:{reason:'uncertain-consume',at:'2026-09-29T11:03:31.150Z',range:null},droppedCount:null};
const effect=(id,issuer,command,kind)=>({interactionId:id,actor:{kind:'native',issuerId:issuer},observation:{kind:'native-journal',parentCommandId:null,command},effect:{kind}});
test('preserves unknown bootstrap history while allowing ingestion cursor advancement',()=>{
 const guard=nativeStatusGuard(initial);guard.check({...initial,cursor:{epoch:'epoch',sequence:'2'}});
 assert.deepEqual(guard.baseline,initial);assert.equal(guard.baseline.droppedCount,null);
});
test('rejects new gap, cleared history, degradation and changed scope on each update',()=>{
 const guard=nativeStatusGuard(initial);
 for(const change of [{lastGap:null},{lastGap:{...initial.lastGap,at:'2026-09-29T11:03:32.150Z'}},{lastGap:{...initial.lastGap,reason:'native-range-dropped'}},{method:'unavailable'},{coverage:'partial'},{droppedCount:'0'},{serverScope:{serverId:'other',generation:'g'}}])assert.throws(()=>guard.check({...initial,...change}));
 for(const change of [{lastGap:null},{lastGap:{...initial.lastGap,reason:'epoch-reset'}},{droppedCount:'0'}])assert.throws(()=>nativeStatusGuard({...initial,...change}));
});
test('setup capture is exactly bound and background, never a workload pair',()=>{
 const seed=effect('seed','setup','capture-pane','snapshot-produced');
 const rows=[seed,effect('1','pair','send-keys','input-enqueued'),effect('2','pair','capture-pane','snapshot-produced')];
 assert.equal(reconcileSetupCapture(rows,'setup'),'seed');
 assert.deepEqual(reconcile(rows,new Set(['pair']),1),{pairs:1,externalEffects:2,backgroundEvidence:1,totalEvidence:3});
 for(const bad of [[],[seed,seed],[effect('wrong','setup','send-keys','input-enqueued')]])assert.throws(()=>reconcileSetupCapture(bad,'setup'));
 assert.throws(()=>reconcile(rows,new Set(['setup','pair']),2));
});
test('retains bounded diagnostic tails before and after stop and reports unavailable handle honestly',()=>{
 let output='before';const daemon={output:()=>output};assert.equal(boundedDaemonOutput(daemon).tail,'before');
 output+=' after';assert.deepEqual(boundedDaemonOutput(daemon,5),{available:true,totalBytes:12,retainedBytes:5,truncated:true,tail:'after'});
 assert.equal(boundedDaemonOutput(undefined).available,false);
 assert.throws(()=>boundedDaemonOutput({output(){throw Error('read failed');}}));
});
import {evidenceStatusBarrier} from './readiness.mjs';
test('seed cursor barrier waits for either evidence/status order without sleep',()=>{
 const rows=[effect('seed','s','capture-pane','snapshot-produced')];rows[0].observation.cursor={epoch:'epoch',sequence:'3'};
 const ready={cursor:{epoch:'epoch',sequence:'4'}};
 assert.equal(evidenceStatusBarrier([],ready,new Set(['s'])),false);
 assert.equal(evidenceStatusBarrier(rows,{cursor:null},new Set(['s'])),false);
 assert.equal(evidenceStatusBarrier(rows,{cursor:{epoch:'epoch',sequence:'2'}},new Set(['s'])),false);
 assert.equal(evidenceStatusBarrier(rows,ready,new Set(['s'])),true);
 assert.throws(()=>evidenceStatusBarrier(rows,{cursor:{epoch:'other',sequence:'9'}},new Set(['s'])));
});
