import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
import {linuxHost} from '/work/source/.tasks/components-linux/common/linux-host.mjs';
assert.equal(process.versions.node,'26.8.2');assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const freshHostPath='/evidence/component-host.json',freshHost=JSON.parse(readFileSync(freshHostPath)),inputs=JSON.parse(readFileSync('/work/host-inputs.json')),base=JSON.parse(readFileSync('/work/artifact-receipt.json'));
const artifactSha256=createHash('sha256').update(JSON.stringify(inputs.artifact)).digest('hex');assert.equal(artifactSha256,base.hostArtifactSha256);
assert.deepEqual(freshHost,{...inputs.artifact,bootId:freshHost.bootId,clockTicksPerSecond:freshHost.clockTicksPerSecond,cgroupPath:freshHost.cgroupPath});
// Validates the descriptor and proves boot/CLK_TCK/exact cgroup before any native import.
await linuxHost(freshHost).assertIdentity();
const freshHostBinding={path:freshHostPath,sha256:createHash('sha256').update(readFileSync(freshHostPath)).digest('hex'),artifactSha256,runtime:{bootId:freshHost.bootId,clockTicksPerSecond:freshHost.clockTicksPerSecond,cgroupPath:freshHost.cgroupPath},scope:'Preparation identity only; every future lane regenerates and freezes its own descriptor at this path.'};
const require=createRequire('/work/source/packages/daemon/package.json');
assert.equal(typeof require('node-pty').spawn,'function');assert.equal(typeof require('@xterm/headless-stock').Terminal,'function');
// Import only the fixture definitions, never runTarget or a live reader entrypoint.
const mod=await import('/work/source/.tasks/components-linux/parser/comparative.mjs');assert.equal(typeof mod.runTarget,'function');
const objects=process.report.getReport().sharedObjects;assert(objects.some(p=>p.endsWith('/linux-x64/pty.node')),'Expected actual Linux x64 native binding');
writeFileSync('/evidence/component-import.json',JSON.stringify({node:process.versions,noFixturesStarted:true,nodePtyLoaded:true,xtermLoaded:true,comparativeImport:true,freshHostBinding,sharedObjects:objects},null,2),{flag:'wx',mode:0o600});
