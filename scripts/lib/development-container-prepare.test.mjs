import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(
  new URL("../../docker/development/prepare-source.mjs", import.meta.url),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(files = []) {
  const root = mkdtempSync(join(tmpdir(), "ti-container-prepare-"));
  const source = join(root, "source"),
    target = join(root, "target");
  mkdirSync(source);
  const manifest = {
    version: 1,
    files,
    snapshotDigest: hash(JSON.stringify(files)),
    sourceCommit: "a".repeat(40),
    sourceCommitTimestamp: 1,
  };
  const save = () =>
    writeFileSync(join(source, ".development-container-source.json"), JSON.stringify(manifest));
  save();
  return {
    root,
    source,
    target,
    manifest,
    save,
    run: () => execFileSync(process.execPath, [script, source, target], { stdio: "pipe" }),
  };
}
test("source preparation refuses a nonempty destination without changing it", () => {
  const f = fixture();
  try {
    mkdirSync(f.target);
    writeFileSync(join(f.target, "sentinel"), "keep");
    assert.throws(f.run, /empty owned/);
    assert.equal(readFileSync(join(f.target, "sentinel"), "utf8"), "keep");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("source preparation rejects corrupt manifests and escaping paths before writes", () => {
  for (const kind of ["digest", "path", "symlink"]) {
    const files =
      kind === "path"
        ? [{ path: "../escape", type: "file", hash: hash("x"), mode: 420 }]
        : kind === "symlink"
          ? [
              {
                path: "escape",
                type: "symlink",
                target: "../../outside",
                hash: hash("../../outside"),
                mode: 511,
              },
            ]
          : [];
    const f = fixture(files);
    try {
      if (kind === "digest") {
        f.manifest.snapshotDigest = "0".repeat(64);
        f.save();
      }
      assert.throws(f.run, /Invalid/);
      assert(!existsSync(f.target));
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
