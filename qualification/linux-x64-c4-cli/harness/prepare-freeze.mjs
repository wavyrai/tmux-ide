import { admitCampaignHost } from "./host-inputs.mjs";
// Preparation only: requires reviewed host-local artifacts and complete build/dependency receipts.
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,realpathSync,existsSync,mkdirSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFileSync} from 'node:child_process';
import {linuxHost} from './linux-host.mjs';import {elfClosure,verifyLoaderListing,nativeBundleFiles} from './elf-closure.mjs';
const here=dirname(fileURLToPath(import.meta.url));const [hostPath,receiptPath,lane,destination,output]=process.argv.slice(2);assert(['cpu','idle'].includes(lane));assert(destination&&output&&!existsSync(destination)&&!existsSync(output));
const hostInputs=JSON.parse(readFileSync(hostPath));
const receipt=JSON.parse(readFileSync(receiptPath));
const host=admitCampaignHost(hostInputs,receipt.hostArtifactSha256);await linuxHost(host).assertIdentity();assert.equal(receipt.reviewed,true);assert.equal(receipt.sourceBase,host.candidate.base);assert.equal(receipt.observationBatchMs,32);assert.equal(receipt.nativeDefaultEnabled,false);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const closure={...receipt.closure};assert(Object.keys(closure).length>1000);
for(const [p,d] of Object.entries(closure))assert.equal(sha(p),d,`Build/dependency input changed ${p}`);
const build=JSON.parse(readFileSync(receipt.buildReceiptPath));assert.equal(sha(receipt.buildReceiptPath),receipt.buildReceiptSha256);
assert.equal(build.cliSha256,receipt.cliSha256);assert.equal(build.observer,receipt.observerPath);assert.equal(build.observerSha256,receipt.observerSha256);
assert.equal(build.bunSha256,host.tools.bun.sha256);assert.equal(build.sourceHead,host.candidate.base);
for(const [p,digest] of Object.entries(build.inputs)){assert.equal(sha(p),digest);assert.equal(closure[p],digest);}
assert.equal(sha(receipt.metafilePath),build.metafileSha256);
const metafile=JSON.parse(readFileSync(receipt.metafilePath));assert(Object.keys(metafile.inputs).some(p=>resolve(receipt.sourceRoot,p)===receipt.observerPath));
assert.equal(sha(receipt.cli),receipt.cliSha256);assert.equal(sha(host.native.path),host.native.sha256);assert.equal(sha(host.reference.path),host.reference.sha256);
assert.equal(receipt.importPreflight.fixturesStarted,false);assert.equal(receipt.importPreflight.nativeTypeScriptImportGraph,'passed');assert.equal(receipt.wait4RegressionPassed,true);assert.equal(receipt.elfLoaderAuditPassed,true);
// Build receipt must pin actual source and runtime default policy, never infer it from root's default0.
const observer=readFileSync(receipt.observerPath,'utf8');assert(observer.includes('options.timing?.observationBatchMs ?? 32'));assert(observer.includes('timeoutMs: Math.max(this.#commandMs, this.#waitMs)'));
assert.equal(sha(receipt.observerPath),receipt.observerSha256);assert(Object.hasOwn(closure,receipt.observerPath));
const add=p=>closure[realpathSync(p)]=sha(p);
for(const path of [hostPath,receiptPath,receipt.cli,...Object.values(host.tools).map(t=>t.path)])add(path);
for(const name of readdirSync(here))if(/\.(mjs|ts|py|md|log)$/.test(name))add(join(here,name));
const nativeClosure={};for(const [key,binary] of [['native',host.native.path],['reference',host.reference.path]]){nativeClosure[key]=elfClosure(binary,{...host.elf,readelf:host.tools.readelf.path});Object.assign(closure,nativeClosure[key].files,nativeBundleFiles(binary,key==='native'?host.native.journalPatchSha256:undefined));}
assert.equal(sha(host.elf.interpreter),host.elf.interpreterSha256);add(host.elf.interpreter);
const loaderResolutions={};for(const [key,binary] of [['native',host.native.path],['reference',host.reference.path]])loaderResolutions[key]=verifyLoaderListing(execFileSync(host.elf.interpreter,['--list',binary],{encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:host.environment.PATH,LC_ALL:'C'}}),nativeClosure[key],{mainExecutable:binary});
const cleanHome=resolve(dirname(destination),'home-'+lane);mkdirSync(cleanHome,{mode:0o700});
writeFileSync(destination,JSON.stringify({lane,output:resolve(output),cleanHome,host,hostInputs,hostArtifactSha256:receipt.hostArtifactSha256,node:host.tools.node.path,binary:host.native.path,binarySha256:host.native.sha256,referenceBinary:host.reference.path,referenceSha256:host.reference.sha256,cliSha256:receipt.cliSha256,systemPath:host.environment.PATH,closure,resolutions:receipt.resolutions,elfClosure:nativeClosure,loaderResolutions,sourceReceipt:receiptPath},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({spec:resolve(destination),sha256:sha(destination),files:Object.keys(closure).length}));
