import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonRecordOwnerProvenDead,
  prepareCanonicalDaemonInfoForBootstrap,
} from "./canonical-daemon.ts";
import { createCanonicalDaemonBootstrapCoordinator } from "./canonical-daemon-bootstrap.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fchmodSync: vi.fn(actual.fchmodSync), lstatSync: vi.fn(actual.lstatSync) };
});

let directory: string;
let previous: string | undefined;
const current = {
  pid: process.pid,
  port: 4321,
  protocolVersion: 2,
  productVersion: "2.9.0-beta.18",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-09-16T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: null,
};

beforeEach(() => {
  previous = process.env.TMUX_IDE_DAEMON_INFO_DIR;
  directory = fs.mkdtempSync(join(tmpdir(), "tmux-ide-permission-recovery-"));
  process.env.TMUX_IDE_DAEMON_INFO_DIR = join(directory, "state");
  fs.mkdirSync(process.env.TMUX_IDE_DAEMON_INFO_DIR, { mode: 0o755 });
  fs.chmodSync(process.env.TMUX_IDE_DAEMON_INFO_DIR, 0o755);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.fchmodSync).mockReset();
  vi.mocked(fs.lstatSync).mockReset();
  if (previous === undefined) delete process.env.TMUX_IDE_DAEMON_INFO_DIR;
  else process.env.TMUX_IDE_DAEMON_INFO_DIR = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

function record(value: unknown = current) {
  const path = getCanonicalDaemonInfoPath();
  fs.writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
  fs.chmodSync(path, 0o644);
  return path;
}

// Reset mock wrappers to real implementations without modifying filesystem exports.
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.fchmodSync).mockImplementation(actual.fchmodSync);
  vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync);
});

describe("bootstrap legacy daemon permissions", () => {
  it("keeps inspection read-only, then hardens a same-user legacy record without changing bytes", () => {
    const path = record();
    const before = fs.readFileSync(path);
    expect(inspectCanonicalDaemonInfo()).toMatchObject({
      status: "invalid",
      reason: "parent-unsafe-permissions",
      ownerPid: null,
    });
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
    expect(fs.statSync(process.env.TMUX_IDE_DAEMON_INFO_DIR!).mode & 0o777).toBe(0o755);
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "valid",
      info: current,
    });
    expect(fs.readFileSync(path)).toEqual(before);
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(process.env.TMUX_IDE_DAEMON_INFO_DIR!).mode & 0o777).toBe(0o700);
    const calls = vi.mocked(fs.fchmodSync).mock.calls.length;
    expect(prepareCanonicalDaemonInfoForBootstrap().status).toBe("valid");
    expect(fs.fchmodSync).toHaveBeenCalledTimes(calls);
  });

  it("reveals a legacy schema PID only after secure preparation, preserving live and unknown owners", async () => {
    const path = record({ pid: process.pid, version: "0.0.1" });
    expect(inspectCanonicalDaemonInfo()).toMatchObject({ ownerPid: null });
    const state = prepareCanonicalDaemonInfoForBootstrap();
    expect(state).toMatchObject({
      status: "invalid",
      reason: "invalid-schema",
      ownerPid: process.pid,
    });
    if (state.status === "missing") throw new Error("unexpected missing state");
    await expect(isCanonicalDaemonRecordOwnerProvenDead(state)).resolves.toBe(false);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("unknown"), { code: "EIO" });
    });
    await expect(isCanonicalDaemonRecordOwnerProvenDead(state)).resolves.toBe(false);
    kill.mockRestore();
    expect(fs.readFileSync(path, "utf8")).toBe(
      JSON.stringify({ pid: process.pid, version: "0.0.1" }),
    );
  });

  it("allows bootstrap to proceed only after a securely parsed stale legacy PID is proven dead", async () => {
    const path = record({ pid: 99999999, version: "0.0.1" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    const state = prepareCanonicalDaemonInfoForBootstrap();
    expect(state).toMatchObject({
      status: "invalid",
      reason: "invalid-schema",
      ownerPid: 99999999,
    });
    if (state.status === "missing") throw new Error("unexpected missing state");
    await expect(isCanonicalDaemonRecordOwnerProvenDead(state)).resolves.toBe(true);
    const spawnOwner = vi.fn(async () => {
      // Permission migration does not delete the old record. Retirement remains
      // the elected startup owner's responsibility (simulated publication here).
      expect(JSON.parse(fs.readFileSync(path, "utf8")).version).toBe("0.0.1");
      fs.writeFileSync(path, JSON.stringify(current));
    });
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/unused", timeoutMs: 100 },
      {
        alive: async () => true,
        identity: async () => ({ ok: true, ...current }),
        health: async () => ({
          ok: true,
          protocolVersion: 2,
          productVersion: current.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      source: "started",
      candidate: current,
    });
    expect(spawnOwner).toHaveBeenCalledTimes(1);
    kill.mockRestore();
  });

  it.each(["parent", "record"])("recovers when only the %s has legacy permissions", (kind) => {
    const path = record();
    fs.chmodSync(
      kind === "parent" ? path : process.env.TMUX_IDE_DAEMON_INFO_DIR!,
      kind === "parent" ? 0o600 : 0o700,
    );
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "valid",
      info: current,
    });
  });

  it.each(["parent", "record"])(
    "refuses %s state writable by other users without changing permissions",
    (kind) => {
      const path = record();
      const target = kind === "parent" ? process.env.TMUX_IDE_DAEMON_INFO_DIR! : path;
      fs.chmodSync(target, kind === "parent" ? 0o777 : 0o666);
      expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
        status: "invalid",
        ownerPid: null,
        detail: expect.stringContaining("writable by other users"),
      });
      expect(fs.statSync(target).mode & 0o777).toBe(kind === "parent" ? 0o777 : 0o666);
      expect(fs.fchmodSync).not.toHaveBeenCalled();
    },
  );

  it.each(["parent", "record"])("refuses a %s symlink without hardening its target", (kind) => {
    const path = record();
    const target = join(directory, "target");
    const source = kind === "parent" ? process.env.TMUX_IDE_DAEMON_INFO_DIR! : path;
    fs.renameSync(source, target);
    fs.symlinkSync(target, source);
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "invalid",
      ownerPid: null,
    });
    expect(fs.statSync(target).mode & 0o777).toBe(kind === "parent" ? 0o755 : 0o644);
    expect(fs.fchmodSync).not.toHaveBeenCalled();
  });

  it("refuses hard-linked metadata", () => {
    const path = record();
    fs.linkSync(path, join(directory, "alias"));
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "invalid",
      reason: "unsafe-permissions",
      ownerPid: null,
    });
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
    expect(fs.fchmodSync).not.toHaveBeenCalled();
  });

  it.each(["parent", "record"])(
    "refuses foreign %s ownership before chmod or PID inspection",
    async (kind) => {
      const path = record();
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const target = kind === "parent" ? process.env.TMUX_IDE_DAEMON_INFO_DIR! : path;
      vi.mocked(fs.lstatSync).mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
        const stat = actual.lstatSync(...args);
        if (args[0] === target)
          Object.defineProperty(stat, "uid", { value: process.getuid!() + 1 });
        return stat;
      }) as typeof fs.lstatSync);
      expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
        status: "invalid",
        ownerPid: null,
      });
      expect(fs.fchmodSync).not.toHaveBeenCalled();
    },
  );

  it("detects a record replacement during chmod and never changes the replacement", async () => {
    const path = record();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.fchmodSync).mockImplementation((fd, mode) => {
      if (mode === 0o600) {
        fs.renameSync(path, join(directory, "original"));
        fs.writeFileSync(path, JSON.stringify({ ...current, pid: 123 }), { mode: 0o644 });
        fs.chmodSync(path, 0o644);
      }
      actual.fchmodSync(fd, mode);
    });
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "invalid",
      reason: "changed-while-opening",
      ownerPid: null,
    });
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
    expect(JSON.parse(fs.readFileSync(path, "utf8")).pid).toBe(123);
  });

  it("detects a parent replacement during chmod and leaves its permissions unchanged", async () => {
    record();
    const root = process.env.TMUX_IDE_DAEMON_INFO_DIR!;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.fchmodSync).mockImplementation((fd, mode) => {
      if (mode === 0o700) {
        fs.renameSync(root, join(directory, "original-root"));
        fs.mkdirSync(root, { mode: 0o755 });
        fs.chmodSync(root, 0o755);
      }
      actual.fchmodSync(fd, mode);
    });
    expect(prepareCanonicalDaemonInfoForBootstrap()).toMatchObject({
      status: "invalid",
      reason: "changed-while-opening",
      ownerPid: null,
    });
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });

  it("bootstrap defaults migrate and reuse a live generation without spawning", async () => {
    const path = record();
    const spawnOwner = vi.fn(async () => {});
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/unused", timeoutMs: 50 },
      {
        alive: async () => true,
        identity: async () => ({ ok: true, ...current }),
        health: async () => ({
          ok: true,
          protocolVersion: 2,
          productVersion: current.productVersion,
          uptime: 1,
        }),
        spawnOwner,
      },
    );
    await expect(coordinator.ensure()).resolves.toMatchObject({
      source: "existing",
      candidate: current,
    });
    expect(spawnOwner).not.toHaveBeenCalled();
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it("bootstrap reports blocked path and reason without spawning or deleting unknown-owner state", async () => {
    const path = record({ version: "0.0.1" });
    const spawnOwner = vi.fn(async () => {});
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/unused" },
      { spawnOwner },
    );
    await expect(coordinator.ensure()).rejects.toMatchObject({
      reason: "canonical-record-invalid",
      message: expect.stringContaining(path),
    });
    expect(spawnOwner).not.toHaveBeenCalled();
    expect(fs.readFileSync(path, "utf8")).toBe(JSON.stringify({ version: "0.0.1" }));
  });

  it("reports specific safe migration refusal guidance without disclosing record bytes", async () => {
    const path = record({ secret: "must-not-appear-in-diagnostics" });
    fs.linkSync(path, join(directory, "alias"));
    const spawnOwner = vi.fn(async () => {});
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/unused" },
      { spawnOwner },
    );
    const error = await coordinator.ensure().catch((error: unknown) => error);
    expect(error).toMatchObject({ message: expect.stringContaining("multiple hard links") });
    expect(String(error)).toContain(path);
    expect(String(error)).not.toContain("must-not-appear-in-diagnostics");
    expect(spawnOwner).not.toHaveBeenCalled();
  });

  it("does not run real migration when a bootstrap inspector is injected", async () => {
    const path = record();
    const coordinator = createCanonicalDaemonBootstrapCoordinator(
      { entryPath: "/unused" },
      {
        inspect: () => ({
          status: "invalid",
          reason: "invalid-schema",
          detail: "fixture",
          ownerPid: null,
          observation: null,
        }),
        ownerProvenDead: async () => false,
      },
    );
    await expect(coordinator.ensure()).rejects.toMatchObject({
      reason: "canonical-record-invalid",
    });
    expect(fs.statSync(path).mode & 0o777).toBe(0o644);
    expect(fs.fchmodSync).not.toHaveBeenCalled();
  });
});
