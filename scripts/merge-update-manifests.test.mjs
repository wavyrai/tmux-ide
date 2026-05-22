import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

const scriptPath = new URL("./merge-update-manifests.mjs", import.meta.url).pathname;

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "tmux-ide-manifest-test-"));
}

function writeManifest(dir, name, manifest) {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, yaml.dump(manifest, { lineWidth: -1 }));
  return filePath;
}

function runMerge(primary, secondary, output) {
  return spawnSync(process.execPath, [scriptPath, primary, secondary, output], {
    encoding: "utf-8",
  });
}

const baseManifest = {
  version: "0.1.0",
  releaseDate: "2026-05-05T00:00:00.000Z",
  path: "tmux-ide-0.1.0-arm64.zip",
  sha512: "primary-sha",
  files: [{ url: "tmux-ide-0.1.0-arm64.zip", sha512: "primary-sha", size: 10 }],
};

describe("merge-update-manifests", () => {
  it("writes a manifest containing both architecture file entries", () => {
    const dir = tempDir();
    const primary = writeManifest(dir, "latest-mac-arm64.yml", baseManifest);
    const secondary = writeManifest(dir, "latest-mac-x64.yml", {
      ...baseManifest,
      path: "tmux-ide-0.1.0-x64.zip",
      sha512: "secondary-sha",
      files: [{ url: "tmux-ide-0.1.0-x64.zip", sha512: "secondary-sha", size: 20 }],
    });
    const output = path.join(dir, "latest-mac.yml");

    const result = runMerge(primary, secondary, output);
    assert.equal(result.status, 0, result.stderr);

    const merged = yaml.load(readFileSync(output, "utf-8"));
    assert.equal(merged.version, "0.1.0");
    assert.deepEqual(
      merged.files.map((file) => file.url),
      ["tmux-ide-0.1.0-arm64.zip", "tmux-ide-0.1.0-x64.zip"],
    );
  });

  it("exits non-zero on version mismatch", () => {
    const dir = tempDir();
    const primary = writeManifest(dir, "primary.yml", baseManifest);
    const secondary = writeManifest(dir, "secondary.yml", { ...baseManifest, version: "0.2.0" });
    const result = runMerge(primary, secondary, path.join(dir, "out.yml"));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Version mismatch/);
  });

  it("deduplicates duplicate file URLs", () => {
    const dir = tempDir();
    const primary = writeManifest(dir, "primary.yml", baseManifest);
    const secondary = writeManifest(dir, "secondary.yml", {
      ...baseManifest,
      files: [...baseManifest.files],
    });
    const output = path.join(dir, "out.yml");

    const result = runMerge(primary, secondary, output);
    assert.equal(result.status, 0, result.stderr);
    const merged = yaml.load(readFileSync(output, "utf-8"));
    assert.equal(merged.files.length, 1);
  });
});
