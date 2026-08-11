import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@tmux-ide/contracts";

import {
  WorkspaceResourceObserver,
  type StartWorkspaceWatch,
  type WorkspaceWatchCallbacks,
} from "./workspace-resource-observer.ts";

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

interface WatchHarness {
  readonly start: StartWorkspaceWatch;
  readonly starts: Array<{ projectDir: string; callbacks: WorkspaceWatchCallbacks }>;
  readonly stops: ReturnType<typeof vi.fn>[];
}

function watchHarness(): WatchHarness {
  const starts: WatchHarness["starts"] = [];
  const stops: WatchHarness["stops"] = [];
  return {
    starts,
    stops,
    start: async (projectDir, callbacks) => {
      starts.push({ projectDir, callbacks });
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceResourceObserver", () => {
  it("shares one watcher across clients/resources and coalesces a burst", async () => {
    vi.useFakeTimers();
    const registry = new FakeRegistry();
    registry.add("app");
    const harness = watchHarness();
    const emit = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit,
      startWatch: harness.start,
      debounceMs: 50,
    });

    const releaseFilesOne = observer.acquire("app", "workspace-files");
    const releaseFilesTwo = observer.acquire("app", "workspace-files");
    const releaseChanges = observer.acquire("app", "workspace-changes");
    await settle();
    expect(harness.starts).toHaveLength(1);
    expect(observer.state()).toEqual([{ workspaceName: "app", references: 3, watching: true }]);

    harness.starts[0]!.callbacks.onWorkspaceChanged();
    harness.starts[0]!.callbacks.onWorkspaceChanged();
    harness.starts[0]!.callbacks.onGitChanged();
    await vi.advanceTimersByTimeAsync(49);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit.mock.calls.map(([change]) => change.resource).sort()).toEqual([
      "workspace-changes",
      "workspace-files",
    ]);

    releaseFilesOne();
    releaseFilesTwo();
    expect(harness.stops[0]).not.toHaveBeenCalled();
    releaseChanges();
    await settle();
    expect(harness.stops[0]).toHaveBeenCalledTimes(1);
    await observer.dispose();
  });

  it("stops on removal and restarts exactly once when a referenced workspace returns", async () => {
    const registry = new FakeRegistry();
    registry.add("app", "/repo/one");
    const harness = watchHarness();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startWatch: harness.start,
    });

    const release = observer.acquire("app", "workspace-files");
    await settle();
    registry.remove("app");
    await settle();
    expect(harness.stops[0]).toHaveBeenCalledTimes(1);

    registry.add("app", "/repo/two");
    await settle();
    expect(harness.starts.map(({ projectDir }) => projectDir)).toEqual(["/repo/one", "/repo/two"]);
    release();
    await observer.dispose();
    expect(harness.stops[1]).toHaveBeenCalledTimes(1);
  });

  it("retires a watcher that finishes opening after its last release", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    let resolveStart!: (stop: () => void) => void;
    const stop = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startWatch: () => new Promise((resolve) => (resolveStart = resolve)),
    });

    const release = observer.acquire("app", "workspace-files");
    await settle();
    release();
    resolveStart(stop);
    await settle();
    expect(stop).toHaveBeenCalledTimes(1);
    await observer.dispose();
  });

  it("awaits an in-flight start and late stop during disposal", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    let resolveStart!: (stop: () => void) => void;
    const stop = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startWatch: () => new Promise((resolve) => (resolveStart = resolve)),
    });
    observer.acquire("app", "workspace-files");
    await settle();

    let disposed = false;
    const disposing = observer.dispose().then(() => {
      disposed = true;
    });
    await settle();
    expect(disposed).toBe(false);
    resolveStart(stop);
    await disposing;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("awaits a late start even when the final release removed its entry before disposal", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    let resolveStart!: (stop: () => void) => void;
    const stop = vi.fn();
    const observer = new WorkspaceResourceObserver({
      registry,
      emit: vi.fn(),
      startWatch: () => new Promise((resolve) => (resolveStart = resolve)),
    });
    const release = observer.acquire("app", "workspace-files");
    await settle();
    release();

    let disposed = false;
    const disposing = observer.dispose().then(() => {
      disposed = true;
    });
    await settle();
    expect(disposed).toBe(false);
    resolveStart(stop);
    await disposing;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("contains a synchronous watcher failure and can retry on later demand", async () => {
    const registry = new FakeRegistry();
    registry.add("app");
    const stop = vi.fn();
    const start = vi
      .fn<StartWorkspaceWatch>()
      .mockImplementationOnce(() => {
        throw new Error("native watcher unavailable");
      })
      .mockResolvedValueOnce(stop);
    const observer = new WorkspaceResourceObserver({ registry, emit: vi.fn(), startWatch: start });

    const releaseOne = observer.acquire("app", "workspace-files");
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
    releaseOne();
    const releaseTwo = observer.acquire("app", "workspace-files");
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
    releaseTwo();
    await observer.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
