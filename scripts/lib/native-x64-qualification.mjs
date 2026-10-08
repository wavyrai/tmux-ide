/** Offline evidence checks; CI functional qualification is not a performance claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export const nativeX64Suites = [
  "src/lib/native-tmux-interaction-observer-live.test.ts",
  "src/lib/native-interaction-projector-live.test.ts",
  "src/lib/authored-native-command-runner-live.test.ts",
  "src/lib/authored-native-completion-live.test.ts",
  "src/lib/native-operation-command-live.test.ts",
  "src/terminal/mirror/native-atomic-snapshot-live.test.ts",
  "src/terminal/mirror/native-atomic-dual-snapshot-live.test.ts",
  "src/terminal/mirror/native-atomic-recovery-live.test.ts",
  "src/tui/mirror/runtime/terminal-native-content-live.test.ts",
  "src/terminal/session-runtime/tmux-clear-history-live.test.ts",
];
export function verifyNativeResults(report) {
  assert.equal(report.success, true);
  assert.equal(report.testResults.length, nativeX64Suites.length);
  let count = 0;
  for (const suite of nativeX64Suites) {
    const matches = report.testResults.filter((r) => r.name.endsWith("/" + suite));
    assert.equal(matches.length, 1, `Missing or duplicate suite: ${suite}`);
    assert.equal(matches[0].status, "passed");
    assert(matches[0].assertionResults.length > 0, `Empty suite: ${suite}`);
    for (const test of matches[0].assertionResults) {
      assert.equal(test.status, "passed", `Non-executed or failed test: ${suite}`);
      count++;
    }
  }
  assert.equal(report.numTotalTests, count);
  assert.equal(report.numPassedTests, count);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests ?? 0, 0);
  return count;
}
export function verifyX64Header(bytes, platform) {
  if (platform === "linux") {
    assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(bytes[4], 2); // ELF64
    assert.equal(bytes[5], 1); // little endian
    assert.equal(bytes.readUInt16LE(18), 62); // EM_X86_64
  } else {
    assert.equal(platform, "darwin");
    assert.equal(bytes.readUInt32LE(0), 0xfeedfacf); // thin Mach-O64
    assert.equal(bytes.readUInt32LE(4), 0x01000007); // CPU_TYPE_X86_64
  }
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function verifyNativeBundle(bundle, provenance, platform) {
  assert.equal(bundle.manifest.platform, platform);
  assert.equal(bundle.manifest.arch, "x64");
  for (const key of ["commit", "patches", "experimentalExtensions"])
    assert.deepEqual(bundle.manifest[key], provenance[key]);
  assert(provenance.experimentalExtensions.includes("tmux-ide-interaction-journal-v2"));
  assert(bundle.manifest.files.tmux);
  for (const [name, digest] of Object.entries(bundle.manifest.files)) {
    assert(!name.startsWith("/") && !name.split("/").includes(".."));
    const bytes = bundle.read(name);
    assert.equal(sha(bytes), digest, `Manifest mismatch: ${name}`);
    if (name === "tmux" || /\.(?:dylib|so(?:\.\d+)*)$/.test(name)) verifyX64Header(bytes, platform);
  }
}
export function tmuxProcesses(text) {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && /(?:^|\/)tmux(?:$|[:\s])/.test(match[2]) ? [Number(match[1])] : [];
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output] = process.argv.slice(2);
  const path = resolve(output);
  const ps = () => execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" });
  if (mode === "baseline") {
    assert.equal(process.arch, "x64");
    assert.equal(`${process.platform}-${process.arch}`, process.env.NATIVE_PLATFORM);
    const baseline = ps();
    writeFileSync(join(path, "processes-before.txt"), baseline, { flag: "wx" });
    assert.equal(
      tmuxProcesses(baseline).length,
      0,
      "Runner already has tmux processes; refuse ambiguous cleanup",
    );
    writeFileSync(
      join(path, "host.json"),
      JSON.stringify(
        {
          source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          uname: execFileSync("uname", ["-a"], { encoding: "utf8" }).trim(),
          performanceQualified: false,
        },
        null,
        2,
      ),
    );
  } else if (mode === "verify") {
    assert(existsSync(join(path, "sanitizer-passed")), "Sanitizer qualification missing");
    const directory = join(path, "bundle");
    verifyNativeBundle(
      {
        manifest: JSON.parse(readFileSync(join(directory, "manifest.json"))),
        read: (name) => readFileSync(join(directory, name)),
      },
      JSON.parse(readFileSync("native/tmux/provenance.json")),
      process.platform,
    );
    const tests = verifyNativeResults(JSON.parse(readFileSync(join(path, "vitest.json"))));
    writeFileSync(
      join(path, "functional.json"),
      JSON.stringify({ tests, performanceQualified: false }),
    );
  } else if (mode === "cleanup") {
    const after = ps();
    writeFileSync(join(path, "processes-after.txt"), after);
    const before = new Set(tmuxProcesses(readFileSync(join(path, "processes-before.txt"), "utf8")));
    const remaining = tmuxProcesses(after).filter((pid) => !before.has(pid));
    const clean = remaining.length === 0;
    writeFileSync(
      join(path, "cleanup.json"),
      JSON.stringify({
        clean,
        remaining,
        coverage: "new tmux processes absent; individual suites own socket/client cleanup",
        functionalEvidencePresent: existsSync(join(path, "functional.json")),
        performanceQualified: false,
      }),
    );
    assert(clean, "New tmux processes remain; no broad kill is permitted");
  } else if (mode === "suites") process.stdout.write(nativeX64Suites.join("\n") + "\n");
  else throw Error("Unknown qualification mode");
}
