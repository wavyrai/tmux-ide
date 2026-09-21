import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NATIVE_SCROLL_RELEASE_PINS,
  nativeScrollSha256,
  validateNativeScrollReleaseManifest,
} from "./native-scroll-release-manifest.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-release-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "patches"));
  mkdirSync(join(root, "scripts/native"), { recursive: true });
  mkdirSync(join(root, "output"));
  const patch = join(root, "patches/opentui-native-scroll-ad9a818.patch");
  const recipe = join(root, "scripts/native/build-opentui-scroll.mjs");
  writeFileSync(patch, "pinned patch");
  writeFileSync(recipe, "pinned recipe");
  const artifact = (name) => {
    const path = join(root, "output", name);
    writeFileSync(path, name);
    return { path: name, sha256: nativeScrollSha256(path) };
  };
  const manifest = {
    version: 1,
    status: "passed",
    ...NATIVE_SCROLL_RELEASE_PINS,
    platform: "darwin",
    arch: "arm64",
    libc: null,
    patchSha256: nativeScrollSha256(patch),
    recipeSha256: nativeScrollSha256(recipe),
    tests: artifact("tests.log"),
    build: artifact("build.log"),
    library: artifact("libopentui.dylib"),
  };
  const path = join(root, "output/release-manifest.json");
  const options = {
    repository: root,
    target: "bun-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    libc: null,
    sourceState: "clean",
    coreVersion: "0.5.1",
  };
  const validate = (change = {}, optionChange = {}) => {
    writeFileSync(path, JSON.stringify({ ...manifest, ...change }));
    return validateNativeScrollReleaseManifest(path, { ...options, ...optionChange });
  };
  return { root, manifest, validate };
}

test("accepts the pinned tested host artifact and release version alignment", (t) => {
  const f = fixture(t);
  assert.equal(f.validate().library, realpathSync(join(f.root, "output/libopentui.dylib")));
  assert.doesNotThrow(() => f.validate({}, { sourceState: "version-aligned" }));
});
for (const [key, value] of Object.entries({
  status: "failed",
  version: 2,
  sourceCommit: "bad",
  zigVersion: "0.16.0",
  coreVersion: "0.5.2",
  patchSha256: "0".repeat(64),
  recipeSha256: "0".repeat(64),
  arch: "x64",
  libc: "musl",
})) {
  test(`rejects unqualified manifest ${key}`, (t) =>
    assert.throws(() => fixture(t).validate({ [key]: value })));
}
for (const [key, value] of Object.entries({
  sourceState: "dirty",
  target: "bun-linux-arm64",
  coreVersion: "0.5.2",
})) {
  test(`rejects incompatible build ${key}`, (t) =>
    assert.throws(() => fixture(t).validate({}, { [key]: value })));
}
test("rejects musl release builds without affecting experimental builds", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.validate({}, { platform: "linux", target: "bun-linux-arm64", libc: "musl" }),
    /musl is not qualified/,
  );
});
for (const name of ["tests", "build", "library"]) {
  test(`rejects tampered ${name}`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.root, "output", f.manifest[name].path), "tampered");
    assert.throws(() => f.validate(), /digest mismatch/);
  });
}
test("rejects artifact paths outside build output even with valid digest", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.validate({
        tests: {
          path: "../patches/opentui-native-scroll-ad9a818.patch",
          sha256: f.manifest.patchSha256,
        },
      }),
    /escapes/,
  );
});
