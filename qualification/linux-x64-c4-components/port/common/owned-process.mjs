import assert from 'node:assert/strict';
import {ownedRetirementProof} from './process-cpu.mjs';
/** Same reviewed sampler; no second proc parser. Enumeration failures retain partial witnesses. */
export function ownedProcesses(host,children,{now=Date.now,limit=32,budgetMs=10000}={}){
 const witnesses=new Map();
 function load(rows=[]){for(const row of rows){assert(Number.isSafeInteger(row.pid)&&row.pid>0);assert.equal(typeof row.startIdentity,'string');const old=witnesses.get(row.pid);assert(!old||old.startIdentity===row.startIdentity,'Witness changed');witnesses.set(row.pid,row);}}
 async function sample(pid){const row=await host.sampleOwnedProcess(pid,witnesses.get(pid)?.startIdentity);load([row]);return row;}
 async function retired(pid){const old=witnesses.get(pid);assert(old,'Missing owned process witness');return ownedRetirementProof(old.startIdentity,await host.observeOwnedProcess(pid,old.startIdentity)).retired;}
 async function snapshot(roots){
  const queue=[...roots],seen=new Set(),errors=[],rows=[],deadline=now()+budgetMs;
  for(const pid of queue){if(seen.has(pid))continue;seen.add(pid);
   if(seen.size>limit||now()>=deadline){errors.push('Descendant bound/deadline exceeded');break;}
   try{const row=await sample(pid);rows.push(row);for(const child of await children(pid,Math.max(1,deadline-now()))){assert(Number.isSafeInteger(child)&&child>0);if(!seen.has(child))queue.push(child);}}
   catch(error){errors.push({pid,error:String(error),code:error.code??null});}
  }
  return {processes:rows,errors,witnesses:[...witnesses.values()],coverage:'bounded live recursive descendants; already-exited unobserved children are not proven'};
 }
 return {load,sample,retired,snapshot,witnesses};
}
