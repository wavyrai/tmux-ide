import test from 'node:test';import assert from 'node:assert/strict';import {validateHostDescriptor} from './host-descriptor.mjs';import {linuxHost} from './linux-host.mjs';
import { fixture } from "./host-fixture.mjs";

test('descriptor distinguishes intended default32 from root0 and refuses wrong tools/budgets',()=>{
 const d=fixture();assert.equal(validateHostDescriptor(d),d);
 for(const mutate of [v=>v.arch='arm64',v=>v.candidate.observationBatchMs=0,v=>v.candidate.runnerMaxMs=2000,v=>v.tools.node.version='24.21.0',v=>v.budgets.cpuPercent=11,v=>v.environment.LD_PRELOAD='/other']){const bad=fixture();mutate(bad);assert.throws(()=>validateHostDescriptor(bad));}
});
test('host adapter verifies boot/clock, never treats permission failure as absence',async()=>{
 const d=fixture();const runtime=linuxHost(d,{platform:'linux',arch:'x64',read:async path=>{if(path.endsWith('boot_id'))return d.bootId;if(path.endsWith('/cgroup'))return d.cgroupPath;throw Object.assign(Error('denied'),{code:'EACCES'});},execute:async()=>({stdout:'100\n'})});await runtime.assertIdentity();await assert.rejects(runtime.sampleOwnedProcess(42),/denied/);
 const absent=linuxHost(d,{platform:'linux',arch:'x64',read:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});},execute:async()=>({stdout:'100'})});assert.equal((await absent.observeOwnedProcess(42)).status,'absent');
});
