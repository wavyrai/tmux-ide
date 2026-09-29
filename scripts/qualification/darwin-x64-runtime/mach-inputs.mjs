// Read-only closure capture on the Intel preparation host, never invokes target binaries.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertIntelMachO } from './native-input.mjs';
export function machInputs(roots, inspect = (args) => execFileSync('/usr/bin/otool', args, { encoding:'utf8', timeout:5000, maxBuffer:1048576 })) {
  const files = {}, edges = [], selfIds = [], systemFiles = {}, raw = {}, system = new Set(), pending = roots.map(path => ({path:realpathSync(path), executable:realpathSync(path)}));
  for (const {path,executable} of pending) {
    if (files[path]) continue;
    assert(Object.keys(files).length < 1024, 'Mach closure bound');
    const bytes = readFileSync(path); assertIntelMachO(bytes);
    files[path] = createHash('sha256').update(bytes).digest('hex');
    const linked = inspect(['-L',path]), loads = inspect(['-l',path]); raw[path] = {linked,loads};
    const ownId = /cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/.exec(loads)?.[1];
    const rpaths = [...loads.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(m => m[1]);
    const expand = name => name.startsWith('@loader_path/') ? resolve(dirname(path),name.slice(13)) : name.startsWith('@executable_path/') ? resolve(dirname(executable),name.slice(17)) : name;
    for (const line of linked.split('\n').slice(1).filter(s=>s.trim())) {
      const match = /^\s+(.+?) \(compatibility version /.exec(line); assert(match,'Unknown otool dependency');
      const name=match[1];
      if (name === ownId) { selfIds.push({path,name}); continue; }
      if (name.startsWith('/usr/lib/') || name.startsWith('/System/Library/')) {
        system.add(name);
        if (existsSync(name)) {
          const resolved=realpathSync(name);
          systemFiles[name]={resolved,sha256:createHash('sha256').update(readFileSync(resolved)).digest('hex')};
        }
        edges.push({from:path,name,system:true,fileHashed:!!systemFiles[name]}); continue;
      }
      let candidate=expand(name);
      if (name.startsWith('@rpath/')) {
        const matches=rpaths.map(r=>resolve(expand(r),name.slice(7))).filter(existsSync);
        assert.equal(matches.length,1,'Ambiguous/missing per-object rpath'); candidate=matches[0];
      }
      assert(candidate.startsWith('/'),'Unresolved Mach dependency');
      const target=realpathSync(candidate); edges.push({from:path,name,path:candidate,resolved:target}); pending.push({path:target,executable});
    }
  }
  return {files,edges,selfIds,raw,systemFiles,systemInstallNames:[...system].sort(),systemCoverage:'OS-managed loader graph is an opaque host OS boundary. Existing system files hashed separately; cache-only install names have no invented per-file hash.'};
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  assert.equal(process.platform,'darwin'); assert.equal(process.arch,'x64');
  const [input,output]=process.argv.slice(2); assert(input&&output);
  const roots=JSON.parse(readFileSync(input));
  writeFileSync(output,JSON.stringify(machInputs(roots),null,2),{flag:'wx',mode:0o600});
}
