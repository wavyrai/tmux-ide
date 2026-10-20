import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const source = readFileSync(resolve("docs/public/install-native-alpha.sh"), "utf8");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const maintenanceSource = readFileSync(
  resolve("scripts/install-native-alpha-maintenance.sh"),
  "utf8",
);
function fixture(t, backend, bootstrap = source) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-alpha-bootstrap-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home with spaces");
  const bin = join(root, "bin");
  const temp = join(root, "temp");
  const node = join(home, ".local/share/tmux-ide/current/node/bin");
  for (const dir of [home, bin, temp, node]) mkdirSync(dir, { recursive: true });
  const script = (path, body) =>
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
  script(
    join(bin, "uname"),
    'case "$1" in -s) echo "${TEST_OS:-Darwin}" ;; -m) echo "${TEST_ARCH:-arm64}" ;; esac',
  );
  script(join(bin, "sw_vers"), 'echo "${TEST_VERSION:-14.2}"');
  script(
    join(node, "node"),
    `if [ "$1" = --version ]; then echo v24.1.0; exit; fi\nexec ${quote(process.execPath)} "$@"`,
  );
  const installer = join(root, "installer.mjs");
  writeFileSync(
    installer,
    backend ??
      `import fs from 'node:fs';
const args=process.argv.slice(2);const at=args.indexOf('--policy');
fs.writeFileSync(process.env.TEST_RECEIPT,JSON.stringify({args,policy:at<0?null:JSON.parse(fs.readFileSync(args[at+1],'utf8'))}));
process.exit(Number(process.env.TEST_INSTALL_EXIT||0));`,
  );
  mkdirSync(join(root, "TmuxIDE.app"));
  writeFileSync(join(root, "TmuxIDE.app", "marker"), "owned inert fixture");
  const archive = join(root, "archive.tar.gz");
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", archive, "-C", root, "TmuxIDE.app"]).status, 0);
  script(
    join(bin, "curl"),
    `printf '%s\\n' "$*" >> "$TEST_DOWNLOADS"
[ -z "\${TEST_NETWORK_FAIL:-}" ] || exit 22
out=''; url=''; while [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1 ;; -o) shift; out=$1 ;; esac; shift; done
case "$url" in *.mjs) cp ${quote(installer)} "$out" ;; *.tar.gz) cp ${quote(archive)} "$out" ;; *) exit 99 ;; esac
[ -z "\${TEST_CORRUPT:-}" ] || printf bad >> "$out"
case "$url" in *.tar.gz) [ -z "\${TEST_CORRUPT_ARCHIVE:-}" ] || printf bad >> "$out" ;; esac`,
  );
  // Substitute only fixture hashes in a PRIVATE copy: real shasum and tar run.
  const entry = join(root, "bootstrap.sh");
  writeFileSync(
    entry,
    bootstrap
      .replace(/installer_sha=[a-f0-9]{64}/, `installer_sha=${hash(installer)}`)
      .replace(/archive_sha=[a-f0-9]{64}/, `archive_sha=${hash(archive)}`),
  );
  const receipt = join(root, "receipt.json");
  const downloads = join(root, "downloads");
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: temp,
    PATH: `${bin}:/usr/bin:/bin`,
    TEST_RECEIPT: receipt,
    TEST_DOWNLOADS: downloads,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const run = (args = [], extra = {}) =>
    spawnSync("/bin/sh", [entry, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 15000,
    });
  return { run, receipt, downloads, temp, home, node, root };
}

test("pins the reviewed alpha assets and requires HTTPS redirects", () => {
  assert.match(
    source,
    /installer_sha=2f0072b5d843cfdc5328645350dc6d80c668615936155a71555735d5904bf5f4/,
  );
  assert.match(
    source,
    /archive_sha=a2fa54c380bad79b1864afffde99c7a397af08bffba439a7af5764c70c5cc5df/,
  );
  assert.match(source, /--proto '=https' --proto-redir '=https'/);
});
for (const action of [[], ["--update"], ["--rollback"], ["--uninstall"]]) {
  test(`delegates ${action[0] || "install"} to exact installer and cleans staging`, (t) => {
    const f = fixture(t);
    const result = f.run(action);
    assert.equal(result.status, 0, result.stderr);
    if (!action.length || action[0] === "--update") {
      assert.ok(
        result.stdout.includes(
          join(f.home, "Library/Application Support/tmux-ide/native-alpha/TmuxIDE.app"),
        ),
      );
      assert.match(result.stdout, /run this separately/);
      assert.match(result.stdout, /update --daemon --json/);
    }
    if (action[0] === "--uninstall") assert.match(result.stdout, /detached.*retained/);

    const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
    assert.equal(receipt.args[0], action[0]?.slice(2) || "install");
    if (!action.length || action[0] === "--update")
      assert.equal(receipt.args[receipt.args.indexOf("--version") + 1], "0.1.4-2026102001");
    assert.equal(
      receipt.args[2],
      join(f.home, "Library/Application Support/tmux-ide/native-alpha"),
    );
    if (action[0] !== "--uninstall")
      assert.deepEqual(receipt.policy, {
        teamId: "7HWMF997US",
        bundleId: "com.tmux-ide.gpui.alpha",
        architecture: "arm64",
        minimumMacOS: "14.2",
      });
    assert.equal(
      readFileSync(f.downloads, "utf8").trim().split("\n").length,
      action[0] === "--rollback" || action[0] === "--uninstall" ? 1 : 2,
    );
    assert.deepEqual(readdirSync(f.temp), []);
  });
}
test("rejects platform, old OS and missing managed Node before downloading", (t) => {
  const f = fixture(t);
  for (const extra of [{ TEST_OS: "Linux" }, { TEST_ARCH: "x86_64" }, { TEST_VERSION: "14.1" }])
    assert.notEqual(f.run([], extra).status, 0);
  rmSync(f.node, { recursive: true });
  const missing = f.run();
  assert.match(missing.stderr, /First run the universal installer/);
  assert.throws(() => readFileSync(f.downloads));
});
test("checksum/network/verifier failures propagate and remove staging", (t) => {
  const f = fixture(t);
  for (const extra of [
    { TEST_CORRUPT: "1" },
    { TEST_CORRUPT_ARCHIVE: "1" },
    { TEST_NETWORK_FAIL: "1" },
    { TEST_INSTALL_EXIT: "9" },
  ]) {
    const result = f.run([], extra);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(f.temp), []);
  }
});

function entry(f) {
  return join(f.home, "Applications/Tmux IDE Alpha.app");
}
function target(f) {
  return join(f.home, "Library/Application Support/tmux-ide/native-alpha/TmuxIDE.app");
}
test("install update and rollback retain one exact Applications link", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--update"], ["--rollback"]]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readlinkSync(entry(f)), target(f));
  }
});
for (const kind of ["file", "directory", "foreign-link"]) {
  test(`refuses foreign Applications ${kind} before installer mutation`, (t) => {
    const f = fixture(t);
    mkdirSync(join(f.home, "Applications"));
    if (kind === "file") writeFileSync(entry(f), "foreign");
    else if (kind === "directory") mkdirSync(entry(f));
    else symlinkSync("/foreign/app", entry(f));
    for (const args of [[], ["--update"], ["--rollback"], ["--uninstall"]]) {
      assert.notEqual(f.run(args).status, 0);
      assert.ok(!existsSync(f.receipt));
      assert.ok(!existsSync(f.downloads));
      assert.ok(lstatSync(entry(f)));
    }
    if (kind === "foreign-link") assert.equal(readlinkSync(entry(f)), "/foreign/app");
    if (kind === "file") assert.equal(readFileSync(entry(f), "utf8"), "foreign");
  });
}
test("uninstall removes only owned link and preserves managed version files", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const marker = join(
    f.home,
    "Library/Application Support/tmux-ide/native-alpha/versions/retained",
  );
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "retained");
  assert.equal(f.run(["--uninstall"]).status, 0);
  assert.throws(() => lstatSync(entry(f)), { code: "ENOENT" });
  assert.equal(readFileSync(marker, "utf8"), "retained");
});
test("failed installer does not create Applications entry; custom prefix cannot claim another installation", (t) => {
  const f = fixture(t);
  assert.notEqual(f.run([], { TEST_INSTALL_EXIT: "9" }).status, 0);
  assert.throws(() => lstatSync(entry(f)), { code: "ENOENT" });
  assert.equal(f.run().status, 0);
  assert.notEqual(f.run(["--prefix", join(f.home, "another installation")]).status, 0);
  assert.equal(readlinkSync(entry(f)), target(f));
});
test("redirected Applications directory is refused without touching its destination", (t) => {
  const f = fixture(t);
  const elsewhere = join(f.home, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(f.home, "Applications"));
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.ok(!existsSync(f.downloads));
});
test("explicit recovery delegates keep-current only without downloading an app or claiming installation", (t) => {
  const f = fixture(t, undefined, maintenanceSource);
  const result = f.run(["--recover"]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
  assert.deepEqual(
    receipt.args.filter((x) => x === "recover" || x === "keep-current"),
    ["recover", "keep-current"],
  );
  assert.ok(receipt.args.includes("--disposition"));
  assert.equal(readFileSync(f.downloads, "utf8").trim().split("\n").length, 1);
  assert.ok(!existsSync(entry(f)));
  assert.match(result.stdout, /No installed native app remains/);
  assert.deepEqual(readdirSync(f.temp), []);
});
test("recovery retains an existing app link and propagates refusal without changing it", (t) => {
  const f = fixture(t, undefined, maintenanceSource);
  mkdirSync(target(f), { recursive: true });
  const first = f.run(["--recover"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readlinkSync(entry(f)), target(f));
  assert.match(first.stdout, /current verified native app/);
  const refused = f.run(["--recover"], { TEST_INSTALL_EXIT: "9" });
  assert.notEqual(refused.status, 0);
  assert.equal(readlinkSync(entry(f)), target(f));
});

// Synthetic app/verifier seam exercises the real journal owner through the shell;
// this is not Apple signature/notarization qualification.
for (const [phase, previous, expected] of [
  ["candidate-renamed", true, "1"],
  ["current-switched", true, "2"],
  ["candidate-renamed", false, null],
]) {
  test(
    `shell recovery after owned SIGKILL ${phase}, previous=${previous}`,
    { timeout: 15000 },
    async (t) => {
      const cliUrl = new URL("../apps/tmux-gpui/scripts/install-cli.mjs", import.meta.url).href;
      const ownerUrl = new URL("../apps/tmux-gpui/scripts/install-transaction.mjs", import.meta.url)
        .href;
      const f = fixture(
        t,
        `import fs from 'node:fs';
import {main} from ${JSON.stringify(cliUrl)};
const result=await main(process.argv.slice(2), {platform:'darwin',verify:async()=>true});
fs.writeFileSync(process.env.TEST_RECEIPT,JSON.stringify(result));
console.log(JSON.stringify(result.output));process.exitCode=result.exitCode;`,
        maintenanceSource,
      );
      const installRoot = join(f.home, "Library/Application Support/tmux-ide/native-alpha");
      mkdirSync(join(f.home, "Library/Application Support/tmux-ide"), { recursive: true });
      const stagedApp = join(f.root, "Stage.app");
      mkdirSync(stagedApp);
      writeFileSync(join(stagedApp, "payload"), "old");
      const { installApp } = await import(ownerUrl);
      if (previous)
        await installApp({ installRoot, stagedApp, version: "1", verify: async () => true });
      writeFileSync(join(stagedApp, "payload"), "new");
      const sentinel = join(f.home, "settings-sentinel");
      writeFileSync(sentinel, "unchanged");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import {installApp} from ${JSON.stringify(ownerUrl)};
await installApp({installRoot:${JSON.stringify(installRoot)},stagedApp:${JSON.stringify(stagedApp)},version:'2',verify:async()=>true,onBoundary:async phase=>{
if(phase===${JSON.stringify(phase)})await new Promise(()=>{setInterval(()=>{},1000);process.stdout.write('READY\\n');});}});`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const closed = new Promise((resolve) =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("boundary timeout")), 5000);
        child.stdout.once("data", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", reject);
      });
      // An alive transaction owner must be refused without deleting its lock.
      const lock = join(installRoot, ".transaction-lock");
      if (!previous) {
        mkdirSync(join(f.home, "Applications"));
        symlinkSync(target(f), entry(f));
      }
      const beforeLock = readdirSync(lock).sort();
      const refused = f.run(["--recover"]);
      assert.notEqual(refused.status, 0);
      assert.deepEqual(readdirSync(lock).sort(), beforeLock);
      if (!previous) assert.equal(readlinkSync(entry(f)), target(f));
      child.kill("SIGKILL");
      assert.deepEqual(await closed, { code: null, signal: "SIGKILL" });
      const result = f.run(["--recover"]);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      assert.equal(receipt.output.result.version, expected);
      assert.equal(existsSync(lock), false);
      assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
      assert.equal(readFileSync(f.downloads, "utf8").trim().split("\n").length, 2);
      if (expected) {
        assert.equal(
          readlinkSync(join(installRoot, "current")),
          `versions/${expected}/TmuxIDE.app`,
        );
        assert.equal(readlinkSync(entry(f)), target(f));
        assert.equal(
          readFileSync(join(target(f), "payload"), "utf8"),
          expected === "1" ? "old" : "new",
        );
      } else {
        assert.equal(receipt.output.result.launchPath, null);
        assert.throws(() => lstatSync(entry(f)), { code: "ENOENT" });
        assert.match(result.stdout, /No installed native app remains/);
      }
    },
  );
}
