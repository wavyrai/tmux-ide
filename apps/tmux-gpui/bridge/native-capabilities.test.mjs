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
