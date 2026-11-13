import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

/** Every failed subtest of a TAP stream, with its own diagnostic block. */
function failedSubtests(tap: string): string[] {
  const lines = tap.split("\n");
  const failed: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]?.startsWith("not ok ")) continue;
    let end = index + 1;
    while (end < lines.length && lines[end] !== "  ...") end++;
    failed.push(lines.slice(index, end).join("\n"));
    index = end;
  }
  return failed;
}

// One authoritative installer suite serves the daemon gate and Node 20 package
// checks. The universal installer now owns its runtime and npm prefix, so the
// former system-Node/global-manager fixtures no longer describe its contract.
//
// The budget is for the whole suite on a busy runner, not for one installer:
// with 62 tests it takes about 62 s alone on a hosted Linux runner, and the
// former 60 s limit ended it mid-run (PR #380).
//
// A failure names the subtests that failed. The child's whole output is too
// long for a report, which cut it off before the failing subtest (PR #380).
it("qualifies isolated installer activation, version verification, and failed upgrades", () => {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "scripts/install.test.mjs"],
      { cwd: resolve("../.."), encoding: "utf8", timeout: 240_000 },
    );
  } catch (error) {
    const { code, status, signal, stdout, stderr } = error as {
      code?: string;
      status?: number | null;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    const tap = stdout ?? "";
    const failed = failedSubtests(tap);
    const passed = tap.split("\n").filter((line) => line.startsWith("ok ")).length;
    throw new Error(
      [
        `scripts/install.test.mjs ended with status ${status ?? "none"}, signal ${signal ?? "none"}${code ? ` and ${code}` : ""}: ${failed.length} subtest(s) failed, ${passed} passed.`,
        ...(failed.length > 0
          ? failed
          : [`No subtest reported a failure. Last output:\n${tap.slice(-2000)}`]),
        ...(stderr ? [`stderr:\n${stderr.slice(-2000)}`] : []),
      ].join("\n\n"),
      { cause: error },
    );
  }
  expect(output).toMatch(/# fail 0/u);
}, 245_000);
