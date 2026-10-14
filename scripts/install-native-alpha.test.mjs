import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const source = readFileSync(resolve("docs/public/install-native-alpha.sh"), "utf8");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-alpha-bootstrap-"));
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
    source
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
  return { run, receipt, downloads, temp, home, node };
}

test("pins the reviewed alpha assets and requires HTTPS redirects", () => {
  assert.match(
    source,
    /installer_sha=17cf01adb3d2d46f2b8f9d56c603d4942974b3ec097edd022b621cbb0c0c21c1/,
  );
  assert.match(
    source,
    /archive_sha=c676bdec31f0cebf748e58e0538e3de0944eca825020a830f1eac15af64c2710/,
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
      assert.equal(receipt.args[receipt.args.indexOf("--version") + 1], "0.1.0-2026101406");
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
