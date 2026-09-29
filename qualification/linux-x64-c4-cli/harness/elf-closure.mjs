import assert from 'node:assert/strict';import {dirname,resolve,isAbsolute} from 'node:path';
import {readFileSync,realpathSync,existsSync,readdirSync,lstatSync} from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
export function parseElfInspection(text){
 assert(/Class:\s+ELF64\b/.test(text),'ELF64 required');const machine=/Machine:\s+([^\n]+)/.exec(text)?.[1].trim();assert(machine,'ELF machine missing');
 const interpreter=/\[Requesting program interpreter: ([^\]]+)\]/.exec(text)?.[1]??null;
 const needed=[...text.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map(m=>m[1]);
 const runpath=/\(RUNPATH\)[^\n]*\[([^\]]*)\]/.exec(text)?.[1];const rpath=/\(RPATH\)[^\n]*\[([^\]]*)\]/.exec(text)?.[1];
 assert(rpath===undefined,'Legacy inherited RPATH requires separate loader model');
 return {machine,interpreter,needed,runpath:runpath===undefined?[]:runpath.split(':')};
}
export function elfClosure(binary,{machine,systemDirs,readelf,inspect=p=>execFileSync(readelf,['-W','-h','-l','-d',p],{encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}),realpath=realpathSync,exists=existsSync,read=readFileSync}){
 const files={},resolutions=[],pending=[binary],seen=new Set();
 const allowed=systemDirs.map(p=>realpath(p));const bundle=realpath(dirname(binary));
 const permitted=p=>p===bundle||p.startsWith(bundle+'/')||allowed.some(dir=>p===dir||p.startsWith(dir+'/'));
 for(const requested of pending){
  const path=realpath(requested);resolutions.push({requested,resolved:path});assert(permitted(path),'ELF dependency escaped approved roots');
  if(seen.has(path))continue;seen.add(path);assert(seen.size<=128,'ELF dependency bound');
  files[path]=createHash('sha256').update(read(path)).digest('hex');
  const info=parseElfInspection(inspect(path));assert.equal(info.machine,machine,'Wrong ELF architecture');
  if(info.interpreter){assert(isAbsolute(info.interpreter));pending.push(info.interpreter);}
  const search=info.runpath.map(value=>{const p=value.replaceAll('${ORIGIN}',dirname(path)).replaceAll('$ORIGIN',dirname(path));assert(p&&!p.includes('$')&&isAbsolute(p),'Unsupported ELF runpath');const actual=realpath(p);assert(permitted(actual),'Unapproved ELF runpath');return actual;});
  for(const name of info.needed){assert(!name.includes('/')&&!name.includes('\0'),'Unsupported DT_NEEDED path');const candidate=[...search,...allowed].map(dir=>resolve(dir,name)).find(exists);assert(candidate,`Missing ELF dependency ${name}`);pending.push(candidate);}
 }
 return {files,resolutions,loaderModel:'explicit per-object RUNPATH then pinned system directories; LD_* scrubbed; legacy RPATH rejected'};
}
/** Compare the exact pinned dynamic loader --list output; no ldd shell execution. */
export function verifyLoaderListing(output,closure,{realpath=realpathSync,mainExecutable}={}){
 const loaded=[],lines=output.split('\n').map(x=>x.trim()).filter(Boolean);
 const main=mainExecutable===undefined?null:realpath(mainExecutable);if(main)assert(Object.hasOwn(closure.files,main),'Unpinned main executable');
 for(const [index,line] of lines.entries()){
  // glibc explicit-loader trace may include its empty-name main map first.
  // Normalize to the caller-pinned executable; never discard an unknown mapping.
  if(/^\(0x[a-f0-9]+\)$/.test(line)){assert(main&&index===0,'Unclassified unnamed loader mapping');loaded.push(main);continue;}
  if(/^linux-vdso\.so\.1 \(0x[a-f0-9]+\)$/.test(line))continue;
  const match=/^(?:[^\s]+ => )?(\/[^\s]+) \(0x[a-f0-9]+\)$/.exec(line);assert(match,`Unparsed loader resolution ${line}`);
  const path=realpath(match[1]);assert(Object.hasOwn(closure.files,path),`Actual loader uses unpinned dependency ${path}`);loaded.push(path);
 }
 assert(loaded.length>0,'Empty loader audit');assert.equal(new Set(loaded).size,loaded.length,'Duplicate loader mapping');
 if(main)for(const path of Object.keys(closure.files))if(path!==main)assert(loaded.includes(path),'Missing loader dependency '+path);
 if(main&&!loaded.includes(main))loaded.unshift(main);
 return loaded;
}

export function nativeBundleFiles(binary,journalPatchSha256){
 const root=dirname(realpathSync(binary)),files={};
 const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json')));assert.equal(manifest.schemaVersion,1);
 if(journalPatchSha256)assert(manifest.patches.some(p=>p.patch==='interaction-journal-v1.patch'&&p.patchSha256===journalPatchSha256));
 function walk(dir){for(const name of readdirSync(dir)){const path=resolve(dir,name),st=lstatSync(path);assert(!st.isSymbolicLink(),'Native bundle symlink requires explicit manifest resolution');if(st.isDirectory())walk(path);else{assert(st.isFile());files[path]=createHash('sha256').update(readFileSync(path)).digest('hex');assert(Object.keys(files).length<=256);}}}
 walk(root);for(const [name,digest] of Object.entries(manifest.files)){const path=resolve(root,name);assert(path.startsWith(root+'/'));assert.equal(files[path],digest);}
 assert.equal(manifest.files[binary.slice(dirname(binary).length+1)],files[realpathSync(binary)]);return files;
}
