// Preparation only; never imports or starts a reader, CLI, daemon or tmux.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
assert.equal(process.versions.bun,'1.4.2');
assert.equal(process.platform,'darwin');assert.equal(process.arch,'x64');
assert.equal(process.argv[2],'--prepare-readers');
const binding=JSON.parse(readFileSync(process.argv[3],'utf8'));
assert.equal(binding.executionAuthorized,false);
assert.equal(binding.runtimePatch,null);
assert(binding.payloadMembersVerified>160000,'Full payload admission required');
const root=realpathSync(binding.paths.source),overlay=realpathSync(process.argv[4]);
assert(!overlay.startsWith(root+'/'),'Overlay must not mutate source closure');
const req=createRequire(join(root,'package.json')),{build}=req('esbuild');
const {cliBundlePlugins}=await import(join(root,'scripts/lib/cli-bundle-policy.mjs'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const originalCli=hash(binding.paths.cli),inputs={},outputs={};
for(const lane of ['metadata','tail','parser']){
 const dir=join(overlay,lane),outfile=join(dir,'candidate.mjs');
 assert(!existsSync(outfile),'Refusing reader rebuild');
 const result=await build({absWorkingDir:root,entryPoints:[join(dir,'candidate.ts')],outfile,bundle:true,platform:'node',target:'node20',format:'esm',metafile:true,plugins:cliBundlePlugins()});
 for(const key of Object.keys(result.metafile.inputs)){
  const p=realpathSync(resolve(root,key));assert(p.startsWith(root+'/')||p===join(dir,'candidate.ts'),'Unexpected reader input');inputs[p]=hash(p);
 }
 writeFileSync(join(dir,'candidate-metafile.json'),JSON.stringify(result.metafile,null,2),{flag:'wx',mode:0o600});outputs[outfile]=hash(outfile);
}
assert.equal(hash(binding.paths.cli),originalCli,'CLI changed');
writeFileSync(join(overlay,'reader-build-receipt.json'),JSON.stringify({sourceCommit:binding.sourceCommit,observerSha256:binding.observerSha256,cliSha256:originalCli,cliRebuilt:false,inputs,outputs,readersExecuted:false},null,2),{flag:'wx',mode:0o600});
