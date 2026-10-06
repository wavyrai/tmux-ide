import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBoundaryResults } from "./lib/boundary-results.mjs";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const runnerSourceSha256 = hashFile(fileURLToPath(import.meta.url));
const expectedNative = process.env.TMUX_IDE_ORACLE_EXPECT_NATIVE;
if (!binary || !isAbsolute(binary)) {
  throw new Error(
    "Set TMUX_IDE_BOUNDARY_TEST_BINARY to the absolute path of the tmux binary to qualify.",
  );
}
if (expectedNative !== "0" && expectedNative !== "1") {
  throw new Error(
    "Set TMUX_IDE_ORACLE_EXPECT_NATIVE to 1 for bundled physical capture or 0 for stock compatibility.",
  );
}
const version = spawnSync(binary, ["-V"], { encoding: "utf8", timeout: 5000 });
if (version.status !== 0)
  throw new Error(`Cannot execute ${binary}: ${version.error ?? version.stderr}`);
const binarySha256 = hashFile(binary);
console.log(
  JSON.stringify({
    binary,
    expectedNativePhysicalCapture: expectedNative === "1",
    version: version.stdout.trim(),
    sha256: binarySha256,
  }),
);
const cwd = fileURLToPath(new URL("../packages/daemon/", import.meta.url));
const reportRoot = mkdtempSync(join(tmpdir(), "tmux-boundary-reports-"));
console.log(`Boundary qualification reports: ${reportRoot}`);
writeFileSync(
  join(reportRoot, "initial-identity.json"),
  JSON.stringify({ binary, binarySha256, runnerSourceSha256, expectedNative }, null, 2),
);
const verified = [];
for (const [config, test] of [
  ["vitest.config.ts", "src/terminal/mirror/pane-feed-model.test.ts"],
  ["vitest.config.ts", "src/terminal/mirror/control-channel-model.test.ts"],
  ["vitest.config.ts", "src/terminal/mirror/session-channel-model.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/tmux-boundary-model-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/tmux-boundary-ordering-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/control-collector-retirement-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/control-owned-pause-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/session-channel-cancellation-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/native-physical-cell-oracle-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/mirror/canonical-resize-publication-live.test.ts"],
  ["vitest.live.config.ts", "src/terminal/session-runtime/terminal-hidden-viewer-live.test.ts"],
  ["vitest.live.config.ts", "src/tui/mirror/runtime/terminal-input-ordering-live.test.ts"],
  ["vitest.live.config.ts", "src/tui/mirror/runtime/terminal-native-input-death-live.test.ts"],
  [
    "vitest.live.config.ts",
    "src/tui/mirror/runtime/terminal-input-session-replacement-live.test.ts",
  ],
]) {
  const reportPath = join(reportRoot, `${verified.length + 1}.json`);
  const testSourcePath = join(cwd, test);
  const sourceSha256 = hashFile(testSourcePath);
  writeFileSync(`${reportPath}.identity.json`, JSON.stringify({ test, sourceSha256 }, null, 2));
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--config",
      config,
      test,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportPath}`,
    ],
    {
      cwd,
      env: { ...process.env, TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY: binary },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  assert.equal(
    hashFile(testSourcePath),
    sourceSha256,
    `Test source changed during execution: ${test}`,
  );
  const passed = verifyBoundaryResults(JSON.parse(readFileSync(reportPath, "utf8")), [test]);
  verified.push({ test, sourceSha256, reportPath, passed });
}
const evidence = join(mkdtempSync(join(tmpdir(), "tmux-boundary-wire-")), "evidence");
console.log(`Control scheduler wire evidence: ${evidence}`);
const wire = spawnSync(
  "python3",
  [
    fileURLToPath(new URL("./check-tmux-control-barriers.py", import.meta.url)),
    binary,
    "--output",
    evidence,
  ],
  { env: process.env, stdio: "inherit" },
);
if (wire.error) throw wire.error;
if (wire.status !== 0) process.exit(wire.status ?? 1);
assert.equal(hashFile(binary), binarySha256, "Qualified binary changed during execution");
writeFileSync(
  join(reportRoot, "summary.json"),
  JSON.stringify(
    {
      binary,
      binarySha256,
      runnerSourceSha256,
      identityScope: "Selected test files and executable; not full dependency or artifact closure",
      expectedNativePhysicalCapture: expectedNative === "1",
      verified,
      wireEvidence: evidence,
    },
    null,
    2,
  ),
);
