import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const installer = path.resolve("docs/public/install.sh");
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const bin = path.join(root, "tools");
  const prefix = path.join(root, "install space ' quote");
  fs.mkdirSync(bin);
  function script(name, body) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nset -eu\n" + body, { mode: 0o755 });
  }
  script(
    "uname",
    `case "$1" in -s) echo "\${MOCK_OS:-${platform === "darwin" ? "Darwin" : "Linux"}}" ;; -m) echo "\${MOCK_ARCH:-${arch === "arm64" ? "arm64" : "x86_64"}}" ;; esac\n`,
  );
  script("getconf", '[ -z "${MOCK_MUSL:-}" ] || exit 1; exec /usr/bin/getconf "$@"\n');
  script("tmux-ide", "echo stale-PATH-version; exit 99\n");
  const sha = createHash("sha256").update("archive").digest("hex");
  script(
    "curl",
    `[ -z "\${MOCK_NETWORK_FAIL:-}" ] || exit 7
url=''; out=''; while [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1 ;; -o) shift; out=$1 ;; esac; shift; done
case "$url" in *SHASUMS256.txt) printf '%s  node-v24.1.0-${target}.tar.gz\\n' '${sha}' > "$out" ;; *) printf '%s' "\${MOCK_ARCHIVE:-archive}" > "$out" ;; esac\n`,
  );
  const npm = path.join(root, "npm.mjs");
  fs.writeFileSync(
    npm,
    `import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
if (process.env.MOCK_NPM_FAIL) process.exit(1);
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const root=path.join(prefix,'lib/node_modules/tmux-ide');
for (const dir of ['bin','scripts','packages/daemon/dist/native/tmux/${target}']) fs.mkdirSync(path.join(root,dir),{recursive:true});
const version = process.env.MOCK_VERSION || '2.9.0';
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));
fs.writeFileSync(path.join(root,'bin/cli.js'), "if(process.env.MOCK_RELOCATED_FAIL && !__filename.includes('.install.')) process.exit(1); if(process.env.MOCK_TUI_FAIL && process.argv.includes('--tui-binary')) process.exit(1); console.log(process.env.MOCK_BAD_VERSION ? 'tmux-ide v0.0.0' : 'tmux-ide v"+version+"');");
fs.writeFileSync(path.join(root,'scripts/postinstall.js'), "if(process.env.MOCK_POSTINSTALL_HOLD) { require('node:fs').writeFileSync(process.env.MOCK_POSTINSTALL_HOLD, 'ready'); setInterval(()=>{}, 1000); } if(process.env.MOCK_POSTINSTALL_FAIL) process.exit(1); if(process.env.npm_config_global === 'true') throw new Error('must not update the daemon implicitly'); require('node:fs').appendFileSync(process.env.HOME+'/postinstall', 'installed\\\\n');");

if (!process.env.MOCK_MISSING_TMUX) fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/tmux'),'#!/bin/sh\\necho tmux '+(process.env.MOCK_OLD_TMUX ? '3.4' : '3.7c')+'\\n');
const native=path.join(root,'packages/daemon/dist/native/tmux/${target}/tmux');
fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/manifest.json'),JSON.stringify({platform:'${platform}',arch:'${arch}',minimumMacOS:'1.0',minimumGlibc:'1.0',files:{tmux:fs.existsSync(native)?createHash('sha256').update(fs.readFileSync(native)).digest('hex'):'0'.repeat(64)}}));
if(process.env.MOCK_NATIVE_CORRUPT) fs.appendFileSync(native,'corrupt');
`,
  );
  const node = process.execPath;
  script(
    "tar",
    `[ -z "\${MOCK_TAR_FAIL:-}" ] || exit 2
while [ "$1" != '-C' ]; do shift; done; shift
mkdir -p "$1/bin"
ln -s ${quote(node)} "$1/bin/node"
printf '%s\\n' '#!/bin/sh' 'exec ${node} ${quote(npm).replaceAll("'", "'\\''")} "$@"' > "$1/bin/npm"
chmod +x "$1/bin/npm"\n`,
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX_IDE_RUNTIME_MODE: "",
  };
  const run = (extra = {}, args = []) =>
    spawnSync("/bin/sh", [installer, "--prefix", prefix, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  return { root, prefix, run, env };
}

test("fresh install and upgrade work with spaces and shell punctuation", (t) => {
  const { root, prefix, run } = fixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const current = path.join(prefix, "share/tmux-ide/current");
  const previous = fs.readlinkSync(current);
  const launch = spawnSync(path.join(prefix, "bin/tmux-ide"), ["--version"], { encoding: "utf8" });
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /v2.9.0/);
  const upgraded = run();
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.notEqual(fs.readlinkSync(current), previous);
  assert.ok(fs.existsSync(previous), "keep runtime files for existing processes");
  assert.ok(fs.existsSync(path.join(root, "postinstall")));
});
for (const [label, failure] of [
  ["postinstall failure", { MOCK_POSTINSTALL_FAIL: "1" }],
  ["relocated CLI failure", { MOCK_RELOCATED_FAIL: "1" }],
  ["native checksum mismatch", { MOCK_NATIVE_CORRUPT: "1" }],
  ["checksum mismatch", { MOCK_ARCHIVE: "corrupt" }],
  ["npm failure", { MOCK_NPM_FAIL: "1" }],
  [
    "offline or proxy transport failure",
    { MOCK_NETWORK_FAIL: "1", HTTPS_PROXY: "http://127.0.0.1:1" },
  ],
  ["archive extraction failure", { MOCK_TAR_FAIL: "1" }],
  ["unsupported operating system", { MOCK_OS: "FreeBSD" }],
  ["unsupported architecture", { MOCK_ARCH: "riscv64" }],
  ["unsupported libc", { MOCK_OS: "Linux", MOCK_MUSL: "1" }],
  ["mismatched CLI version", { MOCK_BAD_VERSION: "1" }],
  ["TUI download failure", { MOCK_TUI_FAIL: "1" }],
  ["missing platform bundle", { MOCK_MISSING_TMUX: "1" }],
  ["unsupported tmux version", { MOCK_OLD_TMUX: "1" }],
])
  test(`${label} preserves an existing installation`, (t) => {
    const { prefix, run } = fixture(t);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const root = path.join(prefix, "share/tmux-ide");
    const previous = fs.readlinkSync(path.join(root, "current"));
    assert.notEqual(run(failure).status, 0);
    assert.equal(fs.readlinkSync(path.join(root, "current")), previous);
    assert.ok(!fs.existsSync(path.join(root, "install.lock")));
    assert.ok(fs.readdirSync(path.join(root, "releases")).every((x) => !x.startsWith(".install.")));
  });
test("unmanaged launcher is preserved", (t) => {
  const { prefix, run } = fixture(t);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const launcher = path.join(prefix, "bin/tmux-ide");
  fs.writeFileSync(launcher, "existing");
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(launcher, "utf8"), "existing");
});

test("rollback swaps verified releases offline and uninstall preserves user data", (t) => {
  const { root, prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const managed = path.join(prefix, "share/tmux-ide");
  const first = fs.readlinkSync(path.join(managed, "current"));
  assert.equal(run({ MOCK_VERSION: "2.9.1" }, ["--version", "2.9.1"]).status, 0);
  const second = fs.readlinkSync(path.join(managed, "current"));
  assert.equal(fs.readlinkSync(path.join(managed, "previous")), first);
  const rollback = run({ MOCK_NPM_FAIL: "1", MOCK_ARCHIVE: "invalid" }, ["--rollback"]);
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(fs.realpathSync(path.join(managed, "current")), fs.realpathSync(first));
  assert.equal(fs.realpathSync(path.join(managed, "previous")), fs.realpathSync(second));
  const data = path.join(root, ".tmux-ide");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "machines.json"), "keep");
  const remove = run({ MOCK_NPM_FAIL: "1" }, ["--uninstall"]);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(fs.existsSync(path.join(prefix, "bin/tmux-ide")), false);
  assert.equal(fs.readFileSync(path.join(data, "machines.json"), "utf8"), "keep");
  assert.ok(fs.existsSync(first) && fs.existsSync(second));
  assert.equal(run().status, 0, "reinstall after uninstall");
});

test("missing or corrupt rollback target leaves the current release active", (t) => {
  const { prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const root = path.join(prefix, "share/tmux-ide");
  const first = fs.readlinkSync(path.join(root, "current"));
  assert.notEqual(run({}, ["--rollback"]).status, 0);
  assert.equal(fs.readlinkSync(path.join(root, "current")), first);
  assert.equal(run().status, 0);
  const active = fs.readlinkSync(path.join(root, "current"));
  fs.writeFileSync(path.join(first, "npm/lib/node_modules/tmux-ide/bin/cli.js"), "process.exit(1)");
  assert.notEqual(run({}, ["--rollback"]).status, 0);
  assert.equal(fs.readlinkSync(path.join(root, "current")), active);
});

test("late failure on a fresh install leaves no managed launcher or release", (t) => {
  const { prefix, run } = fixture(t);
  assert.notEqual(run({ MOCK_POSTINSTALL_FAIL: "1" }).status, 0);
  assert.equal(fs.existsSync(path.join(prefix, "bin/tmux-ide")), false);
  const root = path.join(prefix, "share/tmux-ide");
  assert.equal(fs.existsSync(path.join(root, "installer-v1")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "releases")), []);
});

test("an active installation lock prevents all mutations", (t) => {
  const { prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const root = path.join(prefix, "share/tmux-ide");
  const active = fs.readlinkSync(path.join(root, "current"));
  fs.mkdirSync(path.join(root, "install.lock"));
  for (const args of [[], ["--rollback"], ["--uninstall"]]) {
    assert.notEqual(run({}, args).status, 0);
    assert.equal(fs.readlinkSync(path.join(root, "current")), active);
  }
});

test("explicit pruning retains current and rollback, skips unknown files, and works offline", (t) => {
  const { prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const root = path.join(prefix, "share/tmux-ide");
  const releases = path.join(root, "releases");
  const retired = fs.readlinkSync(path.join(root, "current"));
  assert.equal(run().status, 0);
  const previous = fs.readlinkSync(path.join(root, "current"));
  assert.equal(run().status, 0);
  const current = fs.readlinkSync(path.join(root, "current"));
  const unknown = path.join(releases, "install-ABCDEF");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, "user-data"), "keep");
  const linked = path.join(releases, "install-SYMLNK");
  fs.symlinkSync(retired, linked);
  assert.notEqual(run({}, ["--prune"]).status, 0);
  assert.ok(fs.existsSync(retired));
  const result = run({ MOCK_NPM_FAIL: "1", MOCK_ARCHIVE: "invalid" }, ["--prune", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(retired), false);
  assert.ok(fs.existsSync(current) && fs.existsSync(previous));
  assert.equal(fs.readFileSync(path.join(unknown, "user-data"), "utf8"), "keep");
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(root, "current")), current);
  assert.equal(fs.readlinkSync(path.join(root, "previous")), previous);
  assert.equal(run({}, ["--prune", "--yes"]).status, 0, "pruning is idempotent");
});

test("retention cap refuses another install until explicit cleanup", (t) => {
  const { prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const root = path.join(prefix, "share/tmux-ide");
  const current = fs.readlinkSync(path.join(root, "current"));
  for (let i = 0; i < 7; i++) {
    const retired = path.join(root, "releases", i === 6 ? "install-zzzzzzzz" : `install-OLD00${i}`);
    fs.mkdirSync(retired);
    fs.writeFileSync(path.join(retired, ".installer-release-v1"), "1\n");
  }
  const retainedBefore = fs.readdirSync(path.join(root, "releases"));
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Eight retained releases/);
  assert.deepEqual(fs.readdirSync(path.join(root, "releases")), retainedBefore);
  assert.equal(fs.readlinkSync(path.join(root, "current")), current);
  assert.equal(run({}, ["--prune", "--yes"]).status, 0);
  assert.equal(run().status, 0);
});

test("pre-staging failure preserves every retained runtime", (t) => {
  const { prefix, run } = fixture(t);
  assert.equal(run().status, 0);
  const root = path.join(prefix, "share/tmux-ide");
  const retired = path.join(root, "releases", "install-zzzzzzzz");
  fs.mkdirSync(retired);
  fs.writeFileSync(path.join(retired, ".installer-release-v1"), "1\n");
  fs.writeFileSync(path.join(retired, "live-runtime"), "still needed by a running daemon");
  const releases = fs.readdirSync(path.join(root, "releases"));
  const failed = run({ MOCK_OS: "FreeBSD" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Supported systems/);
  assert.deepEqual(fs.readdirSync(path.join(root, "releases")), releases);
  assert.equal(
    fs.readFileSync(path.join(retired, "live-runtime"), "utf8"),
    "still needed by a running daemon",
  );
});

for (const signal of ["SIGTERM", "SIGINT"])
  test(`${signal} during relocated setup removes the candidate and preserves the old release`, async (t) => {
    const { root, prefix, run, env } = fixture(t);
    assert.equal(run().status, 0);
    const managed = path.join(prefix, "share/tmux-ide");
    const current = fs.readlinkSync(path.join(managed, "current"));
    const releases = fs.readdirSync(path.join(managed, "releases"));
    const ready = path.join(root, "postinstall-ready");
    const child = spawn("/bin/sh", [installer, "--prefix", prefix], {
      env: { ...env, MOCK_POSTINSTALL_HOLD: ready },
      detached: true,
      stdio: "ignore",
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(ready)) {
      assert.ok(Date.now() < deadline, "fixture reached relocated postinstall");
      assert.equal(child.exitCode, null);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-child.pid, signal);
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("installer did not terminate")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(fs.readlinkSync(path.join(managed, "current")), current);
    assert.deepEqual(fs.readdirSync(path.join(managed, "releases")), releases);
    assert.equal(fs.existsSync(path.join(managed, "install.lock")), false);
    assert.equal(run().status, 0, "a subsequent installation succeeds");
  });
