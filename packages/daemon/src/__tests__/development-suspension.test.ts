import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import { claimDevelopmentRuntimeOwner } from "../lib/development-runtime-owner.ts";
import { writeDevelopmentRecord, developmentWorktreeIdentity } from "../lib/development-state.ts";
import * as builds from "../lib/development-build.ts";
import {
  claimManagedDevelopmentLaunch,
  verifyManagedDevelopmentAdmission,
} from "../lib/development-owner.ts";
import * as processState from "../lib/development-state.ts";
import * as suspension from "../lib/development-suspension.ts";
import {
  suspendDevelopmentInstance,
  resumeDevelopmentInstance,
  downDevelopmentInstance,
  resetDevelopmentInstance,
  restartDevelopmentInstance,
  activateDevelopmentInstance,
} from "../lib/development-control.ts";
import {
  upDevelopmentInstance,
  startDevelopmentInstanceUnderLock,
  statusDevelopmentInstance,
} from "../lib/development-lifecycle.ts";
import { launchDevelopmentApp } from "../lib/development-app.ts";
import * as appAdmission from "../lib/development-app.ts";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});
const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});
const binding = { project: "ti-fixture", containerId: "a".repeat(64), volumesHash: "b".repeat(64) };
const bootId = randomUUID();
const witness = { bootId, pidNamespace: "pid:[123]" };
async function fixture(withDeadOwner = false) {
  const root = fs.mkdtempSync(join(tmpdir(), "development-suspend-"));
  cleanup.push(root);
  const worktree = join(root, "tree");
  fs.mkdirSync(worktree);
  execFileSync("git", ["init", "--quiet", worktree]);
  const instance = resolveDevelopmentInstance({ worktree, store: join(root, "store") });
  fs.mkdirSync(instance.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(instance.stateHome, { mode: 0o700 });
  const identity = {
    version: 1 as const,
    id: instance.id,
    digest: instance.digest,
    worktree: instance.worktree,
    name: instance.name,
    capability: randomUUID(),
    ...(await developmentWorktreeIdentity(instance)),
  };
  writeDevelopmentRecord(join(instance.root, "instance.json"), identity);
  claimDevelopmentRuntimeOwner(instance, identity);
  cleanup.push(instance.runtimeDir);
  fs.mkdirSync(join(instance.runtimeDir, "compiled-tui"), { mode: 0o700 });
  vi.spyOn(builds, "readDevelopmentBuild").mockReturnValue({
    capabilities: ["managed-development-owner-v1", "container-suspension-v1"],
    generation: "fixture",
    source: { digest: "a".repeat(64) },
  } as builds.DevelopmentBuildManifest);
  const probe = vi.spyOn(suspension, "developmentExecutionWitness").mockReturnValue({ ...witness });
  const owner = {
    version: 1,
    attempt: randomUUID(),
    pid: 2147483647,
    incarnation: "dead",
    generation: `build-${randomUUID()}`,
    manifestHash: "c".repeat(64),
  };
  if (withDeadOwner) {
    writeDevelopmentRecord(join(instance.root, "owner.json"), owner);
    writeDevelopmentRecord(join(instance.root, "startup-process.json"), owner);
    writeDevelopmentRecord(join(instance.root, "startup.json"), {
      attempt: owner.attempt,
      generation: owner.generation,
      manifestHash: owner.manifestHash,
    });
    writeDevelopmentRecord(join(instance.root, `launch-${owner.attempt}.json`), {
      version: 1,
      attempt: owner.attempt,
      pid: owner.pid,
    });
  }
  return { instance, identity, owner, probe };
}
it("suspends exact dead witnesses, retains durable data and resumes only explicitly", async () => {
  const { instance, probe } = await fixture(true);
  for (const name of ["registry.json", "machines.json", "config.json"])
    fs.writeFileSync(join(instance.stateHome, name), "preserve");
  for (const name of ["artifacts", "logs"]) {
    fs.mkdirSync(join(instance.root, name));
    fs.writeFileSync(join(instance.root, name, "sentinel"), "preserve");
  }
  const result = await suspendDevelopmentInstance(instance, binding);
  expect(result.status).toBe("suspended");
  const record = suspension.readDevelopmentSuspension(instance)!;
  expect(record.phase).toBe("suspended");
  expect(record.plan!.files).toHaveLength(4);
  expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(false);
  expect(suspension.suspensionFileInventory(instance)).toEqual([]);
  expect(await statusDevelopmentInstance(instance)).toMatchObject({
    state: "blocked",
    reason: "instance-suspended",
  });
  const status = JSON.stringify(await statusDevelopmentInstance(instance));
  expect(status).not.toContain(result.nonce);
  probe.mockReturnValue({ bootId, pidNamespace: "pid:[456]" });
  await expect(resumeDevelopmentInstance(instance, binding, result.nonce)).resolves.toMatchObject({
    status: "resumed",
  });
  expect(suspension.readDevelopmentSuspension(instance)).toBeNull();
  for (const name of ["registry.json", "machines.json", "config.json"])
    expect(fs.readFileSync(join(instance.stateHome, name), "utf8")).toBe("preserve");
  expect(fs.readFileSync(join(instance.root, "artifacts/sentinel"), "utf8")).toBe("preserve");
  expect(fs.readFileSync(join(instance.root, "logs/sentinel"), "utf8")).toBe("preserve");
});
it("blocks every managed admission and reset throughout the Docker stop gap", async () => {
  const { instance } = await fixture();
  await suspendDevelopmentInstance(instance, binding);
  for (const call of [
    () => upDevelopmentInstance(instance),
    () => startDevelopmentInstanceUnderLock(instance),
    () => launchDevelopmentApp(instance),
    () => restartDevelopmentInstance(instance),
    () => activateDevelopmentInstance(instance),
    () => resetDevelopmentInstance(instance, { yes: true }),
    () => downDevelopmentInstance(instance),
  ]) {
    await expect(call()).rejects.toMatchObject({ reason: "instance-suspended" });
  }
  expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("suspended");
});
it.each(["container", "volumes", "project", "boot", "nonce", "worktree"])(
  "refuses changed %s proof on explicit resume",
  async (change) => {
    const { instance, probe } = await fixture();
    const result = await suspendDevelopmentInstance(instance, binding);
    const changed = { ...binding };
    if (change === "container") changed.containerId = "d".repeat(64);
    if (change === "volumes") changed.volumesHash = "d".repeat(64);
    if (change === "project") changed.project = "other-project";
    if (change === "boot") probe.mockReturnValue({ ...witness, bootId: randomUUID() });
    if (change === "worktree") {
      fs.renameSync(instance.worktree, instance.worktree + "-moved");
      fs.mkdirSync(instance.worktree);
      execFileSync("git", ["init", "--quiet", instance.worktree]);
    }
    await expect(
      resumeDevelopmentInstance(
        instance,
        changed,
        change === "nonce" ? randomUUID() : result.nonce,
      ),
    ).rejects.toThrow();
    expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("suspended");
  },
);
it.each(["startup", "launch", "tmux-startup", "runtime-file", "runtime-socket", "app"])(
  "protects unknown %s rather than inferring it exited",
  async (kind) => {
    const { instance } = await fixture();
    if (kind === "startup")
      writeDevelopmentRecord(join(instance.root, "startup.json"), {
        attempt: randomUUID(),
        generation: `build-${randomUUID()}`,
        manifestHash: "a".repeat(64),
      });
    if (kind === "launch") {
      const attempt = randomUUID();
      writeDevelopmentRecord(join(instance.root, `launch-${attempt}.json`), {
        version: 1,
        attempt,
        pid: 2147483647,
      });
    }
    if (kind === "tmux-startup")
      writeDevelopmentRecord(join(instance.root, "tmux-startup.json"), {
        version: 1,
        socket: join(instance.runtimeDir, "tmux.sock"),
        executable: "/missing",
        generation: `build-${randomUUID()}`,
      });
    if (kind.startsWith("runtime"))
      fs.writeFileSync(
        join(instance.runtimeDir, kind === "runtime-socket" ? "tmux.sock" : "foreign"),
        "protected",
      );
    if (kind === "app") {
      fs.mkdirSync(join(instance.root, "apps"), { mode: 0o700 });
      writeDevelopmentRecord(join(instance.root, "apps", `${randomUUID()}.json`), {
        unknown: true,
      });
    }
    await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow();
    expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("stopping");
    await expect(upDevelopmentInstance(instance)).rejects.toMatchObject({
      reason: "instance-suspended",
    });
    await expect(
      resumeDevelopmentInstance(
        instance,
        binding,
        suspension.readDevelopmentSuspension(instance)!.nonce,
      ),
    ).rejects.toThrow();
  },
);
it("recovers interrupted exact retirement only in the original namespace", async () => {
  const { instance, probe } = await fixture(true);
  const original = fs.rmSync;
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (path === join(instance.root, "startup-process.json"))
      throw Error("simulated crash after owner retirement");
    return original(path, options);
  });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("simulated crash");
  remove.mockRestore();
  expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(false);
  const record = suspension.readDevelopmentSuspension(instance)!;
  expect(record.phase).toBe("retiring");
  probe.mockReturnValue({ ...witness, pidNamespace: "pid:[456]" });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("original");
  await expect(resumeDevelopmentInstance(instance, binding, record.nonce)).rejects.toThrow();
  probe.mockReturnValue(witness);
  await expect(suspendDevelopmentInstance(instance, binding)).resolves.toMatchObject({
    status: "suspended",
    nonce: record.nonce,
  });
});
it("refuses altered raw bytes or new records after the retirement plan", async () => {
  const { instance } = await fixture(true);
  const original = fs.rmSync;
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
    if (path === join(instance.root, "owner.json")) throw Error("crash before deletion");
    return original(path, options);
  });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("crash");
  remove.mockRestore();
  const path = join(instance.root, "owner.json");
  fs.appendFileSync(path, "\n"); // Same parsed JSON and inode, different exact file bytes.
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("replaced");
  expect(fs.existsSync(path)).toBe(true);
});
it("never erases a new owner on completed resume, and serializes concurrent suspend/up", async () => {
  const { instance, owner } = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const atBarrier = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requireStopped = appAdmission.requireStoppedDevelopmentApps;
  vi.spyOn(appAdmission, "requireStoppedDevelopmentApps").mockImplementationOnce(async (target) => {
    entered();
    await held;
    return requireStopped(target);
  });
  const first = suspendDevelopmentInstance(instance, binding);
  // Both contenders discover process identity asynchronously before locking. Call order
  // is not acquisition order: start up only after suspension owns its durable barrier.
  await atBarrier;
  expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("stopping");
  expect(fs.existsSync(join(instance.root, "locks/lifecycle/owner.json"))).toBe(true);
  const admitted = upDevelopmentInstance(instance).catch((error) => error);
  release();
  const result = await first;
  expect(await admitted).toMatchObject({ reason: "instance-suspended" });
  writeDevelopmentRecord(join(instance.root, "owner.json"), {
    ...owner,
    pid: process.pid,
    incarnation: "replacement",
  });
  await expect(resumeDevelopmentInstance(instance, binding, result.nonce)).rejects.toThrow(
    "new process",
  );
  expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(true);
});
it("rejects nested symlink escape and malformed journal witnesses", async () => {
  const { instance } = await fixture();
  const outside = join(instance.worktree, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  writeDevelopmentRecord(join(outside, "owner.json"), { secret: true });
  fs.symlinkSync(outside, join(instance.stateHome, "daemon.claim"));
  expect(() =>
    suspension.suspensionFileWitness(instance, "state/daemon.claim/owner.json"),
  ).toThrow();
  fs.unlinkSync(join(instance.stateHome, "daemon.claim"));
  await suspendDevelopmentInstance(instance, binding);
  const record = suspension.readDevelopmentSuspension(instance)!;
  writeDevelopmentRecord(suspension.suspensionPath(instance), {
    ...record,
    plan: {
      ...record.plan,
      files: [{ name: "owner.json", hash: "a".repeat(64), dev: -1, ino: 1 }],
    },
  });
  expect(() => suspension.readDevelopmentSuspension(instance)).toThrow("witness");
  expect(fs.readFileSync(join(outside, "owner.json"), "utf8")).toContain("secret");
});

it("finishes a crash after planned claim-owner deletion without adopting an unplanned empty claim", async () => {
  const { instance } = await fixture();
  const directory = join(instance.stateHome, "daemon.claim");
  fs.mkdirSync(directory, { mode: 0o700 });
  writeDevelopmentRecord(join(directory, "owner.json"), {
    claimId: randomUUID(),
    pid: 2147483647,
    acquiredAt: new Date().toISOString(),
  });
  const original = fs.rmdirSync;
  const remove = vi.spyOn(fs, "rmdirSync").mockImplementation((path) => {
    if (path === directory) throw Error("crash after claim file removal");
    return original(path);
  });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("crash after claim");
  remove.mockRestore();
  expect(fs.readdirSync(directory)).toEqual([]);
  expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("retiring");
  await expect(suspendDevelopmentInstance(instance, binding)).resolves.toMatchObject({
    status: "suspended",
  });
  expect(fs.existsSync(directory)).toBe(false);
});
it("protects an unrecorded empty canonical claim", async () => {
  const { instance } = await fixture();
  fs.mkdirSync(join(instance.stateHome, "daemon.claim"), { mode: 0o700 });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow(
    "Incomplete canonical",
  );
  expect(fs.existsSync(join(instance.stateHome, "daemon.claim"))).toBe(true);
});
it.each(["reused", "unknown"])(
  "protects %s process witnesses during interrupted retirement",
  async (kind) => {
    const { instance } = await fixture(true);
    const original = fs.rmSync;
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (path === join(instance.root, "owner.json")) throw Error("crash");
      return original(path, options);
    });
    await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("crash");
    remove.mockRestore();
    const identity = processState.developmentProcessIdentity;
    vi.spyOn(processState, "developmentProcessIdentity").mockImplementation((pid) => {
      if (pid !== 2147483647) return identity(pid);
      if (kind === "unknown") return Promise.reject(Error("unknown process"));
      return Promise.resolve("reused-process");
    });
    await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow();
    expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(true);
    expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("retiring");
  },
);
it("rejects live/reused owner before planning or signalling an unverified process", async () => {
  const { instance, owner } = await fixture();
  writeDevelopmentRecord(join(instance.root, "owner.json"), {
    ...owner,
    pid: process.pid,
    incarnation: "not-this-process",
  });
  await expect(suspendDevelopmentInstance(instance, binding)).rejects.toMatchObject({
    reason: "owner-unverified",
  });
  expect(suspension.readDevelopmentSuspension(instance)?.plan).toBeNull();
  expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(true);
});

it.each(["selected", "recorded"])(
  "refuses legacy %s owner artifacts before publishing a barrier",
  async (which) => {
    const { instance } = await fixture(true);
    vi.mocked(builds.readDevelopmentBuild).mockImplementation(
      (_instance, env) =>
        ({
          capabilities:
            which === "selected" || env?.TMUX_IDE_DEVELOPMENT_BUILD
              ? ["managed-development-owner-v1"]
              : ["managed-development-owner-v1", "container-suspension-v1"],
        }) as builds.DevelopmentBuildManifest,
    );
    await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow("Rebuild");
    expect(suspension.readDevelopmentSuspension(instance)).toBeNull();
    expect(fs.existsSync(join(instance.root, "owner.json"))).toBe(true);
  },
);
it("fences a delayed child on both sides of exclusive launch admission", async () => {
  const { instance, identity } = await fixture();
  const attempt = randomUUID(),
    path = join(instance.root, `launch-${attempt}.json`);
  const original = fs.writeFileSync;
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
    original(file, ...args);
    if (file === path)
      writeDevelopmentRecord(suspension.suspensionPath(instance), {
        version: 1,
        phase: "stopping",
        nonce: randomUUID(),
        identityHash: suspension.suspensionIdentityHash(instance, identity),
        binding,
        witness,
        plan: null,
      });
  });
  await expect(claimManagedDevelopmentLaunch(instance, attempt)).rejects.toMatchObject({
    reason: "instance-suspended",
  });
  write.mockRestore();
  expect(fs.existsSync(path)).toBe(true); // Failed consumed attempt remains evidence.
  const second = randomUUID();
  await expect(claimManagedDevelopmentLaunch(instance, second)).rejects.toMatchObject({
    reason: "instance-suspended",
  });
  expect(fs.existsSync(join(instance.root, `launch-${second}.json`))).toBe(false);
});
it("rejects pending admission replay after an explicit suspend/resume", async () => {
  const { instance, owner } = await fixture(true);
  const expected = {
    attempt: owner.attempt,
    generation: owner.generation,
    manifestHash: owner.manifestHash,
  };
  const suspended = await suspendDevelopmentInstance(instance, binding);
  await resumeDevelopmentInstance(instance, binding, suspended.nonce);
  expect(() => verifyManagedDevelopmentAdmission(instance, owner.attempt, expected)).toThrow(
    "changed",
  );
  writeDevelopmentRecord(join(instance.root, "startup.json"), {
    ...expected,
    generation: `build-${randomUUID()}`,
  });
  expect(() => verifyManagedDevelopmentAdmission(instance, owner.attempt, expected)).toThrow(
    "changed",
  );
  writeDevelopmentRecord(join(instance.root, "startup.json"), expected);
  expect(() => verifyManagedDevelopmentAdmission(instance, owner.attempt, expected)).not.toThrow();
});

it("does not clear a completed barrier after an unsupported build is selected", async () => {
  const { instance } = await fixture();
  const result = await suspendDevelopmentInstance(instance, binding);
  vi.mocked(builds.readDevelopmentBuild).mockReturnValue({
    capabilities: ["managed-development-owner-v1"],
  } as builds.DevelopmentBuildManifest);
  await expect(resumeDevelopmentInstance(instance, binding, result.nonce)).rejects.toThrow(
    "Rebuild",
  );
  expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("suspended");
});

it.each(["owner.json", "startup.json", "tmux.json", "tmux-startup.json"])(
  "protects literal null %s instead of treating it as absent",
  async (name) => {
    const { instance } = await fixture();
    const path = join(instance.root, name);
    writeDevelopmentRecord(path, null);
    await expect(suspendDevelopmentInstance(instance, binding)).rejects.toThrow(
      "Unknown retirement record",
    );
    expect(fs.readFileSync(path, "utf8")).toBe("null");
    expect(suspension.readDevelopmentSuspension(instance)?.phase).toBe("stopping");
  },
);
it("rejects array retirement records", async () => {
  const { instance } = await fixture();
  writeDevelopmentRecord(join(instance.root, "startup.json"), []);
  expect(() => suspension.suspensionFileWitness(instance, "startup.json")).toThrow(
    "Unknown retirement record",
  );
});

it.each([null, false, 0, "", [], {}, "not-a-journal"])(
  "preserves malformed journal %# and refuses admission",
  async (value) => {
    const { instance } = await fixture();
    const path = suspension.suspensionPath(instance);
    writeDevelopmentRecord(path, value);
    const before = fs.readFileSync(path, "utf8");
    expect(() => suspension.readDevelopmentSuspension(instance)).toThrow(
      "Invalid suspension journal",
    );
    for (const call of [
      () => upDevelopmentInstance(instance),
      () => startDevelopmentInstanceUnderLock(instance),
      () => launchDevelopmentApp(instance),
      () => restartDevelopmentInstance(instance),
      () => activateDevelopmentInstance(instance),
      () => resetDevelopmentInstance(instance, { yes: true }),
      () => downDevelopmentInstance(instance),
      () => claimManagedDevelopmentLaunch(instance, randomUUID()),
    ]) {
      await expect(call()).rejects.toMatchObject({ reason: "suspension-unverified" });
      expect(fs.readFileSync(path, "utf8")).toBe(before);
    }
    expect(suspension.suspensionFileInventory(instance)).toEqual([]);
  },
);
it("only an absent journal leaves admission open", async () => {
  const { instance } = await fixture();
  expect(suspension.readDevelopmentSuspension(instance)).toBeNull();
  expect(() => suspension.requireDevelopmentNotSuspended(instance)).not.toThrow();
});
