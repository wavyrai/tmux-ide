import test from 'node:test';import assert from 'node:assert/strict';
import {cleanupDiagnostic} from './cleanup-diagnostic.mjs';
test('cleanup diagnostic preserves exact phase and native read fields',()=>{
 const e=Object.assign(new Error('process vanished'),{code:'ESRCH',syscall:'read',path:'/proc/9422/stat'});
 const d=cleanupDiagnostic('owned-process-retirement',e);
 assert.equal(d.phase,'owned-process-retirement');assert.equal(d.code,'ESRCH');assert.equal(d.syscall,'read');assert.equal(d.path,'/proc/9422/stat');assert.equal(d.stack,e.stack);assert(d.error);
});
test('all diagnostic fields are bounded and missing fields explicit',()=>{
 const x='x'.repeat(20000);const e=Object.assign(new Error(x),{code:x,syscall:x,path:x,stack:x});const d=cleanupDiagnostic(x,e);
 for(const [k,n] of Object.entries({error:2048,phase:80,code:64,syscall:64,path:1024,stack:8192}))assert(d[k].length<=n);
 assert.deepEqual(cleanupDiagnostic('fleet-dispose','failure'),{error:'failure',phase:'fleet-dispose',code:null,syscall:null,path:null,stack:null});
});
