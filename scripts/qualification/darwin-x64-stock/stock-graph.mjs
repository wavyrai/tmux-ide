import assert from 'node:assert/strict';
import { basename,dirname,join } from 'node:path';
export function validateStockDependencies(graph,source,output,mode,retainedManifest) {
 assert(['host-stock','unpatched-source'].includes(mode));
 assert(Object.hasOwn(graph.files,source),'Source absent from Mach graph');
 const paths=Object.keys(graph.files).filter(path=>path!==source), names=paths.map(path=>basename(path));
 assert.equal(new Set(names).size,names.length,'Dependency basename collision');
 if(mode==='unpatched-source') {
  const expected=Object.keys(retainedManifest.files).filter(name=>name.startsWith('lib/')).map(path=>basename(path)).sort();
  assert.equal(expected.length,3);assert.deepEqual([...names].sort(),expected,'Unexpected runtime dependencies');
  assert(paths.every(path=>path.startsWith(join(dirname(output),'dependencies')+'/')),'Unexpected link-time dependency source');
 }
}
