import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';import {once} from 'node:events';
import {installChildTrace} from './trace-hook.mjs';
test('preexisting named imports, sync APIs, promisified execFile and short-lived lifecycle are traced once',async()=>{
 const rows=[],restore=installChildTrace(e=>rows.push(e));
 try {
  const c=spawn(process.execPath,['-e','process.exit(0)']);await once(c,'exit');
  assert.equal(spawnSync(process.execPath,['-e','process.exit(0)']).status,0);
  assert.equal(execFileSync(process.execPath,['-e','process.stdout.write("sync")'],{encoding:'utf8'}),'sync');
  assert.equal((await promisify(execFile)(process.execPath,['-e','process.stdout.write("async")'])).stdout,'async');
  assert.equal(rows.filter(r=>r.type==='attempt').length,4);
  assert.equal(rows.filter(r=>r.type==='sync-complete').length,2);
  assert.equal(rows.filter(r=>r.type==='exit').length,2);
  assert.equal(rows.filter(r=>r.type==='spawn').length,2);
 }finally{restore();}
});
test('trace write rejection prevents an unrecorded launch',()=>{
 const restore=installChildTrace(()=>{throw Error('trace unavailable');});
 try{assert.throws(()=>spawnSync(process.execPath,['-e','process.exit(0)']),/trace unavailable/);}finally{restore();}
});
