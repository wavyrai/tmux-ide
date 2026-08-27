import assert from "node:assert/strict";
import test from "node:test";
import { assertCleanEvidenceSource, releaseSourceState } from "./release-source-state.mjs";

test("classifies an exact checkout as clean", () => {
  assert.equal(releaseSourceState(""), "clean");
});

test("allows only the release workflow's package and compiled CLI alignment", () => {
  assert.equal(
    releaseSourceState(" M package.json\n M packages/daemon/package.json\n M bin/cli.js\n"),
    "version-aligned",
  );
});

test("classifies source, untracked, and renamed changes as dirty", () => {
  assert.equal(releaseSourceState(" M scripts/build-tui.mjs\n"), "dirty");
  assert.equal(releaseSourceState("?? evidence.json\n"), "dirty");
  assert.equal(releaseSourceState("R  old.ts -> packages/daemon/src/tui/main.ts\n"), "dirty");
});

test("exact evidence fails closed unless the checkout is clean", () => {
  assert.doesNotThrow(() => assertCleanEvidenceSource("clean"));
  assert.throws(() => assertCleanEvidenceSource("version-aligned"), /requires a clean checkout/u);
  assert.throws(() => assertCleanEvidenceSource("dirty"), /requires a clean checkout/u);
});
