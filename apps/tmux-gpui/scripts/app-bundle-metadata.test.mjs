import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateBundleMetadata, readBundleMetadata, bundlePlist } from "./app-bundle-metadata.mjs";
const good = { bundleId: "com.tmux-ide.gpui.preview", version: "0.1.0", buildNumber: "1" };
test("strict preview metadata generates exact safe plist fields; development defaults remain", () => {
  const value = validateBundleMetadata(good);
  assert.ok(Object.isFrozen(value));
  const plist = bundlePlist(value);
  for (const text of [
    good.bundleId,
    good.version,
    ">1<",
    "tmux-ide Preview",
    "14.2",
    "tmux-ide-launcher",
  ])
    assert.ok(plist.includes(text));
  assert.match(bundlePlist(), /com\.tmux-ide\.gpui\.development/);
  assert.match(bundlePlist(), /tmux-ide Development/);
  assert.match(bundlePlist(), />0\.0\.0</);
  if (process.platform === "darwin")
    assert.doesNotThrow(() => execFileSync("/usr/bin/plutil", ["-lint", "-"], { input: plist }));
});
test("unknown fields, types, namespace, injection and noncanonical numbers reject", () => {
  for (const bad of [
    null,
    [],
    { ...good, extra: true },
    { ...good, bundleId: "com.evil.preview" },
    { ...good, bundleId: "com.tmux-ide.gpui.development" },
    { ...good, bundleId: "com.tmux-ide.gpui.preview.development" },
    { ...good, bundleId: 'com.tmux-ide.gpui.<x>&"' },
    { ...good, version: "01.2.3" },
    { ...good, version: "1.2" },
    { ...good, version: 123 },
    { ...good, buildNumber: 1 },
    { ...good, buildNumber: "01" },
    { ...good, buildNumber: "1.2" },
    { ...good, buildNumber: "9".repeat(19) },
  ])
    assert.throws(() => validateBundleMetadata(bad));
});
test("bounded metadata file rejects links/oversize; invalid explicit assembly metadata precedes binary execution/output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-metadata-")));
  try {
    const path = join(root, "metadata.json"),
      link = join(root, "link"),
      output = join(root, "New.app");
    await writeFile(path, JSON.stringify(good));
    assert.deepEqual(await readBundleMetadata(path), good);
    await symlink(path, link);
    await assert.rejects(readBundleMetadata(link));
    await writeFile(path, " ".repeat(4097));
    await assert.rejects(readBundleMetadata(path));
    await writeFile(path, JSON.stringify({ ...good, version: "bad" }));
    if (process.platform === "darwin")
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              fileURLToPath(new URL("./assemble-local-app.mjs", import.meta.url)),
              "/nonexistent-native",
              "/nonexistent-node",
              "/nonexistent-license",
              "/nonexistent-receipt",
              output,
              "--metadata",
              path,
            ],
            { timeout: 5000, stdio: "pipe" },
          ),
        /Invalid preview bundle version/,
      );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
