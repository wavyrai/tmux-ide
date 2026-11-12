import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { tapBumpGate } from "./tap-bump-gate.mjs";

const script = fileURLToPath(new URL("./tap-bump-gate.mjs", import.meta.url));
const run = (version, token) =>
  spawnSync(process.execPath, [script, version], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...(token === undefined ? {} : { TAP_PUSH_TOKEN: token }) },
  });

test("a stable release with the token bumps the tap", () => {
  assert.deepEqual(tapBumpGate({ version: "2.9.22", hasToken: true }), { enabled: true });
  const result = run("2.9.22", "secret-value");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "version=2.9.22\nenabled=true\n");
  assert.doesNotMatch(result.stdout + result.stderr, /secret-value/);
});

test("a prerelease leaves the stable formula alone, with or without the token", () => {
  for (const token of [undefined, "", "secret-value"]) {
    const result = run("3.0.0-beta.1", token);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^version=3\.0\.0-beta\.1\nenabled=false\n$/);
    assert.match(result.stderr, /Prerelease v3\.0\.0-beta\.1 .* leaving stable Homebrew unchanged/);
  }
});

// #728: the job used to skip here and report success, so the tap stayed at 2.8.0
// through every release from 2.8.1 to 2.9.22.
test("a stable release without the token fails and says what to do", () => {
  for (const token of [undefined, "", "   "]) {
    const result = run("2.9.22", token);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /enabled=/);
    assert.match(result.stderr, /^::error title=Homebrew tap not bumped::/m);
    assert.match(result.stderr, /TAP_PUSH_TOKEN is not set/);
    assert.match(result.stderr, /packaging\/homebrew\/README\.md/);
  }
});

test("an invalid version fails closed", () => {
  assert.equal(run("v2.9.22", "secret-value").status, 1);
  assert.equal(run("", "secret-value").status, 1);
});

test("the release workflow cannot report a tap bump that did not happen", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const job = workflow.slice(workflow.indexOf("\n  bump_tap:"));
  assert.match(job, /node scripts\/lib\/tap-bump-gate\.mjs "\$version" >> "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(job, /skipping tap bump/i, "no path skips with success");
  // The only quiet exit left is a formula that already has this version.
  assert.deepEqual(
    job.match(/^ +exit 0$/gm)?.length,
    1,
    "one early success: the formula is already current",
  );
  assert.match(job, /Verify the tap now serves this version/);
});
