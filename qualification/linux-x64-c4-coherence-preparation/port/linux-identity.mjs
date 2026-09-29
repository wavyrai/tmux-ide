import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createOwnedProcessSampler} from './common/process-cpu.mjs';
import {readOwnedProcStat} from './common/read-owned-proc-stat.mjs';
const execute=promisify(execFile);
export async function createLinuxProcessIdentity({descriptor},io={}) {
  const read=io.read??(p=>readFile(p,'utf8')),run=io.execute??execute;
  assert.equal(io.platform??process.platform,'linux');assert.equal(io.arch??process.arch,'x64');
  assert.match(descriptor.bootId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert(Number.isSafeInteger(descriptor.clockTicksPerSecond)&&descriptor.clockTicksPerSecond>0);
  assert.equal(descriptor.getconf.path,'/usr/bin/getconf');
  assert.equal((await read('/proc/sys/kernel/random/boot_id')).trim(),descriptor.bootId);
  const ticks=await run(descriptor.getconf.path,['CLK_TCK'],{timeout:5000,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'}});
  assert.equal(Number(ticks.stdout.trim()),descriptor.clockTicksPerSecond);
  const sampler=createOwnedProcessSampler({platform:'linux',bootId:descriptor.bootId,clockTicksPerSecond:descriptor.clockTicksPerSecond,readSnapshot:pid=>readOwnedProcStat(pid,read)});
  return {async identify(pid) {
    const state=await sampler.observeOwnedProcess(pid);
    // Null means confirmed absent only. Zombies block retirement; reuse changes
    // the identity string so existing ownedProcesses refuses replacement signals.
    return state.status==='absent'?null:state.startIdentity;
  }};
}
