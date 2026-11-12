import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compare } from "./verify-vendored-crate.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "vendored-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const original = { "Cargo.toml": "a", "src/lib.rs": "b" };
const provenance = (extra = {}) => ({
  originalFilesSha256: Object.fromEntries(Object.entries(original).map(([p, t]) => [p, sha(t)])),
  complete: true,
  modifiedFiles: [],
  addedSourceFiles: [],
  ...extra,
});

test("an exact copy passes", () => {
  const [pkg, vendor] = [tree(original), tree(original)];
  const result = compare(provenance(), pkg, vendor);
  assert.deepEqual(result.errors, []);
  assert.equal(result.identical, 2);
  rmSync(pkg, { recursive: true });
  rmSync(vendor, { recursive: true });
});

test("an unlisted change, a missing file and an extra file fail", () => {
  const pkg = tree(original);
  const vendor = tree({ "src/lib.rs": "changed", "src/extra.rs": "x" });
  const errors = compare(provenance(), pkg, vendor).errors.join("\n");
  assert.match(errors, /changed but not listed as modified: src\/lib.rs/);
  assert.match(errors, /unexpected vendored file: src\/extra.rs/);
  assert.match(errors, /package file not vendored: Cargo.toml/);
  rmSync(pkg, { recursive: true });
  rmSync(vendor, { recursive: true });
});

test("listed changes and additions pass; a provenance hash the package lacks fails", () => {
  const pkg = tree(original);
  const vendor = tree({ "Cargo.toml": "a", "src/lib.rs": "ours", "src/new.rs": "n" });
  const listed = provenance({ modifiedFiles: ["src/lib.rs"], addedSourceFiles: ["src/new.rs"] });
  const result = compare(listed, pkg, vendor);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changed, ["src/lib.rs"]);
  const forged = provenance();
  forged.originalFilesSha256["Cargo.toml"] = sha("forged");
  assert.match(compare(forged, pkg, tree(original)).errors.join(), /provenance hash differs/);
  rmSync(pkg, { recursive: true });
  rmSync(vendor, { recursive: true });
});

test("a copy's own Cargo.lock passes only when the provenance declares a test lockfile", () => {
  const pkg = tree(original);
  const vendor = tree({ ...original, "Cargo.lock": "lock" });
  assert.match(
    compare(provenance(), pkg, vendor).errors.join(),
    /unexpected vendored file: Cargo.lock/,
  );
  const declared = provenance({ testLockfile: "pins the copy's standalone tests" });
  assert.deepEqual(compare(declared, pkg, vendor).errors, []);
  assert.match(
    compare(declared, pkg, tree(original)).errors.join(),
    /listed but not vendored: Cargo.lock/,
  );
  rmSync(pkg, { recursive: true });
  rmSync(vendor, { recursive: true });
});
