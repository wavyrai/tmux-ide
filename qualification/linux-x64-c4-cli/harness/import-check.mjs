// Imports the exact dependency specifiers declared by case.mjs, without evaluating its body.
import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';
const source=readFileSync(new URL('./case.mjs',import.meta.url),'utf8');
const imports=[...source.matchAll(/^import\s.*?from\s*['"]([^'"]+)['"];$/gm)].map(m=>m[1]);
assert(imports.includes('./daemon-traced.ts'));
assert(imports.includes('../../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts'));
for(const specifier of imports)await import(specifier.startsWith('.')?new URL(specifier,import.meta.url).href:specifier);
console.log(JSON.stringify({node:process.version,nativeTypeScriptImportGraph:'passed',imports,fixturesStarted:false}));
