// Build is a separately authorized preparation action; never invoked by a live case.
import {readFileSync,writeFileSync,existsSync,statSync,readdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {validateHostDescriptor} from './host-descriptor.mjs';
import {assertCandidateInput} from './candidate-proof.mjs';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../..');
const metaPath=join(here,'cli-metafile.json'),receiptPath=join(here,'build-receipt.json');
if(existsSync(metaPath)||existsSync(receiptPath))throw Error('Refusing overwrite build evidence');
const descriptor=validateHostDescriptor(JSON.parse(readFileSync(process.argv[2])));
if(process.platform!=='linux'||process.arch!=='x64')throw Error('Linux x64 preparation only');
const bun=descriptor.tools.bun.path;
if(createHash('sha256').update(readFileSync(bun)).digest('hex')!==descriptor.tools.bun.sha256)throw Error('Bun pin changed');
if(execFileSync(bun,['--version'],{encoding:'utf8',timeout:5000}).trim()!=='1.4.2')throw Error('Requires pinned Bun1.4.2');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const paths=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(p=>p&&p!=='bin/cli.js'&&existsSync(join(root,p))&&statSync(join(root,p)).isFile());
const before=Object.fromEntries(paths.map(p=>[resolve(root,p),sha(resolve(root,p))]));
const sourceHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(sourceHead!==descriptor.candidate.base)throw Error('Expected exact cb6 base with reviewed candidate patch');
const sourceDiff=execFileSync('git',['diff','--binary','--','.',':(exclude)bin/cli.js'],{cwd:root});
const sourceDiffSha256=createHash('sha256').update(sourceDiff).digest('hex');
const dependencyResolutions=[];
function snapshot(dir){for(const name of readdirSync(dir)){if(name==='node_modules')continue;const p=join(dir,name);if(statSync(p).isDirectory())snapshot(p);else before[realpathSync(p)]=sha(p);}}
const from=join(root,'packages/daemon/package.json'),req=createRequire(from);
for(const name of ['@tmux-ide/xterm-headless','@xterm/addon-unicode11']){
 const entry=realpathSync(req.resolve(name));let dir=dirname(entry);while(!existsSync(join(dir,'package.json')))dir=dirname(dir);
 dependencyResolutions.push({name,from,entry});snapshot(dir);
}

execFileSync(bun,['scripts/build-cli.mjs','--metafile',metaPath],{cwd:root,stdio:'inherit',timeout:120000});
const meta=JSON.parse(readFileSync(metaPath));
const observer=assertCandidateInput(meta,root,readFileSync(join(root,'packages/daemon/src/lib/native-tmux-interaction-observer.ts'),'utf8'));
const inputs={};for(const p of Object.keys(meta.inputs)){const path=resolve(root,p);if(!before[path]||before[path]!==sha(path))throw Error('Input changed during build: '+path);inputs[path]=before[path];}
for(const r of dependencyResolutions)if(realpathSync(createRequire(r.from).resolve(r.name))!==r.entry)throw Error('Bundled dependency resolution changed');
writeFileSync(receiptPath,JSON.stringify({sourceHead,sourceDiffSha256,dependencyResolutions,inputs,observer,observerSha256:inputs[observer],cliSha256:sha(join(root,'bin/cli.js')),metafileSha256:sha(metaPath),bunSha256:sha(bun)},null,2),{mode:0o600,flag:'wx'});
