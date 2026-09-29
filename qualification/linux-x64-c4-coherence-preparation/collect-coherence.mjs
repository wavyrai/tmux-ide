import assert from 'node:assert/strict';import {readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,readlinkSync,existsSync} from 'node:fs';import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';import {createRequire,isBuiltin} from 'node:module';import {execFileSync,spawnSync} from 'node:child_process';
import {elfClosure,verifyLoaderListing,nativeBundleFiles} from '/work/source/.tasks/native-x64-c4/harness/elf-closure.mjs';
const root='/work/current',source=root+'/source',sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const d=JSON.parse(readFileSync('/inputs/admission.json')),base=JSON.parse(readFileSync('/work/artifact-receipt.json')),host=JSON.parse(readFileSync('/work/host.json')),imported=JSON.parse(readFileSync('/evidence/coherence-import.json'));
assert(imported.fixturesStarted===false&&imported.nodePtyLoaded===true);
for(const [p,h] of Object.entries(base.closure))assert.equal(sha(p),h,'Original artifact changed '+p);
const closure={},links={},resolutions=[],buildInputs={};
function tree(path){const s=lstatSync(path);if(s.isSymbolicLink()){const target=readlinkSync(path),actual=realpathSync(path);assert(!target.startsWith('/'));assert(actual.startsWith(root+'/')||actual.startsWith('/work/native/'));links[path]={target,resolved:actual};return;}if(s.isDirectory()){for(const name of readdirSync(path))tree(join(path,name));return;}assert(s.isFile());closure[path]=sha(path);}
tree(root);tree('/work/native');
const metafile=JSON.parse(readFileSync(source+'/.tasks/coherence-cli/cli-metafile.json'));
for(const input of Object.keys(metafile.inputs)){const p=resolve(source,input);assert(p.startsWith(source+'/'));buildInputs[p]=sha(p);assert.equal(closure[p],buildInputs[p]);}
for(const out of Object.values(metafile.outputs))for(const item of out.imports)if(item.external&&!isBuiltin(item.path)){const from=source+'/.tasks/coherence-cli/cli.mjs';try{const entry=realpathSync(createRequire(from).resolve(item.path));assert(entry.startsWith(source+'/'));resolutions.push({name:item.path,from,entry});}catch(e){if(createRequire(from).resolve(item.path)===item.path)continue;throw e;}}
const nativeClosures={},loaderResolutions={};
for(const [key,binary] of [['native','/work/native/tmux'],['stock',root+'/stock/tmux']]){
 nativeClosures[key]=elfClosure(binary,{...host.elf,readelf:host.tools.readelf.path});Object.assign(closure,nativeClosures[key].files);
 if(key==='native')Object.assign(closure,nativeBundleFiles(binary,host.native.journalPatchSha256));
 const r=spawnSync(host.elf.interpreter,['--list',binary],{encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:host.environment.PATH,LC_ALL:'C'}});
 writeFileSync('/evidence/'+key+'-loader.stdout',r.stdout??'',{flag:'wx',mode:0o600});writeFileSync('/evidence/'+key+'-loader.stderr',r.stderr??'',{flag:'wx',mode:0o600});writeFileSync('/evidence/'+key+'-loader-status.json',JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message}),{flag:'wx',mode:0o600});assert(!r.error&&r.status===0&&!r.signal);loaderResolutions[key]=verifyLoaderListing(r.stdout,nativeClosures[key],{mainExecutable:binary});
}
const sharedClosures={};for(const name of imported.sharedObjects){if(name==='linux-vdso.so.1')continue;assert(name.startsWith('/'));const p=realpathSync(name);sharedClosures[p]=elfClosure(p,{...host.elf,readelf:host.tools.readelf.path});Object.assign(closure,sharedClosures[p].files);}
const tools={};for(const p of ['/opt/node26/bin/node','/pinned/bun','/usr/bin/git','/bin/ps','/usr/bin/getconf','/usr/bin/readelf','/usr/bin/make','/usr/bin/cc','/usr/bin/ld','/usr/bin/as','/usr/bin/ar','/usr/bin/autoconf','/usr/bin/automake','/usr/bin/pkg-config','/usr/bin/m4','/usr/bin/perl','/bin/sh','/usr/bin/python3']){const path=realpathSync(p);tools[p]={path,sha256:sha(path)};closure[path]=sha(path);}
// Preparation inputs are retained at immutable /work/current/preparation-inputs paths,
// leaving future /inputs/descriptor.json free for its actual campaign authority.
const receipt={reviewed:false,performanceQualified:false,fixturesStarted:false,source:d.source,upstream:d.upstream,sourceDefaultBatchMs:0,nativeDefaultEnabled:false,preparedImage:d.image,cli:source+'/.tasks/coherence-cli/cli.mjs',cliSha256:sha(source+'/.tasks/coherence-cli/cli.mjs'),metafileSha256:sha(source+'/.tasks/coherence-cli/cli-metafile.json'),buildInputs,closure,links,resolutions,nativeClosures,loaderResolutions,sharedClosures,tools,originalClosureUnchanged:true,stock:JSON.parse(readFileSync('/evidence/stock-source.json')),processHost:JSON.parse(readFileSync(root+'/process-host.json')),imports:imported};
writeFileSync('/evidence/coherence-receipt.json',JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
