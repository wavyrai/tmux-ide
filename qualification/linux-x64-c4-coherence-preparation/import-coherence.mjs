import assert from 'node:assert/strict';import {readFileSync,writeFileSync,realpathSync} from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {createRequire} from 'node:module';
const root='/work/current',source=root+'/source',imports=[];
for(const lane of ['native','stock']) {
 const dir=root+'/coherence/'+lane,driver=readFileSync(dir+'/coherence-canonical.ts','utf8');
 // Import only declared dependencies, never the fixture entry with top-level cases.
 for(const match of driver.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
  const name=match[1];if(!name.startsWith('.'))continue;
  const path=resolve(dir,name);assert(path!==dir+'/coherence-canonical.ts');await import(pathToFileURL(path));imports.push({lane,path:realpathSync(path)});
 }
}
const require=createRequire(source+'/packages/daemon/package.json');const pty=require('node-pty');assert.equal(typeof pty.spawn,'function');
writeFileSync('/evidence/coherence-import.json',JSON.stringify({fixturesStarted:false,nodePtyLoaded:true,imports,nodePty:realpathSync(require.resolve('node-pty')),sharedObjects:process.report.getReport().sharedObjects},null,2),{flag:'wx',mode:0o600});
