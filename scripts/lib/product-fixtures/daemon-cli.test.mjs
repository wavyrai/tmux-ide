import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fence the build boundary before importing the fixture: a regression may fail
// this test, but must never execute the real tracked-bundle builder.
const buildBlocked = new Error("test blocked bundle build");
const originalExecFile = childProcess.execFile;
const buildCalls = [];
// A fresh function deliberately has no execFile[promisify.custom] implementation.
childProcess.execFile = function blockedBuild(...args) {
  buildCalls.push(args);
  args.at(-1)(buildBlocked);
};
syncBuiltinESMExports();
const { startDaemon, repoRoot } = await import("./daemon.ts");

test("explicit fixture CLI validates before startup and bypasses the bundle builder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fixture-cli-"));
  const bundle = join(repoRoot, "bin/cli.js");
  const before = await readFile(bundle);
  const environmentReached = new Error("validated CLI reached environment setup");
  const fleet = {
    get environment() {
      throw environmentReached;
    },
  };
  try {
    await assert.rejects(startDaemon(fleet, { cliPath: "relative.js" }), /must be absolute/);
    await assert.rejects(startDaemon(fleet, { cliPath: "" }), /must be absolute/);
    await assert.rejects(startDaemon(fleet, { cliPath: directory }), /regular file/);
    await assert.rejects(startDaemon(fleet, { cliPath: join(directory, "missing.js") }), {
      code: "ENOENT",
    });
    const cliPath = join(directory, "private-cli.mjs");
    await writeFile(cliPath, "// not executed\n");
    await assert.rejects(startDaemon(fleet, { cliPath }), (error) => error === environmentReached);
    assert.equal(buildCalls.length, 0);
    assert.deepEqual(await readFile(bundle), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default fixture still enters the existing bundle build path", async () => {
  try {
    await assert.rejects(startDaemon({}), (error) => error === buildBlocked);
    assert.equal(buildCalls.length, 1);
    assert.equal(buildCalls[0][0], "node");
    assert.deepEqual(buildCalls[0][1], [join(repoRoot, "scripts/build-cli.mjs")]);
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  }
});
