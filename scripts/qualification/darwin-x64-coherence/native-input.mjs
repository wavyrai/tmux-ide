// Read-only preparation admission. This never starts tmux or establishes performance qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const QUALIFIED_TMUX = '4998ab3bde94e588a0c4ef300e0de657cfb39d7b0689f10627517a989b7fcaf7';
export const JOURNAL_PATCH = 'fab780c9ca4a8452fbf73d5ed04e0d9420c887c6006c84b9d0c83a89af80aa0d';
export function assertIntelMachO(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 32, 'Missing Mach-O header');
  assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'Requires thin 64-bit Mach-O');
  assert.equal(bytes.readUInt32LE(4), 0x01000007, 'Requires native x86_64 Mach-O');
}
export function admitRetainedNative(manifestBytes, reviewed, readRelative) {
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), 'a968edf132992eb9ccfe8939d0c5f5aeb7de8f6b07d81d1878e4d36be33a7d21', 'Retained manifest changed');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(reviewed.reviewedByRoot, true);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, 'darwin');
  assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.minimumMacOS, '15.0');
  assert.equal(manifest.commit, 'e476c1230b958df0cb12977517d24b3dc931375b');
  assert.equal(manifest.files.tmux, QUALIFIED_TMUX);
  assert(manifest.patches.some(p => p.patch === 'interaction-journal-v1.patch' && p.patchSha256 === JOURNAL_PATCH));
  assert.equal(reviewed.tmuxSha256, QUALIFIED_TMUX);
  assert.equal(reviewed.sanitizerPassed, true);
  assert.equal(reviewed.cleanup, true);
  assert.equal(reviewed.tests, 18);
  const entries = Object.entries(manifest.files);
  assert.equal(entries.length, 8);
  for (const [name, hash] of entries) {
    assert(/^(?:tmux|(?:lib|licenses)\/[A-Za-z0-9_.-]+)$/.test(name), 'Unsafe bundle path');
    assert.match(hash, /^[0-9a-f]{64}$/);
    const bytes = readRelative(name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, 'Retained bundle bytes changed');
    if (name === 'tmux' || name.startsWith('lib/')) assertIntelMachO(bytes);
  }
  return Object.freeze({ platform: 'darwin', arch: 'x64', nativeSha256: QUALIFIED_TMUX, performanceQualified: false });
}
