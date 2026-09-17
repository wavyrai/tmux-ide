import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  systemdFixtureDefinition,
  systemdContainerArguments,
  inspectSystemdContainer,
  parseSystemdUnit,
  linuxBirth,
  systemdFixtureImage,
  systemdFixtureInit,
  verifySystemdDependencyInputs,
  verifySystemdDependencyLinks,
  systemdFailureDiagnostic,
  observeSystemdOwner,
} from "./owned-systemd-fixture.mjs";
const d = systemdFixtureDefinition("a".repeat(32));
function inspect() {
  return {
    Id: "b".repeat(64),
    Name: `/${d.name}`,
    Image: systemdFixtureImage,
    Config: {
      Image: systemdFixtureImage,
      User: "0:0",
      StopSignal: "SIGRTMIN+3",
      Entrypoint: ["/bin/sh"],
      Cmd: ["-c", systemdFixtureInit],
      Labels: d.labels,
    },
    HostConfig: {
      Privileged: false,
      NetworkMode: "none",
      CgroupnsMode: "private",
      Memory: 536870912,
      PidsLimit: 256,
      ReadonlyRootfs: false,
      CapAdd: ["SYS_ADMIN"],
      SecurityOpt: ["no-new-privileges"],
      Binds: null,
      Devices: [],
      Tmpfs: { "/run": "", "/run/lock": "", "/tmp": "" },
      PortBindings: {},
    },
    Mounts: [],
    NetworkSettings: { Networks: { none: {} }, Ports: {} },
    State: { Running: true, Pid: 100, OOMKilled: false },
  };
}
test("fixed service declares successful-exit restart, nonroot owner and exact policy", () => {
  assert.match(d.unitText, /Restart=always/);
  assert.match(d.unitText, /User=1000/);
  assert.match(d.unitText, new RegExp(`--supervised ${d.supervisionId}`));
  assert.match(d.unitText, /KillMode=process/);
  assert.throws(() => systemdFixtureDefinition("../bad"));
  const args = systemdContainerArguments(d);
  assert.equal(args.includes("--privileged"), false);
  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("--volume"), false);
});

test("dependency reuse requires exact inputs while ignoring unrelated script metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "systemd-deps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["current", "historical"]) {
    const path = join(root, dir);
    mkdirSync(join(path, "packages/core"), { recursive: true });
    mkdirSync(join(path, "apps"));
    mkdirSync(join(path, "docs"));
    for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".bun-version"])
      writeFileSync(join(path, file), "fixed");
    for (const file of ["package.json", "packages/core/package.json", "docs/package.json"])
      writeFileSync(
        join(path, file),
        JSON.stringify({ dependencies: { foo: "1" }, scripts: { test: dir } }),
      );
  }
  assert.equal(
    verifySystemdDependencyInputs(join(root, "current"), join(root, "historical")).manifests,
    3,
  );
  writeFileSync(
    join(root, "current/packages/core/package.json"),
    JSON.stringify({ dependencies: { foo: "2" } }),
  );
  assert.throws(
    () => verifySystemdDependencyInputs(join(root, "current"), join(root, "historical")),
    /dependency-input-mismatch/,
  );
});
test("actual workspace links must resolve to candidate, never historical source", (t) => {
  const root = mkdtempSync(join(tmpdir(), "systemd-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  mkdirSync(join(candidate, "node_modules"), { recursive: true });
  mkdirSync(join(candidate, "apps"));
  mkdirSync(join(candidate, "docs"));
  const links = join(candidate, "packages/daemon/node_modules/@tmux-ide");
  mkdirSync(links, { recursive: true });
  for (const name of ["contracts", "core", "daemon-client"]) {
    mkdirSync(join(candidate, "packages", name), { recursive: true });
    symlinkSync(join(candidate, "packages", name), join(links, name));
  }
  assert.equal(verifySystemdDependencyLinks(candidate).candidateRelative, true);
  mkdirSync(join(root, "historical"));
  symlinkSync(join(root, "historical"), join(candidate, "node_modules/old"));
  assert.throws(() => verifySystemdDependencyLinks(candidate), /dependency-link-escape/);
});
test("bounded service diagnostics contain only fixed classifications, never private payloads", () => {
  const text = "secret-token-value\nCanonical daemon claim is invalid: owner is not proven dead\n";
  const receipt = systemdFailureDiagnostic(text);
  assert.deepEqual(receipt.categories, ["claim", "ownerNotDead"]);
  assert.equal(JSON.stringify(receipt).includes("secret-token-value"), false);
  assert.throws(() => systemdFailureDiagnostic("x".repeat(65537)), /journal-bound/);
});
test("complete inspection rejects foreign, recreated, broadened or incomplete containers", () => {
  const good = inspect();
  assert.equal(inspectSystemdContainer(good, d, good.Id).running, true);
  for (const change of [
    (r) => {
      r.Id = "c".repeat(64);
    },
    (r) => {
      r.Config.Labels = {};
    },
    (r) => {
      r.Image = "sha256:" + "d".repeat(64);
    },
    (r) => {
      r.HostConfig.Binds = ["/tmp:/host:rw"];
    },
    (r) => {
      r.HostConfig.Privileged = true;
    },
    (r) => {
      r.HostConfig.CgroupnsMode = "host";
    },
    (r) => {
      r.HostConfig.Devices = [{ PathOnHost: "/dev/test" }];
    },
    (r) => {
      r.HostConfig.PortBindings = { "80/tcp": [] };
    },
    (r) => {
      r.NetworkSettings.Networks.bridge = {};
    },
    (r) => {
      r.Mounts = [{ Type: "bind", Destination: "/run", RW: true }];
    },
    (r) => {
      delete r.HostConfig.Devices;
    },
    (r) => {
      delete r.State;
    },
  ]) {
    const raw = structuredClone(good);
    change(raw);
    assert.throws(() => inspectSystemdContainer(raw, d, good.Id));
  }
});
const unit = `Id=${d.unit}\nFragmentPath=/etc/systemd/system/${d.unit}\nLoadState=loaded\nMainPID=123\nUser=1000\nGroup=1000\nRestart=always\nKillMode=process\nActiveState=active\nSubState=running\n`;
test("systemd observation rejects duplicates and changed service authority", () => {
  assert.equal(parseSystemdUnit(unit, d).pid, 123);
  for (const text of [
    unit + "MainPID=456\n",
    unit.replace("User=1000", "User=0"),
    unit.replace("Restart=always", "Restart=on-failure"),
    unit.replace("MainPID=123", "MainPID=-1"),
    unit.replace("FragmentPath=/etc", "FragmentPath=/run"),
  ])
    assert.throws(() => parseSystemdUnit(text, d));
});
test("Linux birth decoder handles comm parentheses and distinguishes reused PID", () => {
  const boot = "11111111-1111-4111-8111-111111111111";
  const stat = (ticks) => `123 (worker ) title) S ${Array(18).fill("0").join(" ")} ${ticks} 0`;
  const a = linuxBirth(stat(10), boot, "pid:[100]");
  assert.equal(a.startTicks, "10");
  assert.notDeepEqual(a, linuxBirth(stat(11), boot, "pid:[100]"));
  assert.notDeepEqual(a, linuxBirth(stat(10), boot, "pid:[101]"));
  for (const args of [
    ["bad", boot, "pid:[100]"],
    [stat("bad"), boot, "pid:[100]"],
    [stat(1), "bad", "pid:[100]"],
  ])
    assert.throws(() => linuxBirth(...args));
});

test("stable reauthenticated owner outside service is an actual qualification failure", async () => {
  const owner = { pid: 123, instanceId: "original", authToken: "private" };
  for (const servicePid of [0, 456]) {
    await assert.rejects(
      observeSystemdOwner({
        identity: async () => ({ ...owner }),
        unit: async () => ({ pid: servicePid }),
        birth: async () => ({ pid: 123, startTicks: "100", namespace: "pid:[1]" }),
      }),
      /daemon-escaped-supervisor/,
    );
  }
  const result = await observeSystemdOwner({
    identity: async () => owner,
    unit: async () => ({ pid: 123 }),
    birth: async () => "same-birth",
  });
  assert.equal(result.confirmed, true);
});

test("owner replacement, service handoff, death and PID reuse samples remain pending", async () => {
  const owner = { pid: 123, instanceId: "original", authToken: "private" };
  for (const scenario of ["identity", "credential", "service", "death", "birth", "missing-birth"]) {
    let identities = 0,
      units = 0,
      births = 0;
    const result = await observeSystemdOwner({
      identity: async () => {
        identities++;
        if (identities === 2 && scenario === "identity")
          return { ...owner, instanceId: "replacement" };
        if (identities === 2 && scenario === "credential")
          return { ...owner, authToken: "replacement-private" };
        return owner;
      },
      unit: async () => ({ pid: ++units === 2 && scenario === "service" ? 123 : 456 }),
      birth: async () => {
        births++;
        if (scenario === "missing-birth" || (births === 2 && scenario === "death")) return null;
        return births === 2 && scenario === "birth" ? "reused-pid-birth" : "original-birth";
      },
    });
    assert.equal(result.confirmed, false, scenario);
  }
});
