import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,readdirSync,lstatSync,readlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire,isBuiltin} from 'node:module';
import {resolve,join} from 'node:path';
import {machInputs} from './mach-inputs.mjs';
export function externalNames(meta){const names=new Set();for(const out of Object.values(meta.outputs))for(const item of out.imports??[])if(item.external&&!isBuiltin(item.path))names.add(item.path);return [...names].sort();}
export function collect(root,binding){
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'x64');root=realpathSync(root);const source=root+'/source',sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
 const req=createRequire(source+'/packages/daemon/package.json');const pty=req('node-pty');assert.equal(typeof pty.spawn,'function');
 const runtimeRequire=createRequire(source+'/.tasks/qualified-cli/cli.mjs');
 const meta=JSON.parse(readFileSync(source+'/.tasks/qualified-cli/cli-metafile.json'));const buildInputs={},externalResolutions={};
 for(const name of Object.keys(meta.inputs)){const p=resolve(source,name);assert(p.startsWith(source+'/'));buildInputs[p]=sha(p);}
 for(const name of externalNames(meta)){const p=realpathSync(runtimeRequire.resolve(name));assert(p.startsWith(source+'/'));externalResolutions[name]={path:p,sha256:sha(p)};}
 const shared=process.report.getReport().sharedObjects.filter(p=>!p.startsWith('/usr/lib/')&&!p.startsWith('/System/Library/'));
 const mach=machInputs([...new Set([binding.node,binding.bun,binding.native,binding.reference,...shared])]);
 const files={},links={};let count=0;function walk(p){assert(++count<500000);const s=lstatSync(p);if(s.isSymbolicLink()){const text=readlinkSync(p),target=realpathSync(p);assert(!text.startsWith('/')&&target.startsWith(root+'/'));links[p]={target:text,resolved:target};return;}if(s.isDirectory()){for(const n of readdirSync(p))walk(join(p,n));return;}assert(s.isFile());files[p]=sha(p);}
 for(const name of ['source','admitted','recipe'])walk(root+'/'+name);
 for(const p of Object.keys(mach.files))assert(p.startsWith(root+'/'),'Unpacked non-system Mach dependency: '+p);
 const receipt={sourceCommit:binding.sourceCommit,sourceTree:binding.sourceTree,cli:source+'/.tasks/qualified-cli/cli.mjs',cliSha256:sha(source+'/.tasks/qualified-cli/cli.mjs'),observerDefaultBatchMs:32,nativeDefaultEnabled:false,hostTools:JSON.parse(readFileSync(root+'/host-tools.json')),buildInputs,externalResolutions,nodePtyLoaded:true,nodePty:realpathSync(req.resolve('node-pty')),files,links,mach,performanceQualified:false,fixturesStarted:false};
 writeFileSync(root+'/cli-receipt.json',JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){const [root,binding]=process.argv.slice(2);collect(root,JSON.parse(readFileSync(binding)));}
