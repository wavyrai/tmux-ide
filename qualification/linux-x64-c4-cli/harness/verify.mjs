import { admitCampaignHost } from "./host-inputs.mjs";
import assert from 'node:assert/strict';import {readFileSync,realpathSync} from 'node:fs';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
import {validateHostDescriptor} from './host-descriptor.mjs';import {linuxHost} from './linux-host.mjs';import {elfClosure,verifyLoaderListing,nativeBundleFiles} from './elf-closure.mjs';
const spec=JSON.parse(readFileSync(process.argv[2]));validateHostDescriptor(spec.host);assert.deepEqual(admitCampaignHost(spec.hostInputs,spec.hostArtifactSha256),spec.host);const host=linuxHost(spec.host);await host.assertIdentity();
assert(Object.keys(spec.closure).length>1000);const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const [p,digest] of Object.entries(spec.closure))assert.equal(sha(p),digest,`Changed ${p}`);
for(const t of Object.values(spec.host.tools))assert.equal(sha(t.path),t.sha256);
for(const r of spec.resolutions)assert.equal(realpathSync(createRequire(r.from).resolve(r.name)),r.entry);
for(const [key,binary] of [['native',spec.binary],['reference',spec.referenceBinary]])for(const [path,digest] of Object.entries(nativeBundleFiles(binary,key==='native'?spec.host.native.journalPatchSha256:undefined)))assert.equal(spec.closure[path],digest,'Native bundle tree changed');
assert.equal(sha(spec.binary),spec.binarySha256);assert.equal(sha(spec.referenceBinary),spec.referenceSha256);
for(const [key,binary] of [['native',spec.binary],['reference',spec.referenceBinary]])assert.deepEqual(elfClosure(binary,{...spec.host.elf,readelf:spec.host.tools.readelf.path}),spec.elfClosure[key]);
assert.equal(sha(spec.host.elf.interpreter),spec.host.elf.interpreterSha256);
for(const [key,binary] of [['native',spec.binary],['reference',spec.referenceBinary]]){const output=execFileSync(spec.host.elf.interpreter,['--list',binary],{encoding:'utf8',timeout:5000,maxBuffer:1048576,env:{PATH:spec.systemPath,LC_ALL:'C'}});assert.deepEqual(verifyLoaderListing(output,spec.elfClosure[key],{mainExecutable:binary}),spec.loaderResolutions[key]);}
assert.equal(execFileSync(spec.host.tools.node.path,['--version'],{encoding:'utf8',timeout:5000}).trim(),'v'+spec.host.tools.node.version);
console.log('Portable host, process clock, artifact/dependency and ELF closure verified');
