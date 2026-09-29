import {readFileSync} from 'node:fs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {linuxHost} from './linux-host.mjs';import {ownedProcesses} from './owned-process.mjs';
export async function createLinuxOwned(){
 const host=linuxHost(JSON.parse(readFileSync('/evidence/component-host.json','utf8')));await host.assertIdentity();const execute=promisify(execFile);
 return ownedProcesses(host,async(pid,remaining)=>{try{const r=await execute('/usr/bin/pgrep',['-P',String(pid)],{timeout:Math.min(remaining,5000),maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'}});return r.stdout.trim().split(/\s+/).filter(Boolean).map(Number);}catch(e){if(e.code===1)return [];throw e;}});
}
