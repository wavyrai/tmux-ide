import { execFileSync } from "node:child_process";
import { privatePackedInstallEnvironment } from "./packed-install-environment.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchdDefinition,
  inspectLaunchdResult,
  ownedLaunchdJob,
  publishLaunchdEntry,
  privateRootReferences,
  verifyLaunchdDaemonIdentity,
} from "./owned-launchd-fixture.mjs";
const absent = { code: 113, stdout: "", stderr: "Could not find service" };
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "launchd-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const definition = launchdDefinition({
    root,
    node: "/private/node",
    entry: join(root, "stable.mjs"),
    env: { HOME: root, ZDOTDIR: root },
    uid: 501,
    nonce: "00000000-0000-0000-0000-000000000000",
  });
  const active = (pid = 123) => ({
    code: 0,
    stderr: "",
    stdout: `${definition.target} = {\n path = ${definition.path}\n program = ${definition.node}\n arguments = {\n${definition.args.map((a) => `  ${a}`).join("\n")}\n }\n pid = ${pid}\n}\n`,
  });
  return { root, definition, active };
}
test("exact private job plist uses explicit foreground argv and private environment", (t) => {
  const { definition } = setup(t);
  assert.deepEqual(definition.args.slice(2), ["--headless", "--json"]);
  assert.match(definition.plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(definition.target, /^user\/501\/org\.tmux-ide\.qualification\./);
  assert.match(definition.plist, /<key>ZDOTDIR<\/key>/);
});
test("job observation refuses changed definition, duplicate PID and ambiguous errors", (t) => {
  const { definition, active } = setup(t);
  assert.equal(inspectLaunchdResult(active(), definition).pid, 123);
  assert.equal(inspectLaunchdResult(absent, definition), null);
  for (const text of [
    active().stdout.replace("/private/node", "/other/node"),
    active().stdout + " pid = 456\n",
    active().stdout.replace(definition.path, "/other.plist"),
  ])
    assert.throws(() => inspectLaunchdResult({ ...active(), stdout: text }, definition));
  assert.throws(() =>
    inspectLaunchdResult({ code: 1, stdout: "", stderr: "permission denied" }, definition),
  );
});
test("existing exact label refuses before writing or bootstrapping", async (t) => {
  const { definition, active } = setup(t);
  const calls = [];
  const job = ownedLaunchdJob({
    definition,
    run: async (args) => {
      calls.push(args);
      return active();
    },
  });
  await assert.rejects(job.bootstrap());
  await job.retire();
  assert.equal(existsSync(definition.path), false);
  assert.deepEqual(calls, [["print", definition.target]]);
});
test("partial bootstrap failure still retires only the exact verified job", async (t) => {
  const { definition, active } = setup(t);
  const calls = [];
  let present = false;
  const job = ownedLaunchdJob({
    definition,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "print") return present ? active() : absent;
      if (args[0] === "bootstrap") {
        present = true;
        return { code: 1 };
      }
      present = false;
      return { code: 0 };
    },
  });
  await assert.rejects(job.bootstrap());
  await job.retire();
  assert.ok(calls.some((args) => args[0] === "bootout" && args[1] === definition.target));
});
test("changed plist and job ownership refuse cleanup without bootout", async (t) => {
  const { definition, active } = setup(t);
  const calls = [];
  let present = false;
  const job = ownedLaunchdJob({
    definition,
    run: async (args) => {
      calls.push(args);
      if (args[0] === "print") return present ? active() : absent;
      present = true;
      return { code: 0 };
    },
  });
  await job.bootstrap();
  writeFileSync(definition.path, "changed");
  await assert.rejects(job.retire());
  assert.equal(
    calls.some((args) => args[0] === "bootout"),
    false,
  );
});
test("stable entry publication switches exact selected module before a caller can update", (t) => {
  const { root, definition } = setup(t);
  const before = publishLaunchdEntry(definition.args[1], join(root, "older.mjs"));
  const after = publishLaunchdEntry(definition.args[1], join(root, "current.mjs"));
  assert.notEqual(before, after);
  assert.match(readFileSync(definition.args[1], "utf8"), /current\.mjs/);
  assert.throws(() => publishLaunchdEntry(definition.args[1], "relative"));
});
test("a cancelled bootstrap preserves retirement authority", async (t) => {
  const { definition, active } = setup(t);
  let present = false;
  let bootout = false;
  const job = ownedLaunchdJob({
    definition,
    run: async ([verb]) => {
      if (verb === "print") return present ? active() : absent;
      if (verb === "bootstrap") {
        present = true;
        throw new Error("cancelled");
      }
      bootout = true;
      present = false;
      return { code: 0 };
    },
  });
  await assert.rejects(job.bootstrap());
  await job.retire();
  assert.equal(bootout, true);
});

test("private job supports deliberately empty environment values without empty keys", (t) => {
  const { root } = setup(t);
  const value = launchdDefinition({
    root,
    node: "/private/node",
    entry: join(root, "stable.mjs"),
    uid: 501,
    env: { TMUX: "", NODE_OPTIONS: "", HOME: root },
  });
  assert.match(value.plist, /<key>TMUX<\/key><string><\/string>/);
  assert.throws(() =>
    launchdDefinition({
      root,
      node: "/private/node",
      entry: join(root, "entry"),
      uid: 501,
      env: { "": "x" },
    }),
  );
});
test("root-reference inventory reports only PIDs and refuses unavailable or raw output", () => {
  assert.deepEqual(
    privateRootReferences({ code: 0, stdout: "p12\np13\np12\n", stderr: "" }),
    [12, 13],
  );
  assert.deepEqual(privateRootReferences({ code: 1, stdout: "", stderr: "" }), []);
  for (const result of [
    { code: 1, stdout: "p12", stderr: "" },
    { code: 0, stdout: "n/private/token", stderr: "" },
    { code: 0, stdout: "", stderr: "unknown" },
  ])
    assert.throws(() => privateRootReferences(result));
});

test(
  "actual private environment renders a plist accepted by native plutil",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { root } = setup(t);
    const env = privatePackedInstallEnvironment(
      { PATH: "/usr/bin:/bin" },
      { home: root, cache: join(root, "cache"), overrides: { TMUX: "", NODE_OPTIONS: "" } },
    );
    const value = launchdDefinition({
      root,
      node: "/private/node",
      entry: join(root, "stable.mjs"),
      uid: 501,
      env,
    });
    writeFileSync(value.path, value.plist, { mode: 0o600 });
    assert.match(
      execFileSync("/usr/bin/plutil", ["-lint", value.path], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 4096,
      }),
      /OK/,
    );
  },
);

test("successful bootout command is not retirement while the exact job remains", async (t) => {
  const { definition, active } = setup(t);
  let present = false,
    clock = 0,
    bootouts = 0;
  const job = ownedLaunchdJob({
    definition,
    now: () => clock,
    pause: async () => {
      clock += 30001;
    },
    run: async ([verb]) => {
      if (verb === "print") return present ? active() : absent;
      if (verb === "bootstrap") present = true;
      if (verb === "bootout") bootouts++;
      return { code: 0 };
    },
  });
  await job.bootstrap();
  await assert.rejects(job.retire());
  assert.equal(bootouts, 1);
});

test("detached owner requires successful complete public identity before admission", async () => {
  const value = {
    pid: 123,
    instanceId: "generation",
    productVersion: "version",
    protocolVersion: 1,
    startedAt: "time",
    port: 3000,
    authToken: "private",
  };
  const base = { read: () => value, identify: async () => "birth" };
  assert.equal(
    await verifyLaunchdDaemonIdentity({
      ...base,
      request: async () => {
        throw new Error("unready");
      },
    }),
    null,
  );
  for (const response of [
    { ok: false, identity: value },
    { ok: true, identity: { ...value, protocolVersion: 2 } },
    { ok: true, identity: { ...value, startedAt: "other" } },
  ])
    await assert.rejects(
      verifyLaunchdDaemonIdentity({ ...base, request: async () => response }),
      /public-identity-mismatch/,
    );
  assert.deepEqual(
    await verifyLaunchdDaemonIdentity({
      ...base,
      request: async () => ({ ok: true, identity: value }),
    }),
    { value, birth: "birth" },
  );
});
test("generation change during public request is pending rather than authority or mismatch", async () => {
  const value = {
    pid: 123,
    instanceId: "before",
    productVersion: "version",
    protocolVersion: 1,
    startedAt: "time",
    port: 3000,
    authToken: "private",
  };
  let current = value;
  const result = await verifyLaunchdDaemonIdentity({
    read: () => current,
    identify: async () => "birth",
    request: async () => {
      current = { ...value, instanceId: "after" };
      return { ok: false, identity: {} };
    },
  });
  assert.equal(result, null);
});
