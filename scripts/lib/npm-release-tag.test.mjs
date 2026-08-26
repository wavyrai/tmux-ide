import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { npmReleaseTag } from "./npm-release-tag.mjs";

test("stable releases publish on latest", () => {
  assert.equal(npmReleaseTag("2.8.0"), "latest");
  assert.equal(npmReleaseTag("2.8.0+build.7"), "latest");
});

test("prereleases publish on beta", () => {
  assert.equal(npmReleaseTag("2.9.0-beta.1"), "beta");
  assert.equal(npmReleaseTag("3.0.0-rc.2+build.7"), "beta");
});

test("invalid release versions fail closed", () => {
  assert.throws(() => npmReleaseTag("v2.8.0"), /Invalid release version/);
  assert.throws(() => npmReleaseTag("latest"), /Invalid release version/);
});

test("release workflow isolates beta without weakening stable releases", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /needs: build_macos_notifier/u);
  assert.match(workflow, /always\(\).*build_macos_notifier\.result == 'skipped'/u);
  assert.match(workflow, /if: steps\.npm\.outputs\.tag != 'latest'[\s\S]+release:opentui:check/u);
  assert.match(workflow, /if: steps\.npm\.outputs\.tag == 'latest'[\s\S]+pnpm run check/u);
  assert.match(workflow, /if: steps\.npm\.outputs\.tag == 'latest'[\s\S]+download-artifact/u);
  assert.match(workflow, /if \[\[ "\$npm_tag" != "latest" \]\]; then[\s\S]+enabled=false/u);
});

test("npm publish proves the release tag and every runtime manifest belong to its checkout", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const provenance = workflow.indexOf("name: Verify OpenTUI runtime release provenance");
  const publish = workflow.indexOf("name: Publish tmux-ide");

  assert.ok(provenance >= 0 && provenance < publish);
  assert.match(workflow, /expected_commit="\$\(git rev-parse HEAD\)"/u);
  assert.match(workflow, /refs\/tags\/\$\{tag\}\^\{\}/u);
  assert.match(workflow, /gh release download "\$tag" --pattern '\*\.gz\.sha256'/u);
  assert.match(workflow, /grep -Fx "version \$version" "\$manifest"/u);
  assert.match(workflow, /grep -Fx "platform \$platform" "\$manifest"/u);
  assert.match(workflow, /grep -Fx "commit \$expected_commit" "\$manifest"/u);
});

test("binary releases bind manual tags, builds, and manifests to one resolved commit", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release-binaries.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /gh release create "\$tag" --target "\$\{\{ steps\.resolve\.outputs\.commit \}\}" "\$\{release_flags\[@\]\}"/u,
  );
  assert.match(
    workflow,
    /if \[\[ "\$version" == \*-\* \]\]; then[\s\S]+release_flags\+=\(--prerelease\)/u,
  );
  assert.match(workflow, /ref: \$\{\{ needs\.release\.outputs\.commit \}\}/u);
  assert.match(workflow, /RELEASE_VERSION: \$\{\{ needs\.release\.outputs\.version \}\}/u);
  assert.match(workflow, /printf 'commit %s\\n' "\$\{\{ needs\.release\.outputs\.commit \}\}"/u);
  assert.match(workflow, /verify_dispatch_tag required/u);
});
