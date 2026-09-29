import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
process.argv[2]='/evidence/frozen-tail.json';
await import('/work/source/.tasks/native-x64-c4/harness/verify.mjs');
const {elfClosure}=await import('/work/source/.tasks/native-x64-c4/harness/elf-closure.mjs');
const spec=JSON.parse(readFileSync(process.argv[2]));
for(const [path,expected] of Object.entries(spec.componentSharedClosures))assert.deepEqual(elfClosure(path,{...spec.host.elf,readelf:spec.host.tools.readelf.path}),expected);
console.log('Component shared ELF, fresh host and full source/tool/artifact closure verified');
