import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function preflight(root,pins){
 for(const [relative,expected] of Object.entries(pins.referenceRequiredInputs)){
  const path=resolve(root,relative);assert(statSync(path).isFile(),`Missing required input ${relative}`);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),expected,`Required input changed ${relative}`);
 }
 const provenance=JSON.parse(readFileSync(resolve(root,'native/tmux/provenance.json')));
 assert.equal(provenance.commit,pins.reference.upstream);assert.equal(provenance.patches.length,1);assert.equal(provenance.patches[0].patch,'native-grid.patch');assert.equal(provenance.patches[0].patchSha256,pins.reference.gridPatchSha256);assert(!provenance.experimentalExtensions?.length);
 // Import only pure dependency modules, never the top-level native builder.
 const patches=await import(pathToFileURL(resolve(root,'scripts/lib/tmux-native-patches.mjs')).href);
 assert.equal(patches.readTmuxNativePatches(provenance,resolve(root,'native/tmux')).length,1);
 const elf=await import(pathToFileURL(resolve(root,'scripts/lib/linux-tmux-bundle.mjs')).href);assert.equal(typeof elf.assertElfArchitecture,'function');
 const decoder=await import(pathToFileURL(resolve(root,'packages/daemon/src/terminal/mirror/native-grid-capture.ts')).href);
 assert.equal(typeof decoder.decodeNativeGridCapture,'function');assert.equal(typeof decoder.isNativeBootstrapCapture,'function');
 return {passed:true,requiredInputs:pins.referenceRequiredInputs,decoderImported:true,builderExecuted:false,fixturesStarted:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await preflight(process.argv[2],JSON.parse(readFileSync(process.argv[3])))));
