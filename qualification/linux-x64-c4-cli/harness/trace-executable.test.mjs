import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveChildExecutable} from './trace-executable.mjs';
test('resolves child PATH and cwd instead of parent ambient authority; fails unresolved',()=>{
 const root=mkdtempSync(join(tmpdir(),'trace-path-'));
 try{mkdirSync(join(root,'bin'));symlinkSync(process.execPath,join(root,'bin','tmux'));
  const parent={cwd:'/',env:{PATH:'/absent'}};
  assert.equal(resolveChildExecutable('tmux',{cwd:root,env:{PATH:'bin'}},parent),realpathSync(process.execPath));
  assert.equal(resolveChildExecutable('./bin/tmux',{cwd:root},parent),realpathSync(process.execPath));
  assert.equal(resolveChildExecutable('tmux',{cwd:root,env:{PATH:'/absent'}},parent),null);
  writeFileSync(join(root,'bin','not-executable'),'x',{mode:0o600});assert.equal(resolveChildExecutable('not-executable',{cwd:root,env:{PATH:'bin'}},parent),null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
