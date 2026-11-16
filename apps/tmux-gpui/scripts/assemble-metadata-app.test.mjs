// Checks an app assembled with --metadata, the way a release assembles it.
// check-packaged-app.sh builds that app and names it here; without it the test skips,
// because assembly needs a native build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appName, bundleBaseName } from "./app-bundle-metadata.mjs";

const app = process.env.TMUX_GPUI_TEST_METADATA_APP;
const metadataFile = process.env.TMUX_GPUI_TEST_METADATA;
const skip = !(app && metadataFile) && "needs an app assembled with --metadata";
const plist = (file) =>
  JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", file], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );

test("a --metadata assembly carries the given identity and the release name", { skip }, () => {
  const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  const resources = join(app, "Contents/Resources");
  const info = plist(join(app, "Contents/Info.plist"));
  assert.equal(info.CFBundleIdentifier, metadata.bundleId);
  assert.equal(info.CFBundleShortVersionString, metadata.version);
  assert.equal(info.CFBundleVersion, metadata.buildNumber);
  assert.equal(info.CFBundleName, appName);
  assert.equal(info.CFBundleDisplayName, bundleBaseName);
  assert.equal(info.LSHasLocalizedDisplayName, true);
  assert.ok(existsSync(join(app, "Contents/MacOS", info.CFBundleExecutable)));

  const strings = join(resources, "en.lproj/InfoPlist.strings");
  execFileSync("/usr/bin/plutil", ["-lint", strings], { timeout: 10000 });
  assert.deepEqual(plist(strings), { CFBundleDisplayName: appName, CFBundleName: appName });

  const manifest = JSON.parse(readFileSync(join(resources, "assembly-manifest.json"), "utf8"));
  assert.deepEqual(manifest.metadata, metadata);
  assert.equal(manifest.scope, "pre-signing assembly; not a qualified release");
  assert.equal(manifest.distribution, false);
  assert.equal(manifest.signing, "not-qualified");
  assert.ok(!existsSync(join(resources, "development-manifest.json")), "one manifest, not both");
  assert.ok(!existsSync(join(resources, "node")), "a release bundle ships no Node");
});
