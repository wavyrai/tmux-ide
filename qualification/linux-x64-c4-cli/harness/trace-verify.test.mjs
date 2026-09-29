import test from 'node:test';import assert from 'node:assert/strict';import {verifyTrace} from './trace-verify.mjs';
const events=[{type:'trace-ready',phase:'startup'}, {type:'attempt',id:1,phase:'startup',executable:'/native/tmux',executableResolved:'/native/tmux',argv:['-C','tmux-ide-events','-P'],shell:false},{type:'spawn',id:1,pid:9,phase:'startup'},{type:'phase',phase:'idle'},{type:'phase',phase:'wake'},{type:'phase',phase:'cleanup'},{type:'exit',id:1,phase:'cleanup'},{type:'process-exit',phase:'cleanup',code:0}];
const text=rows=>rows.map((r,i)=>JSON.stringify({seq:i+1,atNs:String(i*125000000000),...r})).join('\n')+'\n';
test('producer survives acknowledged idle and retires during cleanup',()=>assert.equal(verifyTrace(text(events),'/native/tmux').producerPid,9));
test('rejects restart, short-lived idle producer, incomplete terminal and unknown shell',()=>{
 for(const extra of [{type:'attempt',id:2,phase:'idle',argv:['tmux-ide-events','-P']},{type:'exit',id:1,phase:'idle'},{type:'attempt',id:2,phase:'idle',argv:[],shell:true}])assert.throws(()=>verifyTrace(text([...events.slice(0,4),extra,...events.slice(4)]),'/native/tmux'));
 assert.throws(()=>verifyTrace(text(events.slice(0,-1)),'/native/tmux'));
});
test('rejects recurring read helpers, unresolved/mismatched native path and all idle sync failures',()=>{
 const attempt={type:'attempt',id:2,phase:'idle',api:'execFile',executable:'tmux',executableResolved:'/native/tmux',argv:['tmux-ide-events','-r'],shell:false};
 for(const extra of [attempt,{...attempt,phase:'startup',executableResolved:null},{...attempt,phase:'startup',executableResolved:'/wrong/tmux'},...[
  {status:1,signal:null,error:null},{status:null,signal:'SIGTERM',error:null},{status:0,signal:null,error:'failure'}
 ].map(x=>({type:'sync-complete',id:3,phase:'idle',...x}))])assert.throws(()=>verifyTrace(text([...events.slice(0,4),extra,...events.slice(4)]),'/native/tmux'));
});
test('rejects unsuccessful, duplicate or non-final process terminal rows',()=>{
 for(const rows of [[...events.slice(0,-1),{...events.at(-1),code:1}],[...events,events.at(-1)],[...events,{type:'exit',phase:'cleanup',id:3}]])assert.throws(()=>verifyTrace(text(rows),'/native/tmux'));
});
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
import {shellEscape} from '../../../packages/daemon/src/lib/shell.ts';
// Evaluate the actual pure fence function without importing its unrelated daemon dependency graph.
const fenceSource=readFileSync(new URL('../../../packages/daemon/src/lib/tmux-server-generation-runner.ts',import.meta.url),'utf8');
const fenceStart=fenceSource.indexOf('export function fenceNativeTmuxCommand(');
assert(fenceStart>=0);const fenceEnd=fenceSource.indexOf('\n/**',fenceStart);assert(fenceEnd>fenceStart);
const fenceNativeTmuxCommand=new Function('shellEscape','randomUUID',stripTypeScriptTypes(fenceSource.slice(fenceStart,fenceEnd).replace('export function','function'))+'\nreturn fenceNativeTmuxCommand;')(shellEscape,randomUUID);
test('real generation-fenced -r and -V cannot evade idle invocation classification',()=>{
 for(const flag of ['-r','-V']){
  const argv=fenceNativeTmuxCommand(['tmux-ide-events',flag],{pid:'123',startTime:'456'}).argv;
  assert(!argv.includes('tmux-ide-events'));assert(argv.some(a=>a.includes("'tmux-ide-events'")));
  const call={type:'attempt',id:2,phase:'idle',api:'execFile',executable:'tmux',executableResolved:'/native/tmux',argv,shell:false};
  assert.throws(()=>verifyTrace(text([...events.slice(0,4),call,...events.slice(4)]),'/native/tmux'),/Recurring native event invocation/);
  const allowed={...call,phase:'startup'};
  assert.equal(verifyTrace(text([...events.slice(0,3),allowed,...events.slice(3)]),'/native/tmux').nativeEventInvocations,2);
 }
});
