import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { admitRetainedNative, assertIntelMachO } from './native-input.mjs';
const evidence = process.env.DARWIN_X64_NATIVE_EVIDENCE;
assert(evidence, 'Set DARWIN_X64_NATIVE_EVIDENCE to the retained reviewed evidence directory');
const manifest = readFileSync(resolve(evidence, 'bundle/manifest.json'));
const review = JSON.parse(readFileSync(resolve(evidence, 'root-reviewed.json')));
function read(name) {
  const path = resolve(evidence, 'bundle', name);
  const st = lstatSync(path);
  assert(st.isFile() && !st.isSymbolicLink());
  return readFileSync(path);
}
test('retained Intel native bytes admit only preparation, not performance', () => {
  assert.equal(admitRetainedNative(manifest, review, read).performanceQualified, false);
});
test('changed manifest and changed native bytes are rejected before execution', () => {
  assert.throws(() => admitRetainedNative(Buffer.from('{}'), review, read));
  assert.throws(() => admitRetainedNative(manifest, review, name => name === 'tmux' ? Buffer.alloc(32) : read(name)));
});
test('ARM and universal Mach-O headers cannot masquerade as native Intel', () => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  assert.throws(() => assertIntelMachO(header));
  header.writeUInt32LE(0xcafebabe, 0);
  assert.throws(() => assertIntelMachO(header));
});
test('failed qualification cleanup cannot become an admitted native input', () => {
  assert.throws(() => admitRetainedNative(manifest, { ...review, cleanup: false }, read));
});
