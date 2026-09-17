import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixturePath,
  socketPath,
  serverConfiguration,
  clientConfiguration,
  verifyEffectiveServer,
  ownedProcesses,
  privateFiles,
} from "./owned-ssh-fixture.mjs";
const spec = {
  root: "/private/tmp/ssh-fixture",
  node: "/usr/local/bin/node",
  account: "tester",
  port: 2222,
  targetPort: 3000,
};
function effective() {
  return serverConfiguration(spec)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      const key = line.slice(0, i).toLowerCase();
      let value = line.slice(i + 1);
      if (key === "listenaddress") value += ":2222";
      if (key !== "forcecommand") value = value.replaceAll('"', "");
      return key + " " + value;
    })
    .join("\n");
}
test("rejects shell expansion, token paths and overlong canonical sockets before allocation", () => {
  for (const p of [
    "/tmp/a b",
    "/tmp/$HOME",
    "/tmp/`id`",
    "/tmp/a%h",
    "/tmp/a\\b",
    "/tmp/a/../b",
    "relative",
  ])
    assert.throws(() => fixturePath(p));
  assert.equal(fixturePath("/private/tmp/safe-root"), "/private/tmp/safe-root");
  assert.throws(() => socketPath("/tmp/" + "x".repeat(100)));
  assert.throws(() => serverConfiguration({ ...spec, node: "/tmp/$(id)" }));
});
test("effective pre-exec policy requires exact private environment without duplicate aliases", () => {
  assert.equal(verifyEffectiveServer(effective(), spec).privateEnvironment, true);
  for (const replacement of [
    "HOME=/private/tmp/ssh-fixture/home-other",
    "HOME=/private/tmp/ssh-fixture/home HOME=/tmp/foreign",
    "HOME=/tmp/foreign",
    "HOME=/private/tmp/ssh-fixture/home LD_PRELOAD=/tmp/a",
  ])
    assert.throws(() =>
      verifyEffectiveServer(
        effective().replace("HOME=/private/tmp/ssh-fixture/home", replacement),
        spec,
      ),
    );
  for (const field of [
    "permituserrc no",
    "passwordauthentication no",
    "allowstreamlocalforwarding no",
    "allowtcpforwarding local",
  ])
    assert.throws(() =>
      verifyEffectiveServer(effective().replace(field, field.replace(/\S+$/, "yes")), spec),
    );
  assert.throws(() => verifyEffectiveServer(effective() + "\nhostkey /tmp/foreign", spec));
});
test("private client config retains host defaults and constrains explicit jump alias", () => {
  const cfg = clientConfiguration({ ...spec, jump: "jump" });
  assert.match(cfg, /ProxyJump jump/);
  assert.match(cfg, /ControlMaster auto/);
  assert.match(cfg, /GlobalKnownHostsFile \/dev\/null/);
  assert.throws(() => clientConfiguration({ ...spec, jump: "x\nHost *" }));
  assert.doesNotMatch(clientConfiguration({ ...spec, defaults: false }), /Host \*/);
  assert.match(
    clientConfiguration({ ...spec, sharing: false }),
    /ControlMaster no\n ControlPath none/,
  );
});
function fake(pid, close = true) {
  const child = new EventEmitter();
  child.pid = pid;
  child.signals = [];
  child.kill = (s) => {
    child.signals.push(s);
    if (close) queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  return child;
}
test("capture failure still retires each retained child and reports refusal", async () => {
  const tracker = ownedProcesses({
    identify: async () => {
      throw Error("unknown");
    },
    list: async () => [],
  });
  const a = tracker.retain(fake(10)),
    b = tracker.retain(fake(11));
  await assert.rejects(tracker.dispose());
  assert.deepEqual(a.signals, ["SIGTERM"]);
  assert.deepEqual(b.signals, ["SIGTERM"]);
});
test("exact ancestry captures proxy child, excludes sibling, and never signals reused child", async () => {
  let replaced = false;
  const signals = [];
  const tracker = ownedProcesses({
    identify: async (pid) => (pid === 11 && replaced ? "new" : String(pid)),
    list: async () => [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 1 },
    ],
    signal: (pid, s) => signals.push([pid, s]),
  });
  const root = tracker.retain(fake(10));
  await tracker.capture();
  replaced = true;
  await assert.rejects(tracker.dispose());
  assert.deepEqual(root.signals, ["SIGTERM"]);
  assert.deepEqual(signals, []);
});
test("normal retained handle closes; spawn error alone is not successful cleanup", async () => {
  const tracker = ownedProcesses({ identify: async () => null, list: async () => [] });
  const child = tracker.retain(fake(undefined));
  child.emit("error", Error("synthetic"));
  const result = await tracker.dispose();
  assert.equal(result.closed, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});
test("private cleanup protects unknown and replaced files and parent symlink traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-test-"));
  try {
    const files = privateFiles(root);
    writeFileSync(join(root, "known"), "original", { mode: 0o600 });
    files.capture("known");
    writeFileSync(join(root, "extra"), "secret", { mode: 0o600 });
    assert.throws(() => files.clean());
    assert.ok(existsSync(join(root, "known")));
    rmSync(join(root, "extra"));
    writeFileSync(join(root, "known"), "changed");
    assert.throws(() => files.clean());
    assert.throws(() => files.capture("../outside"));
    mkdirSync(join(root, "dir"), { mode: 0o700 });
    files.capture("dir");
    rmSync(join(root, "dir"), { recursive: true });
    symlinkSync(tmpdir(), join(root, "dir"));
    assert.throws(() => files.capture("dir/anything"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("private cleanup removes only unchanged captured files", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-test-"));
  const files = privateFiles(root);
  writeFileSync(join(root, "known"), "owned", { mode: 0o600 });
  files.capture("known");
  files.clean();
  assert.equal(existsSync(root), false);
});

test("one root signal failure does not prevent another retained child cleanup", async () => {
  const tracker = ownedProcesses({ identify: async () => null, list: async () => [] });
  const broken = tracker.retain(fake(21));
  broken.kill = () => {
    queueMicrotask(() => broken.emit("close", 1));
    throw Error("synthetic");
  };
  const other = tracker.retain(fake(22));
  await assert.rejects(tracker.dispose());
  assert.deepEqual(other.signals, ["SIGTERM"]);
});
test("retained child that ignores TERM is reaped after bounded KILL escalation", async () => {
  const tracker = ownedProcesses({ identify: async () => null, list: async () => [] });
  const child = tracker.retain(fake(30, false));
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
    return true;
  };
  assert.equal((await tracker.dispose()).closed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
test("file witness rejects oversized owned contents before hashing", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-test-"));
  try {
    const files = privateFiles(root);
    writeFileSync(join(root, "large"), Buffer.alloc(262145), { mode: 0o600 });
    assert.throws(() => files.capture("large"));
    assert.ok(existsSync(join(root, "large")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
