const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=process.cwd(),root=path.join(repo,'.tasks/native-reliability-mission/nr08-protocol-v3'),source=path.join(root,'source');
const lock=require(path.join(repo,'node_modules/js-yaml')).load(fs.readFileSync(path.join(source,'pnpm-lock.yaml'),'utf8'));
const meta=JSON.parse(fs.readFileSync(path.join(root,'build-metafile.json')));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const externals=[...new Set(Object.values(meta.outputs).flatMap(o=>o.imports.filter(i=>i.external&&!i.path.startsWith('node:')).map(i=>i.path.startsWith('@')?i.path.split('/').slice(0,2).join('/'):i.path.split('/')[0])))];
const cache=path.join(repo,'node_modules/.pnpm'),audit={sourceCommit:'0806cd438099b0dc8fb581bcca5a51a196b8df72',externals,packages:[],skippedOptional:[],errors:[],inputs:[]};
const version=v=>v.split('(')[0];
for(const name of externals){const spec=lock.importers['.'].dependencies[name];if(!spec)throw Error('missing locked direct '+name);const expected=version(spec.version);const candidates=fs.readdirSync(cache).map(d=>path.join(cache,d,'node_modules',name)).filter(p=>fs.existsSync(path.join(p,'package.json'))&&JSON.parse(fs.readFileSync(path.join(p,'package.json'))).version===expected);if(!candidates.length)throw Error('missing exact cached '+name+'@'+expected);const dest=path.join(source,'node_modules',name);fs.mkdirSync(path.dirname(dest),{recursive:true});if(!fs.existsSync(dest))fs.symlinkSync(candidates[0],dest);}
function resolvePackage(name,from){let dir=from;while(true){const p=path.join(dir,'node_modules',name,'package.json');if(fs.existsSync(p))return fs.realpathSync(path.dirname(p));const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;}}
const visited=new Set();
function walk(name,ref,from,optional=false){const location=resolvePackage(name,from);if(!location){if(optional){audit.skippedOptional.push({name,ref,reason:'not installed'});return;}audit.errors.push('missing '+name+' from '+from);return;}const p=JSON.parse(fs.readFileSync(path.join(location,'package.json')));if(p.os&&!p.os.includes(process.platform)||p.cpu&&!p.cpu.includes(process.arch)){if(optional){audit.skippedOptional.push({name,ref,reason:'other platform'});return;}}
 if(p.version!==version(ref)){audit.errors.push('version mismatch '+name+' expected '+ref+' actual '+p.version);return;}
 const key=name+'@'+ref;if(visited.has(key+'|'+location))return;visited.add(key+'|'+location);
 audit.packages.push({name,lockedRef:ref,version:p.version,location,manifestSha256:hash(path.join(location,'package.json'))});
 const snapshot=lock.snapshots[key];if(!snapshot){audit.errors.push('missing lock snapshot '+key);return;}
 for(const [dep,v]of Object.entries(snapshot.dependencies||{}))walk(dep,v,location);
 for(const [dep,v]of Object.entries(snapshot.optionalDependencies||{}))walk(dep,v,location,true);
 for(const dep of Object.keys(p.peerDependencies||{})){const actual=resolvePackage(dep,location);if(!actual){if(!p.peerDependenciesMeta?.[dep]?.optional)audit.errors.push('missing peer '+dep+' of '+key);continue;}const got=JSON.parse(fs.readFileSync(path.join(actual,'package.json'))).version;const match=ref.match(new RegExp('\\('+dep.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'@([^()]+)\\)'));if(match&&got!==match[1])audit.errors.push('peer skew '+key+' '+dep+' '+got);if(match)walk(dep,match[1],location);}
}
for(const n of externals)walk(n,lock.importers['.'].dependencies[n].version,source);
for(const input of Object.keys(meta.inputs)){const abs=path.resolve(repo,input),real=fs.realpathSync(abs);audit.inputs.push({path:input,realpath:real,sha256:hash(real)});if(real.startsWith(path.join(repo,'packages')+'/'))audit.errors.push('current workspace input '+real);if(!real.startsWith(source+'/')&&!real.includes('/node_modules/.pnpm/@xterm+addon-unicode11@0.9.0/'))audit.errors.push('unexpected input '+real);}
audit.cliSha256=hash(path.join(source,'bin/cli-v3.mjs'));audit.lockSha256=hash(path.join(source,'pnpm-lock.yaml'));audit.protectedCliSha256=hash(path.join(repo,'bin/cli.js'));audit.passed=audit.errors.length===0;fs.writeFileSync(path.join(root,'dependency-audit.json'),JSON.stringify(audit,null,2));console.log(JSON.stringify({passed:audit.passed,externalCount:externals.length,packages:audit.packages.length,inputs:audit.inputs.length,errors:audit.errors}));if(!audit.passed)process.exitCode=1;
