import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePackedGeneratedSource,
  restorePackedGeneratedSource,
} from "./packed-generated-source.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "packed-generated-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "cli.js");
  writeFileSync(path, "original local bytes", { mode: 0o644 });
  return { root, path, before: capturePackedGeneratedSource(path) };
}

test("successive package builds restore exact caller bytes and mode without changing package bytes", (t) => {
  const { path } = fixture(t);
  for (const contents of ["a much longer generated executable than the original", "short"]) {
    const before = capturePackedGeneratedSource(path);
    const packaged = Buffer.from(contents);
    writeFileSync(path, packaged);
    chmodSync(path, 0o755);
    assert.equal(restorePackedGeneratedSource(before, packaged).restored, true);
    assert.equal(readFileSync(path, "utf8"), "original local bytes");
    assert.equal(statSync(path).mode & 0o777, 0o644);
    assert.equal(packaged.toString(), contents);
  }
});

test("preserves an edit after packaging instead of masking a dirty source gate", (t) => {
  const { path, before } = fixture(t);
  writeFileSync(path, "concurrent edit");
  chmodSync(path, 0o755);
  assert.throws(() => restorePackedGeneratedSource(before, Buffer.from("generated")), /differs/);
  assert.equal(readFileSync(path, "utf8"), "concurrent edit");
});

test("refuses symlink replacement and preserves its destination", (t) => {
  const { root, path, before } = fixture(t);
  const target = join(root, "other");
  writeFileSync(target, "generated", { mode: 0o755 });
  rmSync(path);
  symlinkSync(target, path);
  assert.throws(() => restorePackedGeneratedSource(before, Buffer.from("generated")));
  assert.equal(readFileSync(target, "utf8"), "generated");
});

test("refuses a mode change even when bytes still match the package", (t) => {
  const { path, before } = fixture(t);
  writeFileSync(path, "generated");
  assert.throws(
    () => restorePackedGeneratedSource(before, Buffer.from("generated")),
    /mode changed/,
  );
  assert.equal(readFileSync(path, "utf8"), "generated");
});
