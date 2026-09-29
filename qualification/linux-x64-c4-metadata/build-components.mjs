import assert from 'node:assert/strict';import {readFileSync,writeFileSync,realpathSync} from 'node:fs';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {resolve,join} from 'node:path';
assert.equal(process.versions.bun,'1.4.2');
const root='/work/source',here=root+'/.tasks/components-linux',require=createRequire(root+'/package.json');const {build}=require('esbuild');const {cliBundlePlugins}=await import(root+'/scripts/lib/cli-bundle-policy.mjs');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const inputs={};
for(const lane of ['metadata','tail','parser']){
 const result=await build({absWorkingDir:root,entryPoints:[here+'/'+lane+'/candidate.ts'],outfile:here+'/'+lane+'/candidate.mjs',bundle:true,platform:'node',target:'node20',format:'esm',metafile:true,plugins:cliBundlePlugins()});
 for(const name of Object.keys(result.metafile.inputs)){const path=realpathSync(resolve(root,name));assert(path.startsWith(root+'/'));inputs[path]=sha(path);}
 writeFileSync(here+'/'+lane+'/candidate-metafile.json',JSON.stringify(result.metafile,null,2),{flag:'wx',mode:0o600});
}
writeFileSync('/evidence/component-build-inputs.json',JSON.stringify({inputs,builtLanes:['metadata','tail','parser'],driver:process.versions},null,2),{flag:'wx',mode:0o600});
