import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  renameSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixturePath,
  decodeMacProcessWitness,
  createMacProcessIdentity,
  confirmMacProcessExit,
  KernelWitnessReadError,
  sshDiagnosticSink,
  encodeFixtureHandshake,
  createFixtureHandshakeWork,
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
  assert.throws(() => socketPath("/tmp/" + "x".repeat(82), 17));
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

test("root title-change diagnostics expose booleans without command contents", async () => {
  let reads = 0;
  const prefix = "Thu Sep 17 12:34:56 2026";
  const tracker = ownedProcesses({
    identify: async () => `${prefix} ${++reads === 1 ? "SECRET-original" : "SECRET-title"}`,
    list: async () => [],
  });
  const child = tracker.retain(fake(45));
  await assert.rejects(tracker.capture());
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.diagnostics, [
    {
      stage: "root-verification-changed",
      pid: 45,
      sameStartPrefix: true,
      commandTailChanged: true,
    },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  await assert.rejects(tracker.dispose());
  assert.deepEqual(child.signals, ["SIGTERM"]);
});
test("root identity read diagnostic preserves cleanup without raw exception text", async () => {
  const tracker = ownedProcesses({
    identify: async () => {
      throw Error("SECRET-cause");
    },
    list: async () => [],
  });
  tracker.retain(fake(46));
  await assert.rejects(tracker.dispose());
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.diagnostics, [{ stage: "root-identity-read-refused", pid: 46 }]);
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  assert.deepEqual(snapshot.retainedRoots, [{ pid: 46, closed: true }]);
});

test("kernel witness validates exact shape, UID and birth identity", () => {
  const value = { pid: 123, uid: 501, seconds: 1700000000, microseconds: 123456 };
  const first = decodeMacProcessWitness(value, 123, 501);
  assert.equal(decodeMacProcessWitness(null, 123, 501), null);
  assert.notEqual(decodeMacProcessWitness({ ...value, microseconds: 123457 }, 123, 501), first);
  for (const bad of [
    false,
    {},
    { ...value, uid: 502 },
    { ...value, pid: 124 },
    { ...value, microseconds: 1000000 },
    { ...value, command: "SECRET" },
  ])
    assert.throws(() => decodeMacProcessWitness(bad, 123, 501));
});
test(
  "native kernel adapter keeps own child birth stable across title changes and confirms exit",
  { skip: process.platform !== "darwin" || process.getuid() === 0 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "ssh-kernel-"));
    let allocation, child, proof;
    try {
      const adapter = await createMacProcessIdentity({
        parent: root,
        onAllocated: (value) => {
          allocation = value;
        },
      });
      child = spawn(
        process.execPath,
        [
          "-e",
          "process.title='d11-original';process.stdout.write('ready');process.stdin.once('data',()=>{process.title='d11-changed';process.stdout.write('changed');});setInterval(()=>{},1000);",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      proof = {
        sourceHash: adapter.sourceHash,
        artifactHash: adapter.artifactHash,
        artifactBytes: adapter.artifactBytes,
      };
      assert.ok(adapter.artifactBytes <= 262144);
      const closed = once(child, "close", { signal: AbortSignal.timeout(2000) });
      await once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
      const before = await adapter.identify(child.pid);
      assert.match(before, /^darwin-kernel:/);
      const changed = once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
      child.stdin.write("change");
      await changed;
      assert.equal(await adapter.identify(child.pid), before);
      child.kill("SIGTERM");
      await closed;
      assert.equal(await adapter.identify(child.pid), null);
      proof.birthStable = true;
      proof.childGone = true;
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close", { signal: AbortSignal.timeout(2000) });
        child.kill("SIGKILL");
        await closed;
      }
      if (allocation) await allocation.disposeFiles();
      rmSync(root, { recursive: true, force: true });
    }
    t.diagnostic(JSON.stringify({ ...proof, cleanup: true }));
  },
);

test("SSH classifier bounds input and only exposes fixed categories across chunks", () => {
  const stream = new PassThrough();
  const inspect = sshDiagnosticSink(stream);
  stream.write("SECRET Authentication refused: bad owner");
  stream.write("ship or modes for directory SECRET");
  stream.write(Buffer.alloc(70000, 120));
  stream.end();
  const result = inspect();
  assert.ok(result.categories.includes("bad-ownership"));
  assert.ok(result.categories.includes("authentication-refused"));
  assert.equal(result.bytes, 65536);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("kernel read refusal permits only one bounded confirmed-dead result", async () => {
  const error = new KernelWitnessReadError(65);
  let calls = 0;
  const options = { wait: async () => {}, now: () => 0 };
  assert.equal(
    await confirmMacProcessExit(async () => {
      if (++calls === 1) throw error;
      return null;
    }, options),
    null,
  );
  assert.equal(calls, 2);
  for (const after of ["same-live", "reused", new KernelWitnessReadError(65)]) {
    calls = 0;
    await assert.rejects(
      confirmMacProcessExit(async () => {
        if (++calls === 1) throw error;
        if (after instanceof Error) throw after;
        return after;
      }, options),
      (e) => e === error,
    );
    assert.equal(calls, 2);
  }
  calls = 0;
  await assert.rejects(
    confirmMacProcessExit(async () => {
      calls++;
      throw new KernelWitnessReadError(66);
    }, options),
  );
  assert.equal(calls, 1);
  let now = 0;
  calls = 0;
  await assert.rejects(
    confirmMacProcessExit(
      async () => {
        calls++;
        now = 990;
        throw error;
      },
      {
        now: () => now,
        wait: async () => {
          throw Error("must not wait");
        },
      },
    ),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});

test("async fixture handshake is awaited, bounded and never silently publishes a promise", async () => {
  assert.equal(await encodeFixtureHandshake(async () => ({ version: 1 })), '{"version":1}');
  await assert.rejects(encodeFixtureHandshake(() => new Promise(() => {}), "normal", 10));
  await assert.rejects(encodeFixtureHandshake(async () => "x".repeat(65537)));
});
test("response timeout does not qualify producer cleanup; later settlement permits retry", async () => {
  let finish;
  const work = createFixtureHandshakeWork(() => new Promise((resolve) => (finish = resolve)));
  await assert.rejects(work.encode("normal", 10));
  await assert.rejects(work.settle(10));
  finish({ version: 1 });
  await work.settle(100);
  await assert.rejects(work.encode());
});
test("closing handshake admission fences work queued before its producer starts", async () => {
  for (const admitted of [false, true]) {
    let calls = 0;
    const work = createFixtureHandshakeWork(() => {
      calls++;
      return { version: 1 };
    });
    const response = work.encode();
    if (admitted) await Promise.resolve();
    work.close();
    await assert.rejects(response);
    await work.settle(100);
    assert.equal(calls, 0);
  }
});
test("producer rejection settles cleanup while another unfinished producer remains protected", async () => {
  let rejectFirst, finishSecond;
  let calls = 0;
  const work = createFixtureHandshakeWork(
    () =>
      new Promise((resolve, reject) => {
        if (++calls === 1) rejectFirst = reject;
        else finishSecond = resolve;
      }),
  );
  await Promise.all([
    assert.rejects(work.encode("normal", 10)),
    assert.rejects(work.encode("normal", 10)),
  ]);
  rejectFirst(new Error("fixture private failure must not be reported"));
  await assert.rejects(work.settle(10));
  finishSecond({ version: 1 });
  await work.settle(100);
});
test("configuration refresh witness refuses modified private config before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-refresh-"));
  try {
    const files = privateFiles(root);
    writeFileSync(join(root, "sshd_config"), "owned", { mode: 0o600 });
    files.capture("sshd_config");
    files.verify("sshd_config");
    writeFileSync(join(root, "sshd_config"), "changed");
    assert.throws(() => files.verify("sshd_config"));
    assert.equal(existsSync(join(root, "sshd_config")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private refresh verification refuses a relocated root even if file inode survives", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-root-"));
  const relocated = root + "-moved";
  const files = privateFiles(root);
  writeFileSync(join(root, "config"), "owned", { mode: 0o600 });
  files.capture("config");
  renameSync(root, relocated);
  symlinkSync(relocated, root);
  try {
    assert.throws(() => files.verify("config"));
  } finally {
    unlinkSync(root);
    rmSync(relocated, { recursive: true });
  }
});
