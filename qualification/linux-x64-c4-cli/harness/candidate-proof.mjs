import assert from 'node:assert/strict';
import {resolve} from 'node:path';
export function assertCandidateInput(meta,root,source){
 const expected=resolve(root,'packages/daemon/src/lib/native-tmux-interaction-observer.ts');
 assert(Object.keys(meta.inputs).some(p=>resolve(root,p)===expected),'Candidate observer missing from actual build inputs');
 assert.match(source,/this\.#observationBatchMs\s*=\s*options\.timing\?\.observationBatchMs\s*\?\?\s*32\s*;/,'Candidate source must default32');
 return expected;
}
