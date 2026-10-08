import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  packedRendererSelection,
  packedRendererBuildArgs,
  assertPackedRendererSelectionUnchanged,
} from "./packed-renderer-selection.mjs";

test("stock remains the default with unchanged build arguments", () => {
  const selected = packedRendererSelection(undefined);
  assert.equal(selected.nativeRenderer, "stock");
  assert.deepEqual(packedRendererBuildArgs(selected, "/out"), [
    "scripts/build-tui.mjs",
    "--outfile",
    "/out",
  ]);
});
test("explicit manifest is bound and forwarded to the existing qualification verifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "packed-renderer-"));
  try {
    const path = join(dir, "manifest.json");
    const bytes = "{}\n";
    writeFileSync(path, bytes);
    const selected = packedRendererSelection(path);
    assert.equal(selected.nativeRenderer, "qualified-native-scroll");
    assert.deepEqual(selected.manifest, {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.deepEqual(packedRendererBuildArgs(selected, "/out"), [
      "scripts/build-tui.mjs",
      "--release-scroll-manifest",
      path,
      "--outfile",
      "/out",
    ]);
    // A syntactically valid but unqualified manifest still reaches build-tui's strict verifier.
    assert.throws(() => packedRendererSelection(dir));
    assertPackedRendererSelectionUnchanged(selected);
    writeFileSync(path, '{"changed":true}');
    assert.throws(() => assertPackedRendererSelectionUnchanged(selected), /changed/);
    writeFileSync(path, "not json");
    assert.throws(() => packedRendererSelection(path));
    assert.throws(() => packedRendererSelection(join(dir, "missing")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("invalid selectors and inconsistent provenance cannot select another renderer", () => {
  for (const value of ["", "relative.json", null, 1])
    assert.throws(() => packedRendererSelection(value));
  assert.throws(() =>
    packedRendererBuildArgs({ nativeRenderer: "stock", manifest: { path: "/x" } }, "/out"),
  );
  assert.throws(() =>
    packedRendererBuildArgs({ nativeRenderer: "qualified-native-scroll", manifest: null }, "/out"),
  );
  assert.throws(() =>
    packedRendererBuildArgs({ nativeRenderer: "experimental", manifest: null }, "/out"),
  );
});
