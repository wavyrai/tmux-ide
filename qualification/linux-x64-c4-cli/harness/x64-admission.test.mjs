import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './host-fixture.mjs';
import { LINUX_X64_INPUTS as pins } from './platform-inputs.mjs';
import { validateHostDescriptor } from './host-descriptor.mjs';
import { artifactHostSha256, admitCampaignHost } from './host-inputs.mjs';
import { linuxHost } from './linux-host.mjs';
import { elfClosure, verifyLoaderListing } from './elf-closure.mjs';
function inputs() {
  const {bootId,clockTicksPerSecond,cgroupPath,...artifact}=fixture();
  return {artifact,runtime:{bootId,clockTicksPerSecond,cgroupPath}};
}
test('complete artifact pins remain identical across newly witnessed campaign identities',()=>{
 const a=inputs(),hash=artifactHostSha256(a.artifact);
 const b=structuredClone(a);b.runtime.bootId='22222222-2222-4222-8222-222222222222';b.runtime.cgroupPath='0::/another-owned';
 assert.equal(artifactHostSha256(b.artifact),hash);
 assert.equal(admitCampaignHost(a,hash).bootId,a.runtime.bootId);
 assert.equal(admitCampaignHost(b,hash).bootId,b.runtime.bootId);
 assert.notEqual(JSON.stringify(a),JSON.stringify(b));
});
test('artifact/runtime boundary rejects stale embedded identity, runtime tool overrides and changed pins',()=>{
 const a=inputs(),hash=artifactHostSha256(a.artifact);
 for(const edit of [v=>v.artifact.bootId=v.runtime.bootId,v=>v.runtime.tools=v.artifact.tools,v=>v.artifact.tools.node.sha256='3'.repeat(64),v=>delete v.runtime.cgroupPath]) {
  const b=structuredClone(a);edit(b);assert.throws(()=>admitCampaignHost(b,hash));
 }
});
test('incomplete reference, image, loader, tool and native provenance inputs fail closed',()=>{
 for(const edit of [v=>delete v.reference.sha256,v=>delete v.tools.node.sha256,v=>delete v.containerImage,v=>delete v.elf.interpreterSha256,v=>delete v.native.gridPatchSha256,v=>v.native.journalPatchSha256='1'.repeat(64),v=>v.candidate.observationBatchMs=0,v=>v.arch='arm64',v=>v.platform='darwin',v=>v.tools.node.version='26.0.0']){
  const d=fixture();edit(d);assert.throws(()=>validateHostDescriptor(d));
 }
});
test('Linux x64 refuses a previous boot, cgroup or changed clock before process sampling',async()=>{
 const d=fixture();
 for(const [boot,cgroup,ticks] of [['wrong',d.cgroupPath,100],[d.bootId,'0::/replacement',100],[d.bootId,d.cgroupPath,250]]){
  const host=linuxHost(d,{platform:'linux',arch:'x64',read:async p=>p.endsWith('boot_id')?boot:cgroup,execute:async()=>({stdout:String(ticks)})});
  await assert.rejects(host.assertIdentity());
 }
});
test('AMD64 ELF and explicit-loader main mapping preserve every pinned dependency',()=>{
 const elf=extra=>`Class: ELF64\nMachine: ${pins.machine}\n${extra}`;
 const data={'/bundle/tmux':elf('[Requesting program interpreter: /sys/ld.so]\n(NEEDED) Shared library: [libc.so]'),'/sys/ld.so':elf(''),'/sys/libc.so':elf('')};
 const options={machine:pins.machine,systemDirs:['/sys'],realpath:p=>p,exists:p=>Object.hasOwn(data,p),read:p=>Buffer.from(data[p]),inspect:p=>data[p]};
 const closure=elfClosure('/bundle/tmux',options);
 assert.equal(Object.keys(closure.files).length,3);
 assert.deepEqual(verifyLoaderListing('(0x1)\nlinux-vdso.so.1 (0x2)\nlibc.so => /sys/libc.so (0x3)\n/sys/ld.so (0x4)',closure,{realpath:p=>p,mainExecutable:'/bundle/tmux'}),['/bundle/tmux','/sys/libc.so','/sys/ld.so']);
 assert.throws(()=>elfClosure('/bundle/tmux',{...options,machine:'AArch64'}));
 assert.throws(()=>verifyLoaderListing('(0x1)\n/sys/ld.so (0x4)',closure,{realpath:p=>p,mainExecutable:'/bundle/tmux'}),/Missing loader dependency/);
});
test('closed x64 native pins match retained reviewed current-patch manifest',()=>{
 const native=JSON.parse(readFileSync(new URL('../../native-linux-x64-36556264585/bundle/manifest.json',import.meta.url)));
 assert.equal(native.arch,'x64');assert.equal(native.platform,'linux');assert.equal(native.files.tmux,pins.nativeSha256);assert.equal(native.commit,pins.upstream);
 assert.equal(native.patches.find(p=>p.patch==='native-grid.patch').patchSha256,pins.gridPatchSha256);
 assert.equal(native.patches.find(p=>p.patch==='interaction-journal-v1.patch').patchSha256,pins.journalPatchSha256);
});
test('CPU workload, supervisor, accounting and idle invariants are byte-identical to reviewed ARM source',()=>{
 for(const name of ['case.mjs','campaign.py','cpu_accounting.py','accounting.mjs','orchestration.mjs','readiness.mjs','trace-verify.mjs','trace-preload.mjs','cleanup-witnesses.mjs']){
  assert.deepEqual(readFileSync(new URL(name,import.meta.url)),readFileSync(new URL('../../whole-runtime-linux-arm64-prep/harness/'+name,import.meta.url)));
 }
});
