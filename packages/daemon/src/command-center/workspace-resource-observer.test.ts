import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@tmux-ide/contracts";

import { WorkspaceResourceObserver, type StartPathWatch } from "./workspace-resource-observer.ts";

class FakeRegistry {
  readonly #emitter = new EventEmitter();
  readonly #workspaces = new Map<string, Workspace>();
  get(name: string): Workspace | null {
    return this.#workspaces.get(name) ?? null;
  }
  on(event: "workspace.added" | "workspace.removed", listener: (value: never) => void): () => void {
    this.#emitter.on(event, listener);
    return () => this.#emitter.off(event, listener);
  }
  add(name: string, projectDir = `/repo/${name}`): void {
    const workspace: Workspace = {
      name,
      sessionName: name,
      projectDir,
      ideConfigPath: null,
      addedAt: "2026-08-12T00:00:00.000Z",
    };
    this.#workspaces.set(name, workspace);
    this.#emitter.emit("workspace.added", workspace);
  }
  remove(name: string): void {
    this.#workspaces.delete(name);
    this.#emitter.emit("workspace.removed", name);
  }
}

function harness() {
  const starts: Array<{ path: string; changed: () => void }> = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const start: StartPathWatch = async (path, changed) => {
    starts.push({ path, changed });
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  };
  return { starts, stops, start };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("WorkspaceResourceObserver", () => {
  it("installs project, git and runtime observers only for their demanded projections", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    const project = harness();
    const git = harness();
    const missions = harness();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startProjectWatch: project.start,
      startGitWatch: git.start,
      startMissionWatch: missions.start,
      resolveGitRoot: () => "/git/app",
      resolveMissionRoot: async () => "/runtime/app",
    });

    const files = observer.acquire("app", "workspace-files");
    const filesTwo = observer.acquire("app", "workspace-files");
    await Promise.all([
      expect(files.ready).resolves.toEqual({ status: "installed" }),
      expect(filesTwo.ready).resolves.toEqual({ status: "installed" }),
    ]);
    expect(project.starts).toHaveLength(1);
    expect(git.starts).toHaveLength(0);
    expect(missions.starts).toHaveLength(0);

    const changes = observer.acquire("app", "workspace-changes");
    await expect(changes.ready).resolves.toEqual({ status: "installed" });
    expect(project.starts).toHaveLength(1);
    expect(git.starts).toHaveLength(1);
    changes.release();
    await settle();
    expect(git.stops[0]).toHaveBeenCalledOnce();
    expect(project.stops[0]).not.toHaveBeenCalled();

    files.release();
    expect(project.stops[0]).not.toHaveBeenCalled();
    filesTwo.release();
    await settle();
    const mission = observer.acquire("app", "workspace-missions");
    await expect(mission.ready).resolves.toEqual({ status: "installed" });
    const missionTwo = observer.acquire("app", "workspace-missions");
    await expect(missionTwo.ready).resolves.toEqual({ status: "installed" });
    expect(missions.starts.map((value) => value.path)).toEqual(["/runtime/app"]);
    expect(project.starts).toHaveLength(1);
    expect(git.starts).toHaveLength(1);
    mission.release();
    missionTwo.release();
    await observer.dispose();
  });

  it("starts on late registration, retires on removal, and restarts once on re-add", async () => {
    const registry = new FakeRegistry();
    const project = harness();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startProjectWatch: project.start,
    });
    const handle = observer.acquire("late", "workspace-files");
    await expect(handle.ready).resolves.toEqual({ status: "unavailable" });
    expect(project.starts).toHaveLength(0);
    registry.add("late", "/repo/one");
    await settle();
    expect(project.starts.map((x) => x.path)).toEqual(["/repo/one"]);
    registry.remove("late");
    await settle();
    expect(project.stops[0]).toHaveBeenCalledOnce();
    registry.add("late", "/repo/two");
    await settle();
    expect(project.starts.map((x) => x.path)).toEqual(["/repo/one", "/repo/two"]);
    handle.release();
    await observer.dispose();
    expect(project.stops[1]).toHaveBeenCalledOnce();
  });

  it("shares N-client demand and coalesces a physical burst into one projection fanout", async () => {
    vi.useFakeTimers();
    const registry = new FakeRegistry();
    registry.add("app");
    const project = harness();
    const emit = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit,
      startProjectWatch: project.start,
      debounceMs: 20,
    });
    const one = observer.acquire("app", "workspace-files");
    const two = observer.acquire("app", "workspace-files");
    const changes = observer.acquire("app", "workspace-changes");
    await Promise.all([one.ready, two.ready, changes.ready]);
    expect(project.starts).toHaveLength(1);
    project.starts[0]!.changed();
    project.starts[0]!.changed();
    project.starts[0]!.changed();
    await vi.advanceTimersByTimeAsync(20);
    expect(emit.mock.calls.map(([value]) => value.resource).sort()).toEqual([
      "workspace-changes",
      "workspace-files",
    ]);
    one.release();
    two.release();
    expect(project.stops[0]).not.toHaveBeenCalled();
    changes.release();
    await settle();
    expect(project.stops[0]).toHaveBeenCalledOnce();
    await observer.dispose();
  });

  it("never derives mission invalidations from source edits", async () => {
    vi.useFakeTimers();
    const registry = new FakeRegistry();
    registry.add("app");
    const project = harness();
    const missions = harness();
    const emit = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit,
      startProjectWatch: project.start,
      startMissionWatch: missions.start,
      resolveMissionRoot: async () => "/runtime/app",
      debounceMs: 10,
    });
    const files = observer.acquire("app", "workspace-files");
    const mission = observer.acquire("app", "workspace-missions");
    await Promise.all([files.ready, mission.ready]);
    project.starts[0]!.changed();
    await vi.advanceTimersByTimeAsync(10);
    expect(emit).toHaveBeenCalledWith({ workspaceName: "app", resource: "workspace-files" });
    expect(emit).not.toHaveBeenCalledWith({ workspaceName: "app", resource: "workspace-missions" });
    emit.mockClear();
    missions.starts[0]!.changed();
    await vi.advanceTimersByTimeAsync(10);
    expect(emit).toHaveBeenCalledWith({ workspaceName: "app", resource: "workspace-missions" });
    files.release();
    mission.release();
    await observer.dispose();
  });

  it("reports synchronous and asynchronous install failures honestly, then retries after re-acquire", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    const stop = vi.fn();
    const start = vi
      .fn<StartPathWatch>()
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockRejectedValueOnce(new Error("async"))
      .mockResolvedValueOnce(stop);
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startProjectWatch: start,
    });
    const one = observer.acquire("app", "workspace-files");
    await expect(one.ready).resolves.toEqual({ status: "unavailable" });
    one.release();
    const two = observer.acquire("app", "workspace-files");
    await expect(two.ready).resolves.toEqual({ status: "unavailable" });
    two.release();
    const three = observer.acquire("app", "workspace-files");
    await expect(three.ready).resolves.toEqual({ status: "installed" });
    three.release();
    await observer.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("recovers an unavailable shared slot while another client still holds demand", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    const stop = vi.fn();
    const start = vi
      .fn<StartPathWatch>()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce(stop);
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startProjectWatch: start,
    });

    const first = observer.acquire("app", "workspace-files");
    await expect(first.ready).resolves.toEqual({ status: "unavailable" });
    const second = observer.acquire("app", "workspace-files");
    await expect(second.ready).resolves.toEqual({ status: "installed" });
    expect(start).toHaveBeenCalledTimes(2);

    first.release();
    expect(stop).not.toHaveBeenCalled();
    second.release();
    await observer.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("orders release behind a pending start and drains its late stop on dispose", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    let resolveStart!: (stop: () => void) => void;
    const stop = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startProjectWatch: () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    });
    const handle = observer.acquire("app", "workspace-files");
    await settle();
    handle.release();
    let disposed = false;
    const disposing = observer.dispose().then(() => {
      disposed = true;
    });
    await settle();
    expect(disposed).toBe(false);
    resolveStart(stop);
    await expect(handle.ready).resolves.toEqual({ status: "unavailable" });
    await disposing;
    expect(stop).toHaveBeenCalledOnce();
  });
});
