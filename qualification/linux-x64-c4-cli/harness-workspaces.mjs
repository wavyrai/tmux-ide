import {readFileSync,readdirSync,mkdirSync,symlinkSync,realpathSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,resolve} from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
export function linkHarnessWorkspaces(root,harness){
 root=realpathSync(root);harness=realpathSync(harness);assert(harness.startsWith(root+'/'));
 const imports=[];
 for(const name of readdirSync(harness)){
  if(!/\.(mjs|ts)$/.test(name))continue;
  const from=join(harness,name),source=readFileSync(from,'utf8');
  for(const m of source.matchAll(/\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](@tmux-ide\/[^'"]+)['"]/g))imports.push({name:m[1],from});
 }
 assert(imports.length>0,'No audited workspace imports');
 const targets={'@tmux-ide/contracts':'packages/contracts'};
 for(const {name} of imports)assert(Object.hasOwn(targets,name),'Unaudited private workspace alias '+name);
 const links=[];
 for(const name of new Set(imports.map(i=>i.name))){
  const target=realpathSync(join(root,targets[name]));assert(target.startsWith(root+'/'));
  assert.equal(JSON.parse(readFileSync(join(target,'package.json'))).name,name);
  const link=join(harness,'node_modules',name);assert(!existsSync(link),'Refuse existing dependency link');mkdirSync(resolve(link,'..'),{recursive:true});
  const relativeTarget=relative(resolve(link,'..'),target);symlinkSync(relativeTarget,link,'dir');assert.equal(realpathSync(link),target);const files={};function hashTree(dir){for(const file of readdirSync(dir)){if(file==='node_modules')continue;const p=join(dir,file);if(statSync(p).isDirectory())hashTree(p);else files[p]=createHash('sha256').update(readFileSync(p)).digest('hex');}}hashTree(target);links.push({name,link,target,relativeTarget,files});
 }
 const resolutions=imports.map(({name,from})=>({name,from,entry:realpathSync(createRequire(from).resolve(name))}));
 for(const r of resolutions)assert(r.entry.startsWith(join(root,'packages/contracts')+'/'));
 return {links,resolutions,scope:'private harness imports; transitive workspace modules retain their pnpm-installed package boundaries'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(linkHarnessWorkspaces(process.argv[2],process.argv[3])));
