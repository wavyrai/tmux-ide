import test from 'node:test';import assert from 'node:assert/strict';import {elfClosure,parseElfInspection} from './elf-closure.mjs';
const elf=(needed=[],extra='')=>'Class: ELF64\nMachine: AArch64\n'+needed.map(n=>` (NEEDED) Shared library: [${n}]`).join('\n')+'\n'+extra;
test('ELF closure pins interpreter, origin bundle library, system dependency and actual targets',()=>{
 const data={'/bundle/tmux':elf(['libx.so','libc.so'],'(RUNPATH) Library runpath: [$ORIGIN/lib]\n[Requesting program interpreter: /sys/ld.so]'),'/bundle/lib/libx.so':elf(),'/sys/libc.so':elf(),'/sys/ld.so':elf()};
 const result=elfClosure('/bundle/tmux',{machine:'AArch64',systemDirs:['/sys'],realpath:p=>p,exists:p=>Object.hasOwn(data,p),read:p=>Buffer.from(data[p]),inspect:p=>data[p]});
 assert.equal(Object.keys(result.files).length,4);assert(result.resolutions.some(r=>r.resolved==='/sys/ld.so'));
});
test('rejects wrong architecture, RPATH, missing or escaped ELF dependencies',()=>{
 assert.throws(()=>parseElfInspection(elf([], '(RPATH) Library rpath: [/sys]')));
 for(const binary of [elf().replace('AArch64','Advanced Micro Devices X86-64'),elf(['missing']),elf([], '(RUNPATH) Library runpath: [/outside]')])assert.throws(()=>elfClosure('/bundle/tmux',{machine:'AArch64',systemDirs:['/sys'],realpath:p=>p,exists:()=>false,read:()=>Buffer.from('x'),inspect:()=>binary}));
});
import {verifyLoaderListing} from './elf-closure.mjs';
test('actual loader audit refuses a cache-selected unpinned library',()=>{
 const closure={files:{'/sys/ld.so':'hash','/sys/libc.so':'hash'}};
 assert.deepEqual(verifyLoaderListing('linux-vdso.so.1 (0xab)\nlibc.so => /sys/libc.so (0x12)\n/sys/ld.so (0x34)\n',closure,{realpath:p=>p}),['/sys/libc.so','/sys/ld.so']);
 assert.throws(()=>verifyLoaderListing('libc.so => /unreviewed/libc.so (0x12)\n',closure,{realpath:p=>p}));
 assert.throws(()=>verifyLoaderListing('libc.so => not found\n',closure,{realpath:p=>p}));
});
test('optional first unnamed main mapping binds only to caller-pinned executable',()=>{
 const closure={files:{'/bundle/tmux':'hash','/sys/ld.so':'hash','/sys/libc.so':'hash'}};
 const named='linux-vdso.so.1 (0xab)\nlibc.so => /sys/libc.so (0x12)\n/sys/ld.so (0x34)\n';
 const options={realpath:p=>p,mainExecutable:'/bundle/tmux'};
 const expected=['/bundle/tmux','/sys/libc.so','/sys/ld.so'];
 assert.deepEqual(verifyLoaderListing('(0x1234)\n'+named,closure,options),expected);
 assert.deepEqual(verifyLoaderListing(named,closure,options),expected);
 assert.throws(()=>verifyLoaderListing('(0x1234)\n'+named,closure,{realpath:p=>p}),/Unclassified/);
 assert.throws(()=>verifyLoaderListing('(0x1234)\n'+named,closure,{...options,mainExecutable:'/unreviewed'}),/Unpinned/);
 for(const text of ['(0x1234)\n(0x3456)\n'+named,named+'(0x1234)\n'])assert.throws(()=>verifyLoaderListing(text,closure,options),/Unclassified/);
 assert.throws(()=>verifyLoaderListing('(0x1234)\n/sys/ld.so (0x34)\n',closure,options),/Missing loader dependency/);
 assert.throws(()=>verifyLoaderListing('(0x1234)\n'+named+'/sys/libc.so (0x99)\n',closure,options),/Duplicate/);
 assert.throws(()=>verifyLoaderListing('(0x1234)\n'+named+'/unknown.so (0x99)\n',closure,options),/unpinned/);
});
