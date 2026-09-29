import assert from 'node:assert/strict';
export function validateHostDescriptor(d){
 assert.equal(d.version,1);assert.equal(d.platform,'linux');assert.equal(d.arch,'x64');
 assert.match(d.bootId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);assert(Number.isSafeInteger(d.clockTicksPerSecond)&&d.clockTicksPerSecond>0);
 assert.match(d.containerImage,/^sha256:[a-f0-9]{64}$/);assert.equal(d.containerInit,true);
 assert.equal(d.candidate.base,'cb6f09efb173d045d2bc221d0f14cfe415075b48');assert.equal(d.candidate.observationBatchMs,32);assert.equal(d.candidate.nativeDefaultEnabled,false);
 assert.equal(d.candidate.commandMs,2000);assert.equal(d.candidate.waitMs,60000);assert.equal(d.candidate.runnerMaxMs,60000);
 for(const name of ['node','bun','python','pgrep','readelf','getconf','sh','env']){const t=d.tools[name];assert(t.path.startsWith('/')&&!/[\0\r\n]/.test(t.path));assert.match(t.sha256,/^[a-f0-9]{64}$/);}
 assert.match(d.tools.node.version,/^26\./);assert.equal(d.tools.bun.version,'1.4.2');
 for(const key of ['native','reference']){assert(d[key].path.startsWith('/'));assert.match(d[key].sha256,/^[a-f0-9]{64}$/);}
 assert.match(d.native.journalPatchSha256,/^[a-f0-9]{64}$/);assert.equal(d.native.functionalReviewed,true);assert.equal(d.native.sanitizerReviewed,true);assert.equal(d.native.cleanupReviewed,true);
 assert.equal(d.native.sha256,'8933071dbaeea131b04961ab74ff8b21a622891bce6a01f43ef5122e2fad14d2');
 assert.equal(d.elf.machine,'Advanced Micro Devices X86-64');assert(d.elf.interpreter.startsWith('/'));assert.match(d.elf.interpreterSha256,/^[a-f0-9]{64}$/);assert(Array.isArray(d.elf.systemDirs)&&d.elf.systemDirs.length>0);
 for(const p of d.elf.systemDirs)assert(p.startsWith('/')&&!p.includes('..'));
 assert.equal(d.environment.LC_ALL,'C');assert.equal(d.environment.TZ,'UTC');
 for(const key of Object.keys(d.environment))assert(!/^(LD_|NODE_OPTIONS|NODE_PATH)/.test(key));
 assert.equal(d.budgets.cpuPercent,10);assert.equal(d.budgets.elapsedPercent,10);assert.equal(d.budgets.idleSeconds,125);assert.equal(d.budgets.wakeMs,100);
 return d;
}
