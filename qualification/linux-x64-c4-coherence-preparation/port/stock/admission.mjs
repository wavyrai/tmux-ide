import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
export function assertArtifact(path, digest) {
  const st = lstatSync(path);
  assert(st.isFile() && !st.isSymbolicLink());
  assert.equal(sha(path), digest, "Artifact changed");
}
export function admit(path) {
  const st = lstatSync(path);
  assert(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077));
  const d = JSON.parse(readFileSync(path));
  assert.equal(d.version, 1);
  assert.equal(d.mode, "stock-observation-off");
  assertArtifact(d.cli, d.cliSha256);
  assertArtifact(d.native, d.nativeSha256);
  assert.equal(d.native, resolve(d.source, "..", "stock", "tmux"));
  assert.equal(d.nativeObservation, "disabled");
  assertArtifact(d.componentClosure, d.componentClosureSha256);
  for (const [p, h] of Object.entries(d.overlay)) assertArtifact(p, h);
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: d.source, encoding: "utf8" }).trim(),
    d.commit,
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: d.source, encoding: "utf8" }).trim(),
    d.tree,
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: d.source, encoding: "utf8" }).trim(),
    "",
  );
  assert.equal(realpathSync(process.execPath), d.node);
  return d;
}
