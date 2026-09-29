import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,basename} from 'node:path';
import vm from 'node:vm';
import {parseMacPsSnapshot} from './process-cpu.mjs';
function fixture(){
 const files=new Map(),binary='/private/ref/tmux',socket='/private/fixture/socket',bytes=Buffer.from('fixture');
 const state={allocated:false,alive:true,appAlive:true,inode:3,reused:false,kills:0};let clock=0;
 const text=readFileSync(new URL('./reference-owner.mjs.in',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replaceAll('__SOURCE__','/source').replaceAll('__REFERENCE__',binary).replaceAll('__REFERENCE_SHA__',createHash('sha256').update(bytes).digest('hex')).replaceAll('__RECEIPTS__','/receipts').replaceAll('export function ','function ').replaceAll('export async function ','async function ');
 const context={process:{env:{}},assert,basename,join,createHash,parseMacPsSnapshot,Date:{now:()=>clock+=1000},setTimeout:fn=>fn(),existsSync:()=>state.allocated,lstatSync:()=>({isSocket:()=>true,dev:1,ino:state.inode,uid:501}),readFileSync:p=>p===binary?bytes:files.get(p),writeFileSync:(p,s)=>files.set(p,s),spawnSync:(exe,args)=>{
  const pid=Number(args[1]);if(!(pid===101?state.alive:state.appAlive))return {status:1,stdout:'',stderr:''};
  return {status:0,stderr:'',stdout:`${pid} Mon Sep 28 ${state.reused&&pid===101?'11':'10'}:00:00 2026 S 0:00.01 ${pid===101?'tmux':'node fixture'}\n`};
 },execFileSync:(exe,args)=>{if(args.includes('new-session')){state.allocated=true;return '';}if(args.includes('display-message'))return '101|123|102\n';if(args.includes('fenced-kill')){state.kills++;state.alive=state.appAlive=false;return '';}throw Error('Unexpected command');},fenceNativeTmuxCommand:(args,id)=>{assert.deepEqual({...id},{pid:'101',startTime:'123'});return {argv:['fenced-kill'],verify:x=>x};}};
 vm.runInNewContext(text+'\nglobalThis.create=createReferenceOwner;',context);
 const owner=context.create(binary,socket,'/private/fixture');owner.tmux('new-session');return {owner,state,files};
}
test('exact owned server is fenced and both processes must retire',async()=>{const f=fixture();await f.owner.cleanup();assert.equal(f.state.kills,1);assert.equal(JSON.parse([...f.files.values()][0]).cleanup.retired,true);});
test('replacement socket refuses mutation and retains failure',async()=>{const f=fixture();f.state.inode=4;await assert.rejects(f.owner.cleanup());assert.equal(f.state.kills,0);assert.equal(JSON.parse([...f.files.values()][0]).cleanup.retired,false);});
test('reused PID is not signalled when original processes are gone',async()=>{const f=fixture();f.state.reused=true;f.state.appAlive=false;await f.owner.cleanup();assert.equal(f.state.kills,0);assert.equal(JSON.parse([...f.files.values()][0]).cleanup.retired,true);});
