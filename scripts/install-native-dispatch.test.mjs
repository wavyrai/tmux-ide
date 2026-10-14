import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const source = readFileSync(resolve("docs/public/install.sh"), "utf8");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "private home"),
    bin = join(root, "bin"),
    temp = join(root, "temp");
  for (const dir of [home, bin, temp]) mkdirSync(dir);
  const script = (path, body) =>
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  script(
    join(bin, "uname"),
    'case "$1" in -s) echo "${TEST_OS:-Darwin}" ;; -m) echo "${TEST_ARCH:-arm64}" ;; esac',
  );
  script(join(bin, "sw_vers"), 'echo "${TEST_MACOS:-26.0}"');
  const native = join(root, "native.sh");
  script(native, 'printf "%s\\n" "$@" > "$TEST_NATIVE_ARGS"\nexit "${TEST_NATIVE_EXIT:-0}"');
  script(
    join(bin, "curl"),
    `printf invoked > "$TEST_FETCHED"\nout=''; while [ "$#" -gt 0 ]; do case "$1" in -o) shift; out=$1 ;; esac; shift; done\ncp ${quote(native)} "$out"\n[ -z "\${TEST_CORRUPT:-}" ] || printf bad >> "$out"`,
  );
  const digest = createHash("sha256").update(readFileSync(native)).digest("hex");
  // Isolate dispatcher policy from already separately-tested CLI install effects.
  // The override exists only in this private test copy and records exact main args.
  const override = `main() {\n printf '%s\\n' "$@" > "$TEST_CLI_ARGS"\n trap 'printf cleaned > "$TEST_MAIN_CLEANED"' 0\n [ -z "\${TEST_CLI_FAIL:-}" ] || exit 19\n}\n`;
  const entry = join(root, "dispatch.sh");
  writeFileSync(
    entry,
    source
      .replace("# Native alpha is explicit;", override + "# Native alpha is explicit;")
      .replace("83b20635c1fef2ce4b218093b8396940f78424431b61c6a472d9dee87368ff77", digest),
  );
  const paths = {
    TEST_NATIVE_ARGS: join(root, "native-args"),
    TEST_CLI_ARGS: join(root, "cli-args"),
    TEST_FETCHED: join(root, "fetched"),
    TEST_MAIN_CLEANED: join(root, "cleaned"),
  };
  const env = { ...process.env, ...paths, HOME: home, TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin` };
  const run = (args = [], extra = {}) =>
    spawnSync("/bin/sh", [entry, "--native-alpha", ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 10000,
    });
  const runtime = () => {
    const dir = join(home, ".local/share/tmux-ide/current/node/bin");
    mkdirSync(dir, { recursive: true });
    script(join(dir, "node"), "exit 0");
  };
  return { run, runtime, temp, paths, home };
}
test("native help is side-effect free even on unsupported systems", (t) => {
  const f = fixture(t);
  assert.equal(f.run(["--help"], { TEST_OS: "Linux" }).status, 0);
  assert.ok(!existsSync(f.paths.TEST_FETCHED));
  assert.ok(!existsSync(f.paths.TEST_CLI_ARGS));
});
test("unsupported OS/architecture and pre-26 macOS reject before bootstrap", (t) => {
  const f = fixture(t);
  for (const extra of [{ TEST_OS: "Linux" }, { TEST_ARCH: "x86_64" }, { TEST_MACOS: "14.2" }])
    assert.notEqual(f.run([], extra).status, 0);
  assert.ok(!existsSync(f.paths.TEST_FETCHED));
  assert.ok(!existsSync(f.paths.TEST_CLI_ARGS));
});
test("maintenance and invalid args never bootstrap missing runtime regardless argument order", (t) => {
  const f = fixture(t);
  for (const args of [
    ["--prefix", "/private/owned", "--rollback"],
    ["--prefix", "/private/owned", "--uninstall"],
    ["--unknown"],
    ["--prefix"],
  ])
    assert.notEqual(f.run(args).status, 0);
  assert.ok(!existsSync(f.paths.TEST_CLI_ARGS));
  assert.ok(!existsSync(f.paths.TEST_FETCHED));
});
test("existing runtime delegates native-only prefix and preserves child failure/cleanup", (t) => {
  const f = fixture(t);
  f.runtime();
  const args = ["--prefix", join(f.home, "native space"), "--update"];
  assert.equal(f.run(args, { TEST_NATIVE_EXIT: "23" }).status, 23);
  assert.deepEqual(readFileSync(f.paths.TEST_NATIVE_ARGS, "utf8").trimEnd().split("\n"), args);
  assert.ok(!existsSync(f.paths.TEST_CLI_ARGS));
  assert.deepEqual(readdirSync(f.temp), []);
});
test("checksum mismatch prevents native execution and cleans stage", (t) => {
  const f = fixture(t);
  f.runtime();
  assert.notEqual(f.run([], { TEST_CORRUPT: "1" }).status, 0);
  assert.ok(!existsSync(f.paths.TEST_NATIVE_ARGS));
  assert.deepEqual(readdirSync(f.temp), []);
});
test("bootstrap failure is propagated before native fetch and runs subshell cleanup", (t) => {
  const f = fixture(t);
  assert.equal(f.run([], { TEST_CLI_FAIL: "1" }).status, 19);
  const args = readFileSync(f.paths.TEST_CLI_ARGS, "utf8").trimEnd().split("\n");
  assert.ok(args.includes("2.9.5"));
  assert.ok(args.includes("--no-claude-agent-teams"));
  assert.ok(existsSync(f.paths.TEST_MAIN_CLEANED));
  assert.ok(!existsSync(f.paths.TEST_FETCHED));
});

test("CLI prerequisite ignores native prefix and inherited CLI prefix", (t) => {
  const f = fixture(t);
  const nativePrefix = join(f.home, "chosen native");
  assert.equal(
    f.run(["--prefix", nativePrefix], {
      TMUX_IDE_INSTALL_PREFIX: "/must-not-use",
      TEST_CLI_FAIL: "1",
    }).status,
    19,
  );
  const args = readFileSync(f.paths.TEST_CLI_ARGS, "utf8").trimEnd().split("\n");
  assert.equal(args[args.indexOf("--prefix") + 1], join(f.home, ".local"));
  assert.ok(!args.includes(nativePrefix));
});

test("successful CLI prerequisite runs its own cleanup then continues native bootstrap", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  assert.ok(existsSync(f.paths.TEST_MAIN_CLEANED));
  assert.ok(existsSync(f.paths.TEST_NATIVE_ARGS));
  const args = readFileSync(f.paths.TEST_CLI_ARGS, "utf8").trimEnd().split("\n");
  assert.equal(args[args.indexOf("--version") + 1], "2.9.5");
  assert.ok(args.includes("--no-claude-agent-teams"));
  assert.deepEqual(readdirSync(f.temp), []);
});

test("dispatcher pin matches the maintained native bootstrap bytes", () => {
  const digest = createHash("sha256")
    .update(readFileSync(resolve("docs/public/install-native-alpha.sh")))
    .digest("hex");
  assert.ok(source.includes(digest));
});
