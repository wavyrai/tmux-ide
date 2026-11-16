// Runs the apt DNS fallback action's script the way the runner does
// (bash -e -o pipefail) against stand-ins for getent, ip, resolvectl and sudo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repo = new URL("../../", import.meta.url);
const action = fs.readFileSync(
  new URL(".github/actions/apt-dns-fallback/action.yml", repo),
  "utf8",
);
function runBlock(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s+run: \|$/.test(line));
  assert.ok(start >= 0, "the action has one run block");
  const indent = lines[start + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}
const script = runBlock(action);
const AZURE = "azure.archive.ubuntu.com";
const PLAIN = "archive.ubuntu.com";

function runner(t, { resolves, afterFallback = [AZURE, PLAIN], without = [], failing = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apt-dns-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  // Only the stand-ins and the few real tools the script needs are on PATH.
  for (const tool of ["awk", "sed", "cat", "grep"]) {
    const real = ["/usr/bin", "/bin"].map((dir) => path.join(dir, tool)).find(fs.existsSync);
    fs.symlinkSync(real, path.join(bin, tool));
  }
  const state = path.join(root, "resolvable");
  const log = path.join(root, "log");
  fs.writeFileSync(state, resolves.join("\n") + "\n");
  fs.writeFileSync(log, "");
  const stand = (name, body) => {
    if (without.includes(name)) return;
    const fail = failing.includes(name) ? `echo "${name}: failed" >&2; exit 1\n` : "";
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${fail}${body}\n`, { mode: 0o755 });
  };
  stand("timeout", 'shift; exec "$@"');
  stand("sudo", 'exec "$@"');
  stand("getent", `echo "getent $*" >> '${log}'; grep -qx "$2" '${state}' && echo "192.0.2.1 $2"`);
  stand("ip", 'echo "default via 10.1.0.1 dev eth0 proto dhcp src 10.1.0.4 metric 100"');
  stand(
    "resolvectl",
    `echo "resolvectl $*" >> '${log}'
case "$1 $#" in
  "dns 2") echo "Link 2 ($2): 168.63.129.16" ;;
  dns*) printf '%s\\n' ${afterFallback.map((host) => `'${host}'`).join(" ")} > '${state}' ;;
esac`,
  );
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      env: { PATH: bin },
      encoding: "utf8",
    },
  );
  return { ...result, log: fs.readFileSync(log, "utf8") };
}
const changedDns = (log) => /^resolvectl dns eth0 1\.1\.1\.1 8\.8\.8\.8/m.test(log);

test("does nothing when the runner resolves every host apt uses", (t) => {
  const result = runner(t, { resolves: [AZURE, PLAIN] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!changedDns(result.log));
  assert.match(result.log, new RegExp(`getent hosts ${AZURE.replaceAll(".", "\\.")}`));
});

// #821 item 1: the runners' mirror list puts azure.archive.ubuntu.com first.
test("falls back when only the Azure mirror fails to resolve", (t) => {
  const result = runner(t, { resolves: [PLAIN] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /^resolvectl dns eth0 1\.1\.1\.1 8\.8\.8\.8 168\.63\.129\.16$/m);
  assert.match(result.log, /^resolvectl flush-caches$/m);
  assert.match(result.stdout, /::warning::.*azure\.archive\.ubuntu\.com/);
});

test("falls back when only archive.ubuntu.com fails to resolve", (t) => {
  const result = runner(t, { resolves: [AZURE] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(changedDns(result.log));
});

// #821 item 2: a failing lookup must reach the warning, not end the step.
for (const tool of ["ip", "resolvectl"])
  test(`warns and leaves DNS alone when ${tool} fails`, (t) => {
    const result = runner(t, { resolves: [], failing: [tool] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::/);
    assert.ok(!changedDns(result.log));
  });

for (const tool of ["ip", "resolvectl"])
  test(`warns and leaves DNS alone when ${tool} is missing`, (t) => {
    const result = runner(t, { resolves: [], without: [tool] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::/);
    assert.ok(!changedDns(result.log));
  });

test("fails with an error when a host still does not resolve after the fallback", (t) => {
  const result = runner(t, { resolves: [], afterFallback: [PLAIN] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::.*azure\.archive\.ubuntu\.com/);
});

// #821 item 3.
test("the action says what the fallback costs: Azure-internal names", () => {
  assert.match(action, /internal\.cloudapp\.net/);
});

// #821 item 4: a workflow that asks to run when an action it uses is edited
// (it lists setup-tmux in its path filter) must also list the action that
// setup-tmux runs. A workflow with a narrower filter of its own choosing, such
// as the release journey soak, is left alone.
test("a workflow triggered by edits to setup-tmux is also triggered by edits to the fallback", () => {
  const dir = new URL(".github/workflows/", repo);
  const setupTmux = fs.readFileSync(new URL(".github/actions/setup-tmux/action.yml", repo), "utf8");
  assert.match(setupTmux, /\.github\/actions\/apt-dns-fallback/, "setup-tmux uses the action");
  const listing = [];
  for (const name of fs.readdirSync(dir)) {
    const workflow = fs.readFileSync(new URL(name, dir), "utf8");
    if (!/^ {6}- \.github\/actions\/setup-tmux\/\*\*$/m.test(workflow)) continue;
    listing.push(name);
    assert.match(workflow, /^ {6}- \.github\/actions\/apt-dns-fallback\/\*\*$/m, name);
  }
  assert.ok(listing.includes("gpui-preview.yml"), "the rule still has a workflow to check");
});

// #821 item 5.
test("the contributing guide names the error an older branch gets, and the cure", () => {
  const guide = fs.readFileSync(new URL("CONTRIBUTING.md", repo), "utf8");
  assert.match(guide, /Can't find 'action\.yml'/);
  assert.match(guide, /merge `main`/i);
});
