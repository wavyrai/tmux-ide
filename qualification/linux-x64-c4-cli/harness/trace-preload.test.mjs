import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {tracePhase} from './trace-client.mjs';
test('actual preload acknowledges private phase changes before CLI-equivalent execution ends',async()=>{
 const root=mkdtempSync(join(tmpdir(),'trace-unit-'));let child;
 try{
  const config=join(root,'config.json'),log=join(root,'log'),socket=join(root,'s');writeFileSync(config,JSON.stringify({ownerPid:process.pid,log,socket}),{mode:0o600});
  const url=new URL('./trace-preload.mjs',import.meta.url);url.searchParams.set('config',config);
  child=spawn(process.execPath,['--import',url.href,'-e','process.stdout.write("ready\\n");process.stdin.once("data",()=>process.exit(0));'],{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup deadline '+stderr)),2000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);});
  for(const phase of ['idle','wake','cleanup'])assert.equal((await tracePhase(socket,phase)).phase,phase);
  const exited=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('exit deadline')),2000);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  child.stdin.end('done');assert.equal(await exited,0,stderr);
  const rows=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows[0].type,'trace-ready');assert.equal(rows.at(-1).type,'process-exit');assert.deepEqual(rows.filter(r=>r.type==='phase').map(r=>r.phase),['idle','wake','cleanup']);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}rmSync(root,{recursive:true,force:true});}
});
