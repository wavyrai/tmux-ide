import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrowserRuntime } from "./browser-runtime-load.mjs";

// Opt-in installed-engine qualification; ordinary unit tests need no signed payload.
const payload = process.env.TMUX_IDE_BROWSER_TEST_PAYLOAD;
test(
  "signed engine installs atomically, reuses cache and rejects tampering",
  { skip: !payload || process.platform !== "darwin" },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser-cache-test-")));
    try {
      const options = {
        archivePath: join(payload, "browser-runtime.tar.gz"),
        metadata: JSON.parse(await readFile(join(payload, "candidate.json"), "utf8")),
        destinationRoot: root,
      };
      const results = await Promise.all([loadBrowserRuntime(options), loadBrowserRuntime(options)]);
      assert.equal(results[0], results[1]);
      assert.deepEqual(await readdir(root), [options.metadata.sha256]);
      assert.equal(
        await loadBrowserRuntime({ ...options, archivePath: "/missing-cache-reuse-proof" }),
        results[0],
      );
      await writeFile(join(results[0], "Contents/Info.plist"), "tampered");
      await assert.rejects(loadBrowserRuntime(options));
      // Failed verification does not silently delete or replace an existing cache.
      assert.equal(await readFile(join(results[0], "Contents/Info.plist"), "utf8"), "tampered");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
