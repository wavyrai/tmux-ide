import assert from 'node:assert/strict';
export function caseEnvironment(source,mode,privatePath){
 assert(['reference','disabled','enabled-no-reader','candidate32'].includes(mode));
 const env={...source};
 for(const k of Object.keys(env))if(/^(TMUX|TMUX_IDE_|NODE_OPTIONS$|NODE_PATH$)/u.test(k))delete env[k];
 env.PATH=privatePath;env.TMUX_IDE_NATIVE_OBSERVATION=mode==='candidate32'?'1':'0';return env;
}
export function assertObservationMode(mode,capability,status){
 if(mode!=='reference')assert.equal(capability.enabled,mode!=='disabled');
 assert.equal(status.method,mode==='candidate32'?'native-journal':'stock-hooks');
 assert.equal(status.coverage,mode==='candidate32'?'declared-capabilities':'partial');
 if(mode!=='candidate32'){assert.equal(status.lastGap,null);assert.equal(status.droppedCount,'0');}
}
export async function seededIdle(spec,{pair,drain,status,snapshot,now,sleep,check}){
 if(spec.lane!=='idle')return null;
 assert.equal(spec.mode,'candidate32');
 await pair();await drain();
 const started=now(),seed=JSON.stringify(status()),samples=[];
 for(let i=0;i<=25;i++){
  check();if(i)await sleep(Math.max(0,started+i*5000-now()));check();
  assert.equal(JSON.stringify(status()),seed,'Owner status changed during seeded idle');
  samples.push({elapsedMs:now()-started,pids:await snapshot(),status:status()});
 }
 const idleSeconds=(now()-started)/1000;assert(idleSeconds>=125);
 return {idleSamples:samples,idleSeconds};
}
export async function retireStream(task,abort,timeoutMs=1000){
 abort.abort();if(!task)return;
 let timer;
 try{await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SSE retirement timed out')),timeoutMs);})]);}
 finally{clearTimeout(timer);}
}
