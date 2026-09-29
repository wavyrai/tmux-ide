// Private stock bundle only; no server creation. Input graph comes from reviewed machInputs.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync,copyFileSync,realpathSync,existsSync } from 'node:fs';
import { dirname,basename,join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateStockDependencies } from './stock-graph.mjs';
const [source,output,machHelper,retainedRoot,mode]=process.argv.slice(2);
assert(['host-stock','unpatched-source'].includes(mode));
const {machInputs}=await import(pathToFileURL(machHelper).href);
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const graph=machInputs([source]);const nativeManifest=JSON.parse(readFileSync(join(retainedRoot,'manifest.json')));validateStockDependencies(graph,realpathSync(source),output,mode,nativeManifest);mkdirSync(output);mkdirSync(join(output,'lib'));mkdirSync(join(output,'licenses'));
const executable=join(output,'tmux');copyFileSync(source,executable);
const tmuxLicense=mode==='unpatched-source'?join(dirname(source),'COPYING'):join(dirname(dirname(source)),'COPYING');assert(existsSync(tmuxLicense));copyFileSync(tmuxLicense,join(output,'COPYING'));
const names=new Map(), destinations=new Map([[realpathSync(source),executable]]);
for(const path of Object.keys(graph.files)) {
 if(path===realpathSync(source))continue;
 const name=basename(path);assert(!names.has(name),'Dependency basename collision');names.set(name,path);
 const target=join(output,'lib',name);copyFileSync(path,target);destinations.set(path,target);
 const prefix=dirname(dirname(path));const license=['LICENSE','LICENSE.md','COPYING'].map(n=>join(prefix,n)).find(existsSync);
 assert(license,'Missing dependency license');copyFileSync(license,join(output,'licenses',name+'.txt'));
 run('/usr/bin/install_name_tool',['-id','@loader_path/'+name,target]);
}
for(const edge of graph.edges) {
 if(edge.system)continue;
 const target=destinations.get(edge.from);assert(target);
 // machInputs records the resolved target under `resolved`.
 const dependency=destinations.get(edge.resolved);assert(dependency,'Unresolved graph edge');
 run('/usr/bin/install_name_tool',['-change',edge.name,(target===executable?'@executable_path/lib/':'@loader_path/')+basename(dependency),target]);
}
if(mode==='unpatched-source') {
 const manifest=nativeManifest;
 assert.equal(names.size,3);
 for(const [name] of names) {
  const retained=join(retainedRoot,'lib',name);assert.equal(sha(retained),manifest.files['lib/'+name]);
  copyFileSync(retained,join(output,'lib',name));
 }
} else for(const [,target] of destinations)if(target!==executable)run('/usr/bin/codesign',['--force','--sign','-',target]);
run('/usr/bin/codesign',['--force','--sign','-',executable]);
for(const target of destinations.values())run('/usr/bin/codesign',['--verify',target]);
const after=machInputs([executable]);
assert(Object.keys(after.files).every(path=>path===executable||path.startsWith(output+'/lib/')));
writeFileSync(join(output,'mach-closure.json'),JSON.stringify({before:graph,after},null,2));
writeFileSync(join(output,'manifest.json'),JSON.stringify({schemaVersion:1,kind:'stock-tmux',mode,patches:mode==='unpatched-source'?[]:null,expectedCapabilities:{nativeGrid:false,journal:false},capabilityAdmissionPending:true,files:Object.fromEntries([...Object.values(destinations),join(output,'COPYING'),...Array.from(names.keys(),name=>join(output,'licenses',name+'.txt'))].map(p=>[p.slice(output.length+1),sha(p)])),performanceQualified:false},null,2));
