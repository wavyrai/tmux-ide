import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { manageDaemonService, type DaemonServiceDependencies } from "./daemon-service.ts";
import { planDaemonService } from "./daemon-service-plan.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import {
  inspectCanonicalDaemonInfo,
  reserveCanonicalDaemonSupervision,
  releaseCanonicalDaemonSupervision,
  tryAcquireCanonicalDaemonClaim,
  writeCanonicalDaemonInfo,
  clearCanonicalDaemonInfoIfOwned,
  releaseCanonicalDaemonClaim,
  type CanonicalDaemonClaim,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import type { DaemonServiceState } from "./daemon-service-manager.ts";

let root: string;
let cleanup: (() => void)[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "daemon-service-"));
  cleanup = [];
  vi.stubEnv("TMUX_IDE_DAEMON_INFO_DIR", root);
  vi.stubEnv("TMUX_IDE_REGISTRY_DIR", root);
});
afterEach(() => {
  for (const stop of cleanup) stop();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const namespace = resolveRuntimeNamespace({
    userHome: root,
    env: { TMUX_IDE_DAEMON_INFO_DIR: root, TMUX_IDE_REGISTRY_DIR: root },
  });
  const plan = planDaemonService({
    platform: "darwin",
    uid: process.getuid!(),
    home: root,
    executable: "/usr/bin/true",
    path: "/usr/bin:/bin",
    namespace,
  });
  let state: DaemonServiceState = { loaded: false, active: false, pid: null, definitionPath: null };
  let claim: CanonicalDaemonClaim | null = null;
  let info: CanonicalDaemonInfo | null = null;
  const stopOwner = () => {
    if (info && claim) clearCanonicalDaemonInfoIfOwned(info.instanceId, claim);
    if (claim) releaseCanonicalDaemonClaim(claim);
    info = null;
    claim = null;
  };
  cleanup.push(stopOwner);
  const startOwner = () => {
    const acquired = tryAcquireCanonicalDaemonClaim({
      kind: "supervised",
      supervisionId: plan.supervisionId,
    });
    if (acquired.status !== "acquired") throw new Error("fixture owner claim refused");
    claim = acquired.claim;
    info = {
      pid: 2147483647,
      port: 12345,
      bindHostname: "127.0.0.1",
      instanceId: randomUUID(),
      startedAt: new Date().toISOString(),
      protocolVersion: 1,
      productVersion: "test",
      supervisionId: plan.supervisionId,
      authToken: "private-token",
    };
    writeCanonicalDaemonInfo(info, claim);
    state = { loaded: true, active: true, pid: info.pid, definitionPath: plan.unitPath };
  };
  const manager = {
    available: vi.fn(async () => {}),
    inspect: vi.fn(async () => state),
    install: vi.fn(async () => startOwner()),
    restart: vi.fn(async () => {
      stopOwner();
      startOwner();
    }),
    stop: vi.fn(async () => {
      stopOwner();
      state = { loaded: false, active: false, pid: null, definitionPath: null };
    }),
    reload: vi.fn(async () => {}),
  };
  const deps: DaemonServiceDependencies = {
    plan: () => plan,
    manager: () => manager,
    inspect: inspectCanonicalDaemonInfo,
    reserve: reserveCanonicalDaemonSupervision,
    release: releaseCanonicalDaemonSupervision,
    probe: async (owner) => ({
      ok: true,
      pid: owner.pid,
      instanceId: owner.instanceId,
      startedAt: owner.startedAt,
      protocolVersion: owner.protocolVersion,
      productVersion: owner.productVersion,
    }),
    recordPath: plan.recordPath,
    waitMs: 1,
  };
  const run = (action: "install" | "status" | "restart" | "remove") =>
    manageDaemonService(action, action === "install" ? plan.executable : undefined, deps);
  return {
    plan,
    manager,
    deps,
    run,
    setState: (next: DaemonServiceState) => {
      state = next;
    },
  };
}

describe("managed daemon service lifecycle", () => {
  it("installs, reuses, restarts and removes the exact reserved owner", async () => {
    const { run, plan, manager } = fixture();
    const initial = await run("install");
    expect(initial.status).toBe("running");
    expect(await run("install")).toEqual(initial);
    expect(manager.install).toHaveBeenCalledTimes(1);
    const next = await run("restart");
    expect(next.status).toBe("running");
    expect(next).not.toEqual(initial);
    const status = await run("status");
    expect(status.status).toBe("running");
    expect(JSON.stringify(status)).not.toContain("private-token");
    expect((await run("remove")).status).toBe("removed");
    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
    expect(existsSync(plan.unitPath)).toBe(false);
    expect(existsSync(plan.recordPath)).toBe(false);
  });

  it("keeps an uncertain failed activation reserved and explicitly removable", async () => {
    const { run, plan, manager } = fixture();
    manager.install.mockRejectedValueOnce(new Error("activation uncertain"));
    await expect(run("install")).rejects.toThrow("activation uncertain");
    expect(inspectCanonicalDaemonInfo().status).toBe("reserved");
    expect(existsSync(plan.recordPath)).toBe(true);
    expect((await run("remove")).status).toBe("removed");
  });

  it("retains ownership when stop fails and permits a later removal", async () => {
    const { run, manager } = fixture();
    await run("install");
    manager.stop.mockRejectedValueOnce(new Error("manager unavailable"));
    await expect(run("remove")).rejects.toThrow("manager unavailable");
    expect(inspectCanonicalDaemonInfo().status).toBe("valid");
    expect((await run("remove")).status).toBe("removed");
  });

  it("resumes removal after unlink succeeded but manager reload failed", async () => {
    const { run, plan, manager } = fixture();
    await run("install");
    manager.reload.mockRejectedValueOnce(new Error("reload unavailable"));
    await expect(run("remove")).rejects.toThrow("reload unavailable");
    expect(existsSync(plan.unitPath)).toBe(false);
    expect(inspectCanonicalDaemonInfo().status).toBe("valid");
    await expect(run("restart")).rejects.toThrow("removal is incomplete");
    expect((await run("remove")).status).toBe("removed");
  });

  it("refuses modified definitions without stopping their owner", async () => {
    const { run, plan, manager } = fixture();
    await run("install");
    const original = readFileSync(plan.unitPath, "utf8");
    writeFileSync(plan.unitPath, "unknown definition");
    await expect(run("remove")).rejects.toThrow("modified");
    expect(manager.stop).not.toHaveBeenCalled();
    writeFileSync(plan.unitPath, original);
    await run("remove");
  });

  it("requires manager availability before reserving or writing files", async () => {
    const { run, plan, manager } = fixture();
    manager.available.mockRejectedValueOnce(new Error("manager unavailable"));
    await expect(run("install")).rejects.toThrow("manager unavailable");
    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
    expect(existsSync(plan.recordPath)).toBe(false);
  });

  it("waits for the manager to retire a stopping process before releasing ownership", async () => {
    const { run, plan, manager, deps } = fixture();
    deps.waitMs = 500;
    await run("install");
    const stop = manager.stop.getMockImplementation()!;
    manager.stop.mockImplementationOnce(async () => {
      await stop();
      manager.inspect.mockResolvedValueOnce({
        loaded: true,
        active: false,
        pid: 2147483647,
        definitionPath: plan.unitPath,
      });
    });
    expect((await run("remove")).status).toBe("removed");
    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
  });

  it("accepts the OS canonical spelling of the same owned definition", async () => {
    const { run, plan, setState } = fixture();
    await run("install");
    setState({
      loaded: true,
      active: true,
      pid: 2147483647,
      definitionPath: realpathSync(plan.unitPath),
    });
    expect((await run("status")).status).toBe("running");
    await run("remove");
  });

  it("removes a never-loaded partial installation whose definition is absent", async () => {
    const { run, plan, manager } = fixture();
    manager.install.mockRejectedValueOnce(new Error("activation unavailable"));
    await expect(run("install")).rejects.toThrow("activation unavailable");
    unlinkSync(plan.unitPath);
    expect((await run("remove")).status).toBe("removed");
    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
  });
});
