import { test } from "node:test";
import assert from "node:assert/strict";
import { pinnedToolchainPaths, localManifestAllowed } from "./native-build-inputs.mjs";
test("build uses exact installed stable compiler independent of rustup launcher", () => {
  assert.deepEqual(
    pinnedToolchainPaths("/owned/rust", '[toolchain]\nchannel = "1.96.1"\n', "arm64"),
    {
      channel: "1.96.1",
      cargo: "/owned/rust/toolchains/1.96.1-aarch64-apple-darwin/bin/cargo",
      rustc: "/owned/rust/toolchains/1.96.1-aarch64-apple-darwin/bin/rustc",
    },
  );
  for (const source of [
    'channel = "stable"',
    'channel = "../escape"',
    'channel = "1.96.1"\nchannel = "1.95.0"',
    "",
  ])
    assert.throws(() => pinnedToolchainPaths("/owned", source, "arm64"));
  assert.throws(() => pinnedToolchainPaths("relative", 'channel = "1.96.1"', "arm64"));
});
test("only declared workspace and exact Apple manifests can enter receipt", () => {
  const files = [
    "Cargo.toml",
    "crates/gui/Cargo.toml",
    "../vendor/bezel-gpui-apple/Cargo.toml",
    "../vendor/unrelated/Cargo.toml",
    "assets/private/Cargo.toml",
  ].map((path) => ({ path }));
  assert(
    localManifestAllowed("/owned/upstream", "/owned/vendor/bezel-gpui-apple/Cargo.toml", files),
  );
  assert(localManifestAllowed("/owned/upstream", "/owned/upstream/crates/gui/Cargo.toml", files));
  assert(!localManifestAllowed("/owned/upstream", "/owned/vendor/unrelated/Cargo.toml", files));
  assert(
    !localManifestAllowed("/owned/upstream", "/owned/upstream/assets/private/Cargo.toml", files),
  );
  assert(
    !localManifestAllowed("/owned/upstream", "/owned/upstream/crates/missing/Cargo.toml", files),
  );
  assert(!localManifestAllowed("/owned/upstream", "/elsewhere/Cargo.toml", files));
});
