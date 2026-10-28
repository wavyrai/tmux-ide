import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { copyBrowserPayload } from "./browser-payload.mjs";

test("copies a complete regular payload and rejects links without replacing existing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-payload-test-"));
  try {
    const source = join(root, "source"),
      dest = join(root, "destination");
    for (const file of [
      "terminal-browser",
      "browser-launch.mjs",
      "runtime.json",
      "browser-runtime.tar.gz",
      "cli/dist/main.js",
      "browser/dist/main.js",
      "ASSEMBLY.json",
    ]) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(join(source, file), file);
    }
    const inventory = await copyBrowserPayload(source, dest);
    assert.equal(Object.keys(inventory).length, 7);
    assert.equal(await readFile(join(dest, "cli/dist/main.js"), "utf8"), "cli/dist/main.js");
    await assert.rejects(copyBrowserPayload(source, dest), { code: "EEXIST" });
    await symlink("/tmp", join(source, "unsafe"));
    await assert.rejects(copyBrowserPayload(source, join(root, "other")), /links/);
    assert.equal(await readFile(join(dest, "terminal-browser"), "utf8"), "terminal-browser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
