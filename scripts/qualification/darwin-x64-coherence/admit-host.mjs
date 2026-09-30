// Admission invokes no tmux, daemon, CLI or workload. node-pty import loads its actual x64 addon only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cpus,loadavg,totalmem} from 'node:os';
import {machInputs} from './upstream-mach-inputs.mjs';
const [bindingPath,output]=process.argv.slice(2),b=JSON.parse(readFileSync(bindingPath));
assert.equal(process.platform,'darwin');assert.equal(process.arch,'x64');assert.equal(process.version,'v26.8.2');
assert.equal(b.executionAuthorized,false);
const run=(exe,args)=>execFileSync(exe,args,{encoding:'utf8',timeout:10000,maxBuffer:1048576,env:{...process.env,LC_ALL:'C',TZ:'UTC'}}).trim();
assert.equal(run('/usr/bin/uname',['-m']),'x86_64');
const translated=run('/usr/sbin/sysctl',['-in','sysctl.proc_translated']);assert(['','0'].includes(translated),'Translated process rejected');
const boot=run('/usr/sbin/sysctl',['-n','kern.boottime']);assert.match(boot,/sec = \d+/);
const source=b.paths.source,req=createRequire(source+'/packages/daemon/package.json');
assert.equal(typeof req('node-pty').spawn,'function');
const cliReq=createRequire(b.paths.cli),original=JSON.parse(readFileSync(b.archiveRoot+'/cli-receipt.json'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),resolutions={};
for(const [name,row] of Object.entries(original.externalResolutions)){
 const path=realpathSync(cliReq.resolve(name));assert(path.startsWith(source+'/'));assert.equal(hash(path),row.sha256);resolutions[name]={path,sha256:row.sha256};
}
const shared=process.report.getReport().sharedObjects.filter(p=>!p.startsWith('/usr/lib/')&&!p.startsWith('/System/Library/'));
const mach=machInputs([...new Set([b.paths.node,b.paths.bun,b.paths.native,b.paths.stock,...shared])]);
for(const p of Object.keys(mach.files))assert(p.startsWith(b.archiveRoot+'/')||p.startsWith(b.stockRoot+'/'),'Unadmitted loader dependency');
const tools={};for(const p of ['/bin/ps','/usr/bin/pgrep','/usr/bin/otool','/usr/bin/sw_vers','/usr/bin/uname','/usr/sbin/sysctl','/usr/bin/clang','/usr/bin/xcrun'])tools[p]={resolved:realpathSync(p),sha256:hash(realpathSync(p))};
writeFileSync(output,JSON.stringify({platform:'darwin',arch:'x64',node:process.version,boot,translated,os:run('/usr/bin/sw_vers',[]),cpu:cpus(),memoryBytes:totalmem(),load:loadavg(),runnerImage:{image:process.env.ImageOS??null,version:process.env.ImageVersion??null},mach,resolutions,tools,nodePtyLoaded:true,productModulesEvaluated:false,hostScope:'Fresh hosted runner; load disclosed, not exclusive-host proof'},null,2),{flag:'wx',mode:0o600});
