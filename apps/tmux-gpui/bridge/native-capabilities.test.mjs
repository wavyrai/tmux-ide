import process from "node:process";
const { AbortController } = globalThis;
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeSnapshotEncoding } from "./native-capabilities.mjs";

for (const [name, body, expected] of [
  ["supported", 'console.log(JSON.stringify({version:1,snapshotEncodings:["rle-v1"]}))', "rle-v1"],
  ["old binary", "process.exit(2)", "legacy"],
  [
    "unknown protocol",
    'console.log(JSON.stringify({version:2,snapshotEncodings:["rle-v1"]}))',
    "legacy",
  ],
  ["malformed", 'console.log("not JSON")', "legacy"],
  ["oversized", 'console.log("x".repeat(5000))', "legacy"],
  ["timeout", "setInterval(()=>{},1000)", "legacy"],
])
  test(`native capability query handles ${name}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmux-native-capabilities-"));
    try {
      const path = join(dir, "native");
      await writeFile(
        path,
        `#!${process.execPath}\nif(process.argv[2]!=="--tmux-bridge-capabilities")process.exit(3);\n${body}\n`,
        { mode: 0o700 },
      );
      assert.equal(await nativeSnapshotEncoding(path, { timeoutMs: 500 }), expected);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("missing and cancelled native capability queries fall back", async () => {
  assert.equal(await nativeSnapshotEncoding("/nonexistent/tmux-gpui"), "legacy");
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await nativeSnapshotEncoding(process.execPath, { signal: controller.signal }),
    "legacy",
  );
});

test("damage is selected only for a browser connection that supports full fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-native-capabilities-"));
  try {
    const path = join(dir, "native");
    await writeFile(
      path,
      `#!${process.execPath}\nconsole.log(JSON.stringify({version:1,snapshotEncodings:["rle-v1","rle-delta-v1"]}));\n`,
      { mode: 0o700 },
    );
    assert.equal(await nativeSnapshotEncoding(path), "rle-v1");
    assert.equal(await nativeSnapshotEncoding(path, { damage: true }), "rle-delta-v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("binary is selected only for a supported browser transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tmux-native-capabilities-"));
  try {
    const path = join(dir, "native");
    await writeFile(
      path,
      `#!${process.execPath}\nconsole.log(JSON.stringify({version:1,snapshotEncodings:["rle-v1","rle-delta-v1","binary-rle-v1"]}));\n`,
      { mode: 0o700 },
    );
    assert.equal(await nativeSnapshotEncoding(path), "rle-v1");
    assert.equal(await nativeSnapshotEncoding(path, { damage: true }), "binary-rle-v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
