// Outer cancellation/ownership envelope; the accepted case-level cleanup remains unchanged.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {retireServer} from './retire-server.mjs';
import {createOwnedHarness} from './owned-harness.mjs';
import {createMacProcessIdentity} from './source/scripts/lib/owned-ssh-fixture.mjs';
import {fenceNativeTmuxCommand} from './source/packages/daemon/src/lib/tmux-server-generation-runner.ts';
const spec=JSON.parse(readFileSync(process.argv[2]));
assert.equal(spec.executionAuthorized,true);assert(['native','stock'].includes(spec.mode));
const base=import.meta.dirname,results=join(base,'results'),errors=[],servers=[];
let disposeIdentity;
let identity;
try{identity=await createMacProcessIdentity({parent:base,onAllocated:a=>{disposeIdentity=a.disposeFiles;}});}
catch(e){let cleanupError=null;try{await disposeIdentity?.();}catch(c){cleanupError=String(c).slice(0,2048);}
 writeFileSync(join(base,'supervisor.json'),JSON.stringify({ownedCleanup:false,initializationFailed:true,error:String(e).slice(0,2048),cleanupError}),{flag:'wx',mode:0o600});throw e;}
const record=e=>{if(errors.length<64)errors.push(String(e).slice(0,2048));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let owner,code=null,signal=null,timedout=false,cancelled=false,closed=false,sampling;
const stop=()=>{cancelled=true;owner?.child.kill('SIGTERM');};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
try{
 owner=createOwnedHarness({command:spec.argv[0],args:spec.argv.slice(1),cwd:spec.cwd,env:spec.environment},identity.identify);
 const terminal=new Promise(resolve=>{owner.child.once('error',e=>record(e));owner.child.once('close',(c,s)=>{code=c;signal=s;closed=true;resolve();});});
 sampling=(async()=>{while(!closed){try{await owner.capture();}catch(e){record(e);}await sleep(100);}})();
 const deadline=Date.now()+600000;
 while(!closed&&Date.now()<deadline&&!cancelled)await sleep(100);
 if(!closed){timedout=!cancelled;await owner.stop();}
 await terminal;
} catch(e){record(e);}
finally{
 // Each cleanup action is attempted independently. Diagnostic failures cannot skip ownership retirement.
 try{await owner?.stop();}catch(e){record(e);}
 closed=true;try{await sampling;}catch(e){record(e);}
 try{writeFileSync(join(base,'driver.log'),owner?.output()??'',{flag:'wx',mode:0o600});}catch(e){record(e);}
 const admitted=JSON.parse(readFileSync(join(base,'admission.json')));
 for(const n of [2,4,8]){
  const allocation=join(results,`clients-${n}-allocation.json`),proof=join(results,`clients-${n}-server.json`);
  if(!existsSync(allocation))continue;
  try{
   assert(existsSync(proof),'Allocated server lacks complete ownership witness; refuse mutation');
   const a=JSON.parse(readFileSync(allocation)),p=JSON.parse(readFileSync(proof));
   const retired=await retireServer(a,p,{identify:identity.identify,uid:process.getuid(),now:Date.now,sleep,
    socket:path=>{const st=lstatSync(path);return {isSocket:st.isSocket(),uid:st.uid,dev:st.dev,ino:st.ino};},
    kill:(path,generation)=>{const cmd=fenceNativeTmuxCommand(['-N','-u','kill-server'],generation);cmd.verify(execFileSync(admitted.native,['-S',path,...cmd.argv],{encoding:'utf8',timeout:5000,maxBuffer:1048576,env:spec.environment}));}
   });
   servers.push({clients:n,...retired});
  }catch(e){record(e);servers.push({clients:n,retired:false});}
 }
 try{await disposeIdentity?.();}catch(e){record(e);}
 process.off('SIGTERM',stop);process.off('SIGINT',stop);
 writeFileSync(join(base,'supervisor.json'),JSON.stringify({code,signal,timedout,cancelled,servers,errors,ownedCleanup:errors.length===0},null,2),{flag:'wx',mode:0o600});
}
if(code!==0||signal||timedout||cancelled||errors.length)process.exitCode=1;
