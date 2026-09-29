import {readOwnedProcStat} from './read-owned-proc-stat.mjs';
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {validateHostDescriptor} from './host-descriptor.mjs';import {createOwnedProcessSampler,ownedRetirementProof} from './process-cpu.mjs';
const run=promisify(execFile);
export function linuxHost(d,{read=path=>readFile(path,'utf8'),execute=run,platform=process.platform,arch=process.arch}={}){
 validateHostDescriptor(d);assert.equal(platform,d.platform);assert.equal(arch,d.arch);
 const sampler=createOwnedProcessSampler({platform:'linux',clockTicksPerSecond:d.clockTicksPerSecond,bootId:d.bootId,readSnapshot:pid=>readOwnedProcStat(pid,read)});
 return {...sampler,async assertIdentity(){
  assert.equal((await read('/proc/sys/kernel/random/boot_id')).trim(),d.bootId);
  assert.equal((await read('/proc/self/cgroup')).trim(),d.cgroupPath,'Fresh component cgroup identity changed');
  const r=await execute(d.tools.getconf.path,['CLK_TCK'],{timeout:5000,encoding:'utf8',env:{PATH:d.environment.PATH,LC_ALL:'C',TZ:'UTC'}});assert.equal(Number(r.stdout.trim()),d.clockTicksPerSecond);
 },async parentPid(pid,expectedIdentity){
  await sampler.sampleOwnedProcess(pid,expectedIdentity);const raw=await read(`/proc/${pid}/stat`);const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);const parent=Number(fields[1]);assert(Number.isSafeInteger(parent)&&parent>=0);await sampler.sampleOwnedProcess(pid,expectedIdentity);return parent;
 },async commandLine(pid,expectedIdentity){
  await sampler.sampleOwnedProcess(pid,expectedIdentity);const text=await read(`/proc/${pid}/cmdline`);await sampler.sampleOwnedProcess(pid,expectedIdentity);return text.replaceAll('\0',' ');
 },async retired(pid,expectedIdentity){return ownedRetirementProof(expectedIdentity,await sampler.observeOwnedProcess(pid,expectedIdentity)).retired;}};
}
