import test from 'node:test';import assert from 'node:assert/strict';
import {seededIdle,retireStream,caseEnvironment,assertObservationMode} from './orchestration.mjs';
test('candidate32 idle seeds and drains before26samples spanning125s; CPU does neither',async()=>{
 let clock=0;const calls=[];const io={pair:async()=>calls.push('pair'),drain:async()=>{calls.push('drain');clock+=50;},status:()=>({cursor:'4'}),snapshot:async()=>{calls.push('sample');return [1];},now:()=>clock,sleep:async ms=>{clock+=ms;},check:()=>{}};
 assert.equal(await seededIdle({mode:'candidate32',lane:'cpu'},io),null);assert.deepEqual(calls,[]);
 const r=await seededIdle({mode:'candidate32',lane:'idle'},io);assert.deepEqual(calls.slice(0,2),['pair','drain']);assert.equal(calls.length,28);assert.equal(r.idleSamples.length,26);assert.equal(r.idleSamples[0].elapsedMs,0);assert.equal(r.idleSeconds,125);assert.equal(clock,125050);
});
test('idle rejects changed status and cancellation rather than waking through them',async()=>{
 let clock=0;const io={pair:async()=>{},drain:async()=>{},status:()=>({cursor:clock?'8':'4'}),snapshot:async()=>[],now:()=>clock,sleep:async ms=>{clock+=ms;},check:()=>{}};
 await assert.rejects(seededIdle({mode:'candidate32',lane:'idle'},io),/status changed/);
 await assert.rejects(seededIdle({mode:'candidate32',lane:'idle'},{...io,check:()=>{throw Error('cancelled');}}),/cancelled/);
});
test('stream timeout fails but caller can still attempt owner cleanup',async()=>{
 const a=new AbortController();let subsequent=false;
 try{await retireStream(new Promise(()=>{}),a,5);assert.fail('must time out');}catch(e){assert.match(e.message,/retirement timed out/);}finally{subsequent=true;}
 assert(a.signal.aborted);assert(subsequent);
 await retireStream(Promise.resolve(),new AbortController(),5);
 await assert.rejects(retireStream(Promise.reject(Error('stream failure')),new AbortController()),/stream failure/);
});
test('wrapper scrubs ambient hooks and native enable in every mode then sets explicit policy',()=>{
 const source={TMUX:'user',TMUX_IDE_NATIVE_OBSERVATION:'1',TMUX_IDE_HOME:'/user',NODE_OPTIONS:'hook',NODE_PATH:'unsafe',HOME:'/clean',PATH:'/old'};
 for(const mode of ['reference','disabled','enabled-no-reader','candidate32']){const env=caseEnvironment(source,mode,'/private');assert.equal(env.TMUX_IDE_NATIVE_OBSERVATION,mode==='candidate32'?'1':'0');assert.equal(env.TMUX,undefined);assert.equal(env.TMUX_IDE_HOME,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.NODE_PATH,undefined);assert.equal(env.HOME,'/clean');}
 assert.equal(source.TMUX,'user');
});
test('actual producer and owner modes must agree with reviewed condition',()=>{
 const stock={method:'stock-hooks',coverage:'partial',lastGap:null,droppedCount:'0'},native={...stock,method:'native-journal',coverage:'declared-capabilities'};
 assertObservationMode('disabled',{enabled:false},stock);assertObservationMode('enabled-no-reader',{enabled:true},stock);assertObservationMode('candidate32',{enabled:true},native);
 assert.throws(()=>assertObservationMode('disabled',{enabled:true},stock));assert.throws(()=>assertObservationMode('enabled-no-reader',{enabled:true},native));assert.throws(()=>assertObservationMode('candidate32',{enabled:false},native));
});
