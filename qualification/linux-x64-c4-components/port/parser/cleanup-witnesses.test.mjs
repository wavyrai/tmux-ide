import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDescendants, requireSuccessfulExit } from './cleanup-witnesses.mjs';
test('recursively captures grandchildren, deduplicates cycles', async () => {
 const tree={1:[2,3],2:[4],3:[4],4:[1]};
 assert.deepEqual(await captureDescendants([1],async p=>tree[p]),{pids:[1,2,3,4],errors:[]});
});
test('retains roots and continues other branches after enumeration failure', async () => {
 const visited=[];
 const result=await captureDescendants([1,2],async p=>{visited.push(p);if(p===1)throw Error('ps failed');return p===2?[3]:[];});
 assert.deepEqual(result.pids,[1,2,3]);assert.deepEqual(visited,[1,2,3]);assert.equal(result.errors.length,1);
});
test('bounds traversal and retains uncertainty', async () => {
 const result=await captureDescendants([1],async p=>[p+1],3);
 assert.deepEqual(result.pids,[1,2,3]);assert.match(result.errors[0],/bound exceeded/);
});
test('rejects malformed descendant identity', async () => {
 const result=await captureDescendants([1],async()=>[NaN]);assert.equal(result.errors.length,1);
});
test('requires successful ordinary exit even when a result file exists', () => {
 requireSuccessfulExit({exitCode:0,signalCode:null});
 for(const child of [{exitCode:1,signalCode:null},{exitCode:null,signalCode:'SIGTERM'},{exitCode:null,signalCode:null}])assert.throws(()=>requireSuccessfulExit(child));
});

test('bounds total enumeration time and retains uncertainty', async () => {
 let now=0;const budgets=[];
 const result=await captureDescendants([1],async (pid,remaining)=>{budgets.push(remaining);now+=6;return [pid+1];},32,10,()=>now);
 assert.deepEqual(budgets,[10,4]);assert.match(result.errors[0],/deadline exceeded/);
});
