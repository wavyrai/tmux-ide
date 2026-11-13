import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const installer = path.resolve("docs/public/install.sh");
// Linux runs the installer under dash and macOS under bash; either can be chosen here.
const shell = process.env.TMUX_IDE_INSTALLER_TEST_SHELL || "/bin/sh";
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
    `case "$1" in -s) echo "\${MOCK_OS:-${platform === "darwin" ? "Darwin" : "Linux"}}" ;; -m) echo "\${MOCK_ARCH:-${arch === "arm64" ? "arm64" : "x86_64"}}" ;; -n) echo "\${MOCK_HOST:-this-host}" ;; esac\n`,
  );
  script("getconf", '[ -z "${MOCK_MUSL:-}" ] || exit 1; exec /usr/bin/getconf "$@"\n');
  script("tmux-ide", "echo stale-PATH-version; exit 99\n");
  // Stands in for another installer that takes the dead owner's lock between
  // this run's first look at it and its turn under the takeover guard.
  script(
    "find",
    'case "${MOCK_TAKEOVER_RACE:-}:$1" in ?*:*.takeover) printf "%s" "$MOCK_TAKEOVER_RACE" > "${1%.takeover}/owner" ;; esac; exec /usr/bin/find "$@"\n',
  );
  script(
    "rm",
    'case "${MOCK_RM_FAIL:-}:$*" in 1:*/.install.*) exit 1 ;; esac; exec /bin/rm "$@"\n',
  );
  const sha = createHash("sha256").update("archive").digest("hex");
  script(
    "curl",
    `[ -z "\${MOCK_NETWORK_FAIL:-}" ] || exit 7
if [ -n "\${MOCK_CURL_HOLD:-}" ]; then : > "$MOCK_CURL_HOLD"; while :; do sleep 1; done; fi
url=''; out=''; while [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1 ;; -o) shift; out=$1 ;; esac; shift; done
case "$url" in *SHASUMS256.txt) printf '%s  node-v24.1.0-${target}.tar.gz\\n' '${sha}' > "$out" ;; *) printf '%s' "\${MOCK_ARCHIVE:-archive}" > "$out" ;; esac\n`,
  );
  const npm = path.join(root, "npm.mjs");
  fs.writeFileSync(
    npm,
    `import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
if (process.env.MOCK_NPM_FAIL) process.exit(1);
if (!process.argv.includes('--ignore-scripts')) { console.error('installer must run npm with --ignore-scripts'); process.exit(1); }
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const root=path.join(prefix,'lib/node_modules/tmux-ide');
for (const dir of ['bin','scripts','packages/daemon/dist/native/tmux/${target}']) fs.mkdirSync(path.join(root,dir),{recursive:true});
const version = process.env.MOCK_VERSION || '2.9.0';
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));
fs.writeFileSync(path.join(root,'bin/cli.js'), "if(process.argv.includes('--daemon')){ require('node:fs').appendFileSync(process.env.HOME+'/daemon-upgrades', process.argv.slice(2).join(' ')+'\\\\n'); console.log(JSON.stringify({ok:true,status:'ready',productVersion:'"+version+"'})); process.exit(0); } if(process.argv.includes('agent-teams')){ if(process.env.MOCK_TEAMS_FAIL) process.exit(1); const r=require('node:child_process').spawnSync(process.execPath,['${path.resolve("bin/cli.js")}',...process.argv.slice(2)],{stdio:'inherit'}); process.exit(r.status ?? 1); } if(process.env.MOCK_RELOCATED_FAIL && !__filename.includes('.install.')) process.exit(1); if(process.env.MOCK_TUI_FAIL && process.argv.includes('--tui-binary')) process.exit(1); console.log(process.env.MOCK_BAD_VERSION ? 'tmux-ide v0.0.0' : 'tmux-ide v"+version+"');");
fs.writeFileSync(path.join(root,'scripts/postinstall.js'), "if(process.env.MOCK_POSTINSTALL_HOLD) { require('node:fs').writeFileSync(process.env.MOCK_POSTINSTALL_HOLD, 'ready'); setInterval(()=>{}, 1000); } if(process.env.MOCK_POSTINSTALL_FAIL) process.exit(1); if(process.env.npm_config_global === 'true') throw new Error('must not update the daemon implicitly'); require('node:fs').appendFileSync(process.env.HOME+'/postinstall', 'installed\\\\n');");

if (!process.env.MOCK_MISSING_TMUX) fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/tmux'),'#!/bin/sh\\necho tmux '+(process.env.MOCK_OLD_TMUX ? '3.4' : '3.7c')+'\\n');
const native=path.join(root,'packages/daemon/dist/native/tmux/${target}/tmux');
fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/manifest.json'),JSON.stringify({platform:'${platform}',arch:'${arch}',minimumMacOS:'1.0',minimumGlibc:'1.0',files:{tmux:fs.existsSync(native)?createHash('sha256').update(fs.readFileSync(native)).digest('hex'):'0'.repeat(64)}}));
if(process.env.MOCK_NATIVE_CORRUPT) fs.appendFileSync(native,'corrupt');
`,
  );
  const node = process.execPath;
  const npmCommand = `exec ${quote(node)} ${quote(npm)} "$@"`;
  script(
    "tar",
    `[ -z "\${MOCK_TAR_FAIL:-}" ] || exit 2
while [ "$1" != '-C' ]; do shift; done; shift
mkdir -p "$1/bin"
if [ -n "\${MOCK_READ_ONLY_STAGE:-}" ]; then mkdir "$1/sealed"; : > "$1/sealed/file"; chmod 555 "$1/sealed"; fi
ln -s ${quote(node)} "$1/bin/node"
printf '%s\\n' '#!/bin/sh' ${quote(npmCommand)} > "$1/bin/npm"
chmod +x "$1/bin/npm"\n`,
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX_IDE_RUNTIME_MODE: "",
    // Agent-teams setup must resolve Claude settings from the fixture HOME only.
    TMUX_IDE_CLAUDE_SETTINGS: "",
    TMUX_IDE_CLAUDE_DIR: "",
    TMUX_IDE_NO_CLAUDE_AGENT_TEAMS: "",
  };
  const run = (extra = {}, args = []) =>
    spawnSync(shell, [installer, "--prefix", prefix, ...args], {
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
test("installer output stays concise and names a PATH entry that shadows the launcher", (t) => {
  const { run } = fixture(t);
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /tmux-ide installer · tmux-ide\.com/);
  assert.match(installed.stdout, /Installed successfully\. tmux-ide 2\.9\.0 is ready\./);
  // The fixture puts a stale tmux-ide first on PATH.
  assert.match(installed.stdout, /Another tmux-ide comes first on your PATH/);
  assert.doesNotMatch(installed.stdout, /tmux-ide v2\.9\.0\n*$/, "no trailing version echo");
});
test("printed start and update commands execute with spaces and shell punctuation", (t) => {
  const { run, env } = fixture(t);
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  for (const label of ["Start", "Update"]) {
    const command = installed.stdout.match(new RegExp(`  ${label}: +([^\\n]+)`))?.[1];
    assert.ok(command, `${label} must provide a copyable command`);
    const result = spawnSync("/bin/sh", ["-c", command], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tmux-ide v2\.9\.0/);
  }
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
  ["unsupported Intel Mac", { MOCK_OS: "Darwin", MOCK_ARCH: "x86_64" }],
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

// A lock names its owner, so only a live installation blocks the next one (#751).
const startedAt = (pid) =>
  spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
    .stdout.trim()
    .replace(/\s+/g, " ");
function heldLock(prefix, owner, { ageMinutes = 0 } = {}) {
  const lock = path.join(prefix, "share/tmux-ide/install.lock");
  fs.mkdirSync(lock, { recursive: true });
  if (owner) fs.writeFileSync(path.join(lock, "owner"), owner);
  const then = new Date(Date.now() - ageMinutes * 60000);
  fs.utimesSync(lock, then, then);
  return lock;
}
const deadPid = () => {
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(exited.status, 0);
  return exited.pid;
};

test("a lock whose owner is running blocks the installation and names the owner", (t) => {
  const { prefix, run } = fixture(t);
  const lock = heldLock(prefix, `${process.pid}\n${startedAt(process.pid)}\n`);
  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, new RegExp(`Another installation is running \\(pid ${process.pid}`));
  assert.equal(
    fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0],
    String(process.pid),
    "the live owner keeps its lock",
  );
});

for (const [label, owner] of [
  ["whose owner has exited", () => `${deadPid()}\nMon Jan  1 00:00:00 2024\n`],
  ["whose pid now belongs to another process", () => `${process.pid}\nMon Jan 1 00:00:00 2024\n`],
])
  test(`a lock ${label} is taken over`, (t) => {
    const { prefix, run } = fixture(t);
    const lock = heldLock(prefix, owner());
    const installed = run();
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /lock of an installation that is no longer running/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(`${lock}.takeover`), false);
  });

test("a lock without an owner record blocks while fresh and is taken over once old", (t) => {
  const { prefix, run } = fixture(t);
  const lock = heldLock(prefix, null, { ageMinutes: 5 });
  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /If no installation is running, remove that directory/);
  assert.ok(fs.existsSync(lock));
  heldLock(prefix, null, { ageMinutes: 30 });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(lock), false);
});

test("an owner on another machine is judged by the lock's age, never by its pid", (t) => {
  const { prefix, run } = fixture(t);
  // A shared home: this pid is alive here, and says nothing about that host.
  const owner = `${deadPid()}\nMon Jan  1 00:00:00 2024\nother-host\n`;
  const lock = heldLock(prefix, owner, { ageMinutes: 5 });
  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Another installation is running on other-host/);
  assert.ok(fs.existsSync(path.join(lock, "owner")));
  heldLock(prefix, owner, { ageMinutes: 30 });
  assert.equal(run().status, 0);
  assert.equal(fs.existsSync(lock), false);
});

test("a run records its own host", async (t) => {
  const { prefix, run } = fixture(t);
  const lock = heldLock(prefix, `${process.pid}\n${startedAt(process.pid)}\nthis-host\n`);
  const blocked = run();
  assert.match(
    blocked.stderr,
    new RegExp(`Another installation is running \\(pid ${process.pid};`),
  );
  assert.ok(fs.existsSync(lock));
});

// A closed pipe ends the run like any other signal. (The postinstall stand-in
// is Node, which ignores SIGPIPE, so this one is sent during the download.)
test("SIGPIPE during the download releases the lock", async (t) => {
  const { root, prefix, run, env } = fixture(t);
  const ready = path.join(root, "curl-ready");
  const child = spawn(shell, [installer, "--prefix", prefix], {
    env: { ...env, MOCK_CURL_HOLD: ready },
    detached: true,
    stdio: "ignore",
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < deadline, "fixture reached the download");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  process.kill(-child.pid, "SIGPIPE");
  await closed;
  const managed = path.join(prefix, "share/tmux-ide");
  assert.equal(fs.existsSync(path.join(managed, "install.lock")), false);
  assert.deepEqual(fs.readdirSync(path.join(managed, "releases")), []);
  assert.equal(run().status, 0, "a subsequent installation succeeds");
});

// The guard directory lets one run at a time remove a dead owner's lock.
test("a takeover in progress blocks another; one that died stops blocking after a minute", (t) => {
  const { prefix, run } = fixture(t);
  const lock = heldLock(prefix, `${deadPid()}\nMon Jan  1 00:00:00 2024\n`);
  const guard = `${lock}.takeover`;
  fs.mkdirSync(guard);
  const blocked = run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Another installation may be running/);
  assert.doesNotMatch(blocked.stderr, /pid \d/, "the dead owner is not named as running");
  assert.ok(fs.existsSync(lock) && fs.existsSync(guard), "nothing was taken");
  const then = new Date(Date.now() - 5 * 60000);
  fs.utimesSync(guard, then, then);
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(guard), false);
});

test("a run that loses the takeover to another leaves the winner's lock alone", (t) => {
  const { prefix, run } = fixture(t);
  const lock = heldLock(prefix, `${deadPid()}\nMon Jan  1 00:00:00 2024\n`);
  const winner = `${process.pid}\n${startedAt(process.pid)}\nthis-host\n`;
  const lost = run({ MOCK_TAKEOVER_RACE: winner });
  assert.notEqual(lost.status, 0);
  assert.match(lost.stderr, new RegExp(`Another installation is running \\(pid ${process.pid};`));
  assert.equal(
    fs.readFileSync(path.join(lock, "owner"), "utf8"),
    winner,
    "the winner keeps its lock",
  );
  assert.equal(fs.existsSync(`${lock}.takeover`), false, "the guard is released");
});

test("of many installers that find a dead owner's lock, one takes it and the rest refuse", async (t) => {
  const { root, prefix, env } = fixture(t);
  const lock = path.join(prefix, "share/tmux-ide/install.lock");
  const children = [];
  t.after(() => {
    for (const { child } of children)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
  });
  for (let round = 0; round < 4; round++) {
    heldLock(prefix, `${deadPid()}\nMon Jan  1 00:00:00 2024\n`);
    const ready = path.join(root, `curl-ready-${round}`);
    const started = Array.from({ length: 8 }, () => {
      const child = spawn(shell, [installer, "--prefix", prefix], {
        env: { ...env, MOCK_CURL_HOLD: ready },
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const entry = { child, stderr: "", code: undefined };
      child.stderr.on("data", (chunk) => (entry.stderr += chunk));
      entry.closed = new Promise((resolve) =>
        child.once("close", (code) => resolve((entry.code = code))),
      );
      children.push(entry);
      return entry;
    });
    const deadline = Date.now() + 20000;
    while (
      started.filter((entry) => entry.code === undefined).length > 1 ||
      !fs.existsSync(ready)
    ) {
      assert.ok(Date.now() < deadline, "seven refused and one reached its download");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const holders = started.filter((entry) => entry.code === undefined);
    assert.equal(holders.length, 1, "exactly one installer holds the lock");
    for (const entry of started.filter((entry) => entry !== holders[0])) {
      assert.notEqual(entry.code, 0);
      assert.match(entry.stderr, /Another installation (is|may be) running/);
    }
    // The refused runs have exited: none of them may have released the holder's lock.
    assert.equal(
      fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0],
      String(holders[0].child.pid),
    );
    assert.equal(fs.existsSync(`${lock}.takeover`), false);
    process.kill(-holders[0].child.pid, "SIGTERM");
    await holders[0].closed;
    assert.equal(fs.existsSync(lock), false, "the holder released its lock");
    assert.equal(fs.existsSync(`${lock}.takeover`), false);
  }
});

test("a failure whose staging files cannot be removed at first still releases the lock", (t) => {
  const { prefix, run } = fixture(t);
  const root = path.join(prefix, "share/tmux-ide");
  const failed = run({ MOCK_READ_ONLY_STAGE: "1", MOCK_NPM_FAIL: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(path.join(root, "install.lock")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "releases")), []);
  assert.equal(run().status, 0, "the retry installs");
});

test("a failure whose staging files cannot be removed at all still releases the lock", (t) => {
  const { prefix, run } = fixture(t);
  const root = path.join(prefix, "share/tmux-ide");
  const failed = run({ MOCK_RM_FAIL: "1", MOCK_NPM_FAIL: "1" });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(path.join(root, "install.lock")), false);
  assert.equal(fs.readdirSync(path.join(root, "releases")).length, 1, "the stage stayed");
  assert.equal(run().status, 0, "the retry installs");
});

test("an installation killed during its download does not block the retry", async (t) => {
  const { root, prefix, run, env } = fixture(t);
  const ready = path.join(root, "curl-ready");
  const child = spawn(shell, [installer, "--prefix", prefix], {
    env: { ...env, MOCK_CURL_HOLD: ready },
    detached: true,
    stdio: "ignore",
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < deadline, "fixture reached the download");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const lock = path.join(prefix, "share/tmux-ide/install.lock");
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8").split("\n")[0], String(child.pid));
  assert.notEqual(run().status, 0, "the running installation keeps its lock");
  process.kill(-child.pid, "SIGKILL");
  await closed;
  assert.ok(fs.existsSync(lock), "SIGKILL leaves the lock behind");
  const retried = run();
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(fs.existsSync(lock), false);
  assert.ok(
    fs
      .readdirSync(path.join(prefix, "share/tmux-ide/releases"))
      .some((x) => x.startsWith(".install.")),
    "the killed run's staging directory is left for it, not guessed at",
  );
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

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"])
  test(`${signal} during relocated setup removes the candidate and preserves the old release`, async (t) => {
    const { root, prefix, run, env } = fixture(t);
    assert.equal(run().status, 0);
    const managed = path.join(prefix, "share/tmux-ide");
    const current = fs.readlinkSync(path.join(managed, "current"));
    const releases = fs.readdirSync(path.join(managed, "releases"));
    const ready = path.join(root, "postinstall-ready");
    const child = spawn(shell, [installer, "--prefix", prefix], {
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

// The fixture PATH is tools:/usr/bin:/bin, so only ~/.claude can signal Claude Code
// unless the host has a system-wide claude binary.
const systemClaude = ["/usr/bin/claude", "/bin/claude"].some((file) => fs.existsSync(file));
const teamsSettings = (root) => path.join(root, ".claude", "settings.json");

test("install enables Claude Code agent teams when ~/.claude exists", (t) => {
  const { root, run } = fixture(t);
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(teamsSettings(root), JSON.stringify({ model: "opus" }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Enabled Claude Code agent teams in ~\/\.claude\/settings\.json/);
  assert.match(result.stdout, /Disable: tmux-ide integration agent-teams disable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(teamsSettings(root), "utf8")), {
    model: "opus",
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
    teammateMode: "auto",
  });
  assert.ok(
    fs.readdirSync(path.join(root, ".claude")).some((f) => f.includes(".tmux-ide-backup-")),
  );
  assert.match(run().stdout, /already enabled/, "a reinstall changes nothing");
});

test("install skips agent teams without Claude Code", { skip: systemClaude }, (t) => {
  const { root, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Code not found/);
  assert.equal(fs.existsSync(path.join(root, ".claude")), false);
});

test("install respects a user's agent-teams opt-out", (t) => {
  const { root, run } = fixture(t);
  fs.mkdirSync(path.join(root, ".claude"));
  const original = JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" } });
  fs.writeFileSync(teamsSettings(root), original);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /disabled by user/);
  assert.equal(fs.readFileSync(teamsSettings(root), "utf8"), original);
});

for (const [label, extra, args] of [
  ["--no-claude-agent-teams", {}, ["--no-claude-agent-teams"]],
  ["TMUX_IDE_NO_CLAUDE_AGENT_TEAMS=1", { TMUX_IDE_NO_CLAUDE_AGENT_TEAMS: "1" }, []],
])
  test(`${label} opts out of the agent-teams step`, (t) => {
    const { root, run } = fixture(t);
    fs.mkdirSync(path.join(root, ".claude"));
    const result = run(extra, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipped Claude Code agent teams \(opted out\)/);
    assert.equal(fs.existsSync(teamsSettings(root)), false);
  });

test("an agent-teams failure warns but never fails the install", (t) => {
  const { root, prefix, run } = fixture(t);
  fs.mkdirSync(path.join(root, ".claude"));
  const result = run({ MOCK_TEAMS_FAIL: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Warning: could not configure Claude Code agent teams/);
  assert.match(result.stdout, /Installed successfully/);
  assert.ok(fs.existsSync(path.join(prefix, "bin/tmux-ide")));
});

// A running older daemon moves to the new release; tmux sessions are not touched.
function writeDaemonRecord(root, record) {
  fs.mkdirSync(path.join(root, ".tmux-ide"), { recursive: true });
  fs.writeFileSync(path.join(root, ".tmux-ide/daemon.json"), JSON.stringify(record));
}
test("install restarts a running older daemon on the new release", (t) => {
  const { root, run } = fixture(t);
  writeDaemonRecord(root, { pid: process.pid, productVersion: "2.8.0" });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Restarted the daemon on 2\.9\.0; tmux sessions kept running/);
  assert.equal(
    fs.readFileSync(path.join(root, "daemon-upgrades"), "utf8"),
    "update --daemon --if-running --json\n",
  );
});
test("install leaves a current or stopped daemon alone", (t) => {
  const { root, run } = fixture(t);
  writeDaemonRecord(root, { pid: process.pid, productVersion: "2.9.0" });
  assert.equal(run().status, 0);
  writeDaemonRecord(root, { pid: 2 ** 22 + 1, productVersion: "2.8.0" });
  assert.equal(run().status, 0);
  assert.equal(fs.existsSync(path.join(root, "daemon-upgrades")), false);
});
for (const [label, extra, args] of [
  ["--no-daemon-upgrade", {}, ["--no-daemon-upgrade"]],
  ["TMUX_IDE_NO_DAEMON_UPGRADE=1", { TMUX_IDE_NO_DAEMON_UPGRADE: "1" }, []],
])
  test(`${label} keeps the running daemon and prints the move command`, (t) => {
    const { root, run } = fixture(t);
    writeDaemonRecord(root, { pid: process.pid, productVersion: "2.8.0" });
    const result = run(extra, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /A tmux-ide 2\.8\.0 daemon is still running[^]*update --daemon --if-running/,
    );
    assert.equal(fs.existsSync(path.join(root, "daemon-upgrades")), false);
  });
test("--no-daemon-upgrade is refused for maintenance actions", (t) => {
  const { run } = fixture(t);
  assert.equal(run().status, 0);
  const result = run({}, ["--rollback", "--no-daemon-upgrade"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only valid when installing/);
});

// launchd: a job that starts another tmux-ide copy would relaunch it forever.
const launchdTest = process.platform === "darwin" ? test : test.skip;
function launchdFixture(t, ownerVersion) {
  const context = fixture(t);
  const { root } = context;
  const agents = path.join(root, "Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const owner = path.join(root, "old global", "tmux-ide");
  fs.mkdirSync(path.dirname(owner));
  fs.writeFileSync(owner, `#!/bin/sh\necho 'tmux-ide v${ownerVersion}'\n`, { mode: 0o755 });
  const plist = path.join(agents, "com.tmux-ide.daemon.plist");
  const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("'", "&apos;");
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.tmux-ide.daemon</string>
<key>ProgramArguments</key><array><string>${xml(owner)}</string><string>--headless</string><string>--supervised</string><string>launchd-user</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(owner))}:/usr/bin:/bin</string></dict>
<key>KeepAlive</key><true/>
</dict></plist>
`,
  );
  // Mock launchctl: the job starts loaded; bootstrap publishes the new daemon.
  const state = path.join(root, "launchd-loaded");
  fs.writeFileSync(state, "");
  fs.writeFileSync(
    path.join(root, "tools/launchctl"),
    `#!/bin/sh
echo "$*" >> ${quote(path.join(root, "launchctl.log"))}
case "$1" in
  print) [ -f ${quote(state)} ] ;;
  bootout) rm -f ${quote(state)} ;;
  bootstrap) : > ${quote(state)}; mkdir -p "$HOME/.tmux-ide"; printf '{"pid":%s,"productVersion":"2.9.0","supervisionId":"launchd-user"}' "$MOCK_DAEMON_PID" > "$HOME/.tmux-ide/daemon.json" ;;
esac
`,
    { mode: 0o755 },
  );
  const job = () =>
    JSON.parse(
      spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", plist], {
        encoding: "utf8",
      }).stdout,
    );
  const launchctl = () => fs.readFileSync(path.join(root, "launchctl.log"), "utf8");
  return { ...context, plist, owner, job, launchctl };
}
launchdTest("install moves a launchd job from an older copy to the managed launcher", (t) => {
  const { root, prefix, run, job, launchctl, owner } = launchdFixture(t, "2.8.0");
  const result = run({ MOCK_DAEMON_PID: String(process.pid) });
  assert.equal(result.status, 0, result.stderr);
  const launcher = path.join(prefix, "bin/tmux-ide");
  const moved = job();
  assert.deepEqual(moved.ProgramArguments, [
    launcher,
    "--headless",
    "--supervised",
    "launchd-user",
  ]);
  assert.equal(moved.AbandonProcessGroup, true);
  assert.equal(moved.KeepAlive, true);
  assert.equal(
    moved.EnvironmentVariables.PATH,
    `${path.join(prefix, "bin")}:${path.dirname(owner)}:/usr/bin:/bin`,
  );
  assert.match(
    launchctl(),
    /^print .*\nbootout gui\/\d+\/com\.tmux-ide\.daemon\n(print .*\n)+bootstrap gui\/\d+ .*com\.tmux-ide\.daemon\.plist\n$/,
  );
  assert.match(
    result.stdout,
    /Moved launchd job com\.tmux-ide\.daemon from .* to this installation/,
  );
  assert.doesNotMatch(result.stdout, /has not reported/);
  const backups = fs.readdirSync(path.join(prefix, "share/tmux-ide/service-backups"));
  assert.equal(backups.length, 1);
  // The daemon came back on the new release: no separate restart is needed.
  assert.equal(fs.existsSync(path.join(root, "daemon-upgrades")), false);
  // Idempotent: the job already points at the managed launcher.
  assert.equal(run({ MOCK_DAEMON_PID: String(process.pid) }).status, 0);
  assert.doesNotMatch(launchctl(), /bootout[^]*bootout/);
});
launchdTest("install leaves a launchd job from a newer copy unchanged", (t) => {
  const { run, job, owner, launchctl } = launchdFixture(t, "9.0.0");
  const before = job();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(job(), before);
  assert.equal(job().ProgramArguments[0], owner);
  assert.match(
    result.stdout,
    /launchd job com\.tmux-ide\.daemon starts tmux-ide 9\.0\.0 .* left unchanged/,
  );
  assert.throws(launchctl);
});
launchdTest("--no-daemon-upgrade reports a stale launchd job without changing it", (t) => {
  const { run, job, launchctl } = launchdFixture(t, "2.8.0");
  const before = job();
  const result = run({}, ["--no-daemon-upgrade"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(job(), before);
  assert.match(
    result.stdout,
    /launchd job com\.tmux-ide\.daemon still starts .*without --no-daemon-upgrade/,
  );
  assert.throws(launchctl);
});
launchdTest("a failed launchd restart restores the previous job definition", (t) => {
  const { root, run, job, plist } = launchdFixture(t, "2.8.0");
  const before = fs.readFileSync(plist);
  fs.writeFileSync(
    path.join(root, "tools/launchctl"),
    `#!/bin/sh\ncase "$1" in print) [ ! -f ${quote(path.join(root, "out"))} ] ;; bootout) : > ${quote(path.join(root, "out"))} ;; bootstrap) exit 5 ;; esac\n`,
    { mode: 0o755 },
  );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(plist), before);
  assert.equal(job().ProgramArguments.length, 4);
  assert.match(
    result.stdout,
    /Could not restart launchd job com\.tmux-ide\.daemon; restored its previous definition/,
  );
});

/** Runs the installer's own fetch() through real curl, with the stall window shortened. */
function realFetch(url, out) {
  const line = fs
    .readFileSync(installer, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("fetch() {"));
  assert.match(line, /--speed-limit 1 --speed-time 30 --max-time 900/);
  const shortened = line
    .replace("--retry 3 --retry-max-time 900 ", "")
    .replace("--speed-time 30", "--speed-time 1");
  return new Promise((resolve) => {
    spawn("/bin/sh", ["-c", `${shortened}\nfetch "$1" "$2"`, "sh", url, out], {
      stdio: "ignore",
    }).on("exit", resolve);
  });
}

async function chunkServer(t, respond) {
  const server = http.createServer(respond);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/asset`;
}

test("fetch keeps a slow transfer that outlasts the stall window", async (t) => {
  const url = await chunkServer(t, (_request, response) => {
    let sent = 0;
    const timer = setInterval(() => {
      response.write("x".repeat(64));
      sent += 1;
      if (sent === 25) {
        clearInterval(timer);
        response.end();
      }
    }, 100);
  });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-fetch-")), "asset");
  assert.equal(await realFetch(url, out), 0);
  assert.equal(fs.statSync(out).size, 25 * 64);
});

test("fetch gives up on a transfer that stops sending", async (t) => {
  const url = await chunkServer(t, (_request, response) => {
    response.writeHead(200, { "content-length": "1000" });
    response.write("x".repeat(64));
  });
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-fetch-")), "asset");
  assert.equal(await realFetch(url, out), 28);
});
