import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machInputs } from './mach-inputs.mjs';
function fixture(fn) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'darwin-input-')));
  const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(0x01000007,4);
  const executable=join(dir,'tmux'),lib=join(dir,'private.dylib');writeFileSync(executable,b);writeFileSync(lib,b);
  try {fn({dir,executable,lib});} finally {rmSync(dir,{recursive:true,force:true});}
}
test('private loader dependency closes; cache install names stay explicit',()=>fixture(({executable,lib})=>{
  const r=machInputs([executable],([flag,path])=>flag==='-l'?'':path+':\n'+(path===executable?' @loader_path/private.dylib (compatibility version 1.0.0, current version 1.0.0)\n':'')+' /usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n');
  assert.deepEqual(Object.keys(r.files).sort(),[executable,lib].sort());
  assert.deepEqual(r.systemInstallNames,['/usr/lib/libSystem.B.dylib']);
}));
test('missing rpath is refused rather than treated as host-cache coverage',()=>fixture(({executable})=>{
  assert.throws(()=>machInputs([executable],([flag,path])=>flag==='-l'?'':path+':\n @rpath/missing.dylib (compatibility version 1.0.0, current version 1.0.0)\n'));
}));

test('LC_ID_DYLIB own install name is recorded separately from dependency edges',()=>fixture(({lib})=>{
  const r=machInputs([lib],([flag,path])=>flag==='-l'?'cmd LC_ID_DYLIB\n cmdsize 80\n name @rpath/private.dylib (offset 24)\n':path+':\n @rpath/private.dylib (compatibility version 1.0.0, current version 1.0.0)\n');
  assert.deepEqual(r.edges,[]);
  assert.deepEqual(r.selfIds,[{path:lib,name:'@rpath/private.dylib'}]);
}));
