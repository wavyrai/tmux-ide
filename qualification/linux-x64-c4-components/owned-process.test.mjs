import test from 'node:test';import assert from 'node:assert/strict';
import {ownedProcesses} from './common/owned-process.mjs';
const row=(pid,start=`linux:abc:${pid}:100`)=>({pid,startIdentity:start,status:'present',cpuSeconds:1});
function fixture({observe=async pid=>row(pid),children=async()=>[]}={}){return ownedProcesses({sampleOwnedProcess:async(pid,expected)=>{const r=await observe(pid);if(r.status!=='present'||expected&&r.startIdentity!==expected)throw Error('Not same live owner');return r;},observeOwnedProcess:observe},children);}
test('recursive snapshot retains exact witnesses and does not repeat cycles',async()=>{const o=fixture({children:async p=>p===1?[2,3]:p===2?[1,4]:[]});const r=await o.snapshot([1]);assert.deepEqual(r.processes.map(p=>p.pid),[1,2,3,4]);assert.deepEqual(r.errors,[]);});
test('enumeration failure retains witnessed owners and continues independent roots',async()=>{const o=fixture({children:async p=>{if(p===1)throw Error('permission');return [];}});const r=await o.snapshot([1,2]);assert.equal(r.errors.length,1);assert.equal(r.witnesses.length,2);assert(o.witnesses.has(2));});
test('missing witnesses and zombies cannot prove retirement; reuse permits no adoption',async()=>{
 const o=fixture();await assert.rejects(()=>o.retired(1),/Missing/);await o.sample(1);
 const reused=ownedProcesses({observeOwnedProcess:async()=>({status:'reused',pid:1,startIdentity:'linux:abc:1:101'})},async()=>[]);reused.load([row(1)]);assert.equal(await reused.retired(1),true);
 const zombie=ownedProcesses({observeOwnedProcess:async()=>({status:'zombie',pid:1,startIdentity:'linux:abc:1:100'})},async()=>[]);zombie.load([row(1)]);assert.equal(await zombie.retired(1),false);
 assert.throws(()=>o.load([row(1,'replacement')]),/Witness changed/);
});
test('snapshot count and time bounds fail closed',async()=>{
 const host={sampleOwnedProcess:async p=>row(p)};const o=ownedProcesses(host,async p=>[p+1],{limit:2});assert((await o.snapshot([1])).errors.length);
 let clock=0;const q=ownedProcesses(host,async()=>{clock=20;return [2];},{now:()=>clock,budgetMs:10});assert((await q.snapshot([1])).errors.length);
});
test('malformed/access errors are not absence and original identity is always passed',async()=>{
 let expected;const o=ownedProcesses({observeOwnedProcess:async(p,id)=>{expected=id;throw Object.assign(Error('denied'),{code:'EACCES'});}},async()=>[]);o.load([row(1)]);await assert.rejects(()=>o.retired(1),/denied/);assert.equal(expected,'linux:abc:1:100');
});
