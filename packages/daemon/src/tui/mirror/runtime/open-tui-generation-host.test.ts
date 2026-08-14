import { describe, expect, it, vi } from "vitest";
import type { ApplicationShellSessionState } from "@tmux-ide/daemon-client/application-shell-session";

import type { OpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import type { OpenTuiWorkspaceRuntimePort } from "../open-tui-workspace-runtime-port.ts";
import { DaemonAuthorityRebindCoordinator } from "./daemon-authority-rebind.ts";
import {
  createOpenTuiGenerationHost,
  type OpenTuiGenerationBundle,
  type OpenTuiProductionWorkspaceClient,
} from "./open-tui-generation-host.ts";
import type { OpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import type { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import type { OpenTuiWorkspaceTerminalFastLane } from "./workspace-terminal-fast-lane.ts";

type LifecycleListener = (snapshot: { readonly shell: ApplicationShellSessionState }) => void;

function loading(instanceId: string): ApplicationShellSessionState {
  return {
    status: "loading",
    generation: 1,
    target: {
      daemon: {
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId,
        startedAt: "2026-08-14T08:00:00.000Z",
      },
      workspaceName: "workspace.alpha",
    },
    data: null,
    updatedAt: null,
  };
}

function mismatch(instanceId: string): ApplicationShellSessionState {
  return {
    ...loading(instanceId),
    status: "degraded",
    code: "daemon-identity-mismatch",
    reason: "daemon restarted",
  };
}

function liveEmpty(instanceId: string): ApplicationShellSessionState {
  return {
    ...loading(instanceId),
    status: "live",
    updatedAt: 1,
    data: {
      terminalInventory: { activeResourceId: null, resources: [] },
    },
  } as unknown as ApplicationShellSessionState;
}

function connection(instanceId: string, dispose = vi.fn()): OpenTuiApplicationShellConnection {
  return {
    workspaceName: "workspace.alpha",
    target: {
      daemon: {
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId,
        startedAt: "2026-08-14T08:00:00.000Z",
      },
      workspaceName: "workspace.alpha",
    },
    transport: {} as OpenTuiApplicationShellConnection["transport"],
    routing: null,
    dispose,
  };
}

function presentation() {
  const adopt = vi.fn(() => vi.fn());
  const clear = vi.fn();
  const dispose = vi.fn();
  return {
    value: {
      adopt,
      clear,
      dispose,
    } as unknown as OpenTuiRuntimeLayoutPresentation,
    adopt,
    clear,
    dispose,
  };
}

const inertCanonicalObserver = async (): Promise<() => void> => () => undefined;
const flushHostStart = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function canonicalObserver() {
  let listener: ((daemonGeneration: string) => void) | null = null;
  const stop = vi.fn();
  return {
    observe: vi.fn(async (next: (daemonGeneration: string) => void) => {
      listener = next;
      return stop;
    }),
    emit(daemonGeneration: string) {
      listener?.(daemonGeneration);
    },
    stop,
  };
}

interface FakeBundle extends OpenTuiGenerationBundle {
  readonly emitLifecycle: (state: ApplicationShellSessionState) => void;
  readonly activate: () => void;
  readonly retireRuntime: () => void;
  readonly revokeSpy: ReturnType<typeof vi.fn>;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
}

function bundle(
  nextConnection: OpenTuiApplicationShellConnection,
  callbacks: {
    readonly didActivateRuntime: (runtime: OpenTuiWorkspaceRuntimePort) => void;
    readonly didRetireRuntime: () => void;
  },
): FakeBundle {
  const listeners = new Set<LifecycleListener>();
  const disposeSpy = vi.fn();
  const revokeSpy = vi.fn();
  const client = {
    getSnapshot: () => ({ target: nextConnection.target }),
    subscribe(scope: string, listener: LifecycleListener) {
      if (scope === "lifecycle") {
        listeners.add(listener);
        listener({ shell: loading(nextConnection.target.daemon.instanceId) });
      }
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
  } as unknown as OpenTuiProductionWorkspaceClient;
  const fastLane = { lane: {}, dispose: vi.fn() } as unknown as OpenTuiWorkspaceTerminalFastLane;
  const adapter = { dispose: vi.fn() } as unknown as TerminalFastLaneRendererAdapter;
  const runtime = {
    generation: nextConnection.target.daemon.instanceId,
  } as unknown as OpenTuiWorkspaceRuntimePort;
  return {
    connection: nextConnection,
    client,
    fastLane,
    adapter,
    revokeSpy,
    disposeSpy,
    emitLifecycle: (state) => {
      for (const listener of [...listeners]) listener({ shell: state });
    },
    activate: () => callbacks.didActivateRuntime(runtime),
    retireRuntime: callbacks.didRetireRuntime,
    revoke: revokeSpy,
    dispose: disposeSpy,
  };
}

describe("OpenTUI generation host", () => {
  it("publishes only after coherent runtime activation", async () => {
    const view = presentation();
    const firstConnection = connection("daemon-a");
    let created!: FakeBundle;
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => firstConnection),
      buildBundle: (resolved, callbacks) => (created = bundle(resolved, callbacks)),
    });
    const states: string[] = [];
    host.subscribe((snapshot) => states.push(snapshot.status));

    const started = host.start();
    await flushHostStart();
    expect(host.getSnapshot().status).toBe("connecting");
    expect(host.getSnapshot().adapter).toBeNull();

    created.activate();
    expect(await started).toBe(true);
    expect(host.getSnapshot()).toMatchObject({
      status: "live",
      rendererEpoch: 1,
      daemonGeneration: "daemon-a",
      adapter: created.adapter,
      client: created.client,
    });
    expect(states).toEqual(["unavailable", "connecting", "live"]);
    expect(view.adopt).toHaveBeenCalledOnce();
  });

  it("retains the old bundle until an event-driven identity rebind activates", async () => {
    const scheduled: Array<() => void> = [];
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => connections.shift() ?? null),
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
      createRebindCoordinator: () =>
        new DaemonAuthorityRebindCoordinator({
          schedule: (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
          },
          cancel: vi.fn(),
        }),
    });

    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;
    bundles[0]!.emitLifecycle(mismatch("daemon-a"));
    expect(host.getSnapshot()).toMatchObject({ status: "rebinding", daemonGeneration: "daemon-a" });
    expect(bundles[0]!.disposeSpy).not.toHaveBeenCalled();
    expect(bundles[0]!.revokeSpy).toHaveBeenCalledOnce();

    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(bundles).toHaveLength(2);
    expect(host.getSnapshot().daemonGeneration).toBe("daemon-a");
    expect(bundles[0]!.disposeSpy).not.toHaveBeenCalled();

    bundles[1]!.activate();
    expect(host.getSnapshot()).toMatchObject({
      status: "live",
      rendererEpoch: 2,
      daemonGeneration: "daemon-b",
    });
    expect(bundles[0]!.disposeSpy).toHaveBeenCalledOnce();
    expect(view.adopt).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated degradation and clears through runtime retirement", async () => {
    const view = presentation();
    let created!: FakeBundle;
    const resolveConnection = vi.fn(async () => connection("daemon-a"));
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection,
      buildBundle: (resolved, callbacks) => (created = bundle(resolved, callbacks)),
    });

    const started = host.start();
    await flushHostStart();
    created.activate();
    await started;
    created.emitLifecycle({ ...mismatch("daemon-a"), code: "schema-invalid" });
    expect(host.getSnapshot().status).toBe("live");
    expect(resolveConnection).toHaveBeenCalledOnce();

    created.retireRuntime();
    expect(view.clear).toHaveBeenCalledOnce();
    expect(host.getSnapshot().status).toBe("empty");
  });

  it("terminalizes authoritative empty inventory without waiting for a runtime", async () => {
    const view = presentation();
    let created!: FakeBundle;
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => connection("daemon-a")),
      buildBundle: (resolved, callbacks) => (created = bundle(resolved, callbacks)),
    });

    const started = host.start();
    await flushHostStart();
    created.emitLifecycle(liveEmpty("daemon-a"));

    expect(await started).toBe(true);
    expect(host.getSnapshot()).toMatchObject({ status: "empty", daemonGeneration: "daemon-a" });
    expect(view.adopt).not.toHaveBeenCalled();
  });

  it("rejects a non-identity terminal failure while retaining a previous active frame", async () => {
    const scheduled: Array<() => void> = [];
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => connections.shift() ?? null),
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
      createRebindCoordinator: () =>
        new DaemonAuthorityRebindCoordinator({
          schedule: (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
          },
          cancel: vi.fn(),
        }),
    });
    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;
    bundles[0]!.emitLifecycle(mismatch("daemon-a"));
    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    bundles[1]!.emitLifecycle({ ...mismatch("daemon-b"), code: "schema-invalid" });
    await Promise.resolve();
    expect(bundles[1]!.disposeSpy).toHaveBeenCalledOnce();
    expect(host.getSnapshot()).toMatchObject({
      status: "rebinding",
      daemonGeneration: "daemon-a",
      adapter: bundles[0]!.adapter,
    });
    expect(view.clear).not.toHaveBeenCalled();
  });

  it("retires an identity-mismatched preparing candidate so rebind cannot deadlock", async () => {
    const scheduled: Array<() => void> = [];
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => connections.shift() ?? null),
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
      createRebindCoordinator: () =>
        new DaemonAuthorityRebindCoordinator({
          schedule: (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
          },
          cancel: vi.fn(),
        }),
    });
    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;
    bundles[0]!.emitLifecycle(mismatch("daemon-a"));
    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    bundles[1]!.emitLifecycle(mismatch("daemon-b"));
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(bundles[1]!.disposeSpy).toHaveBeenCalledOnce();
    expect(host.getSnapshot()).toMatchObject({ status: "rebinding", daemonGeneration: "daemon-a" });
    expect(scheduled).toHaveLength(1);
  });

  it("disposes pending and active generations exactly once and fences late activation", async () => {
    const scheduled: Array<() => void> = [];
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: inertCanonicalObserver,
      resolveConnection: vi.fn(async () => connections.shift() ?? null),
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
      createRebindCoordinator: () =>
        new DaemonAuthorityRebindCoordinator({
          schedule: (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
          },
          cancel: vi.fn(),
        }),
    });
    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;
    bundles[0]!.emitLifecycle(mismatch("daemon-a"));
    scheduled.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    host.dispose();
    expect(bundles[0]!.disposeSpy).toHaveBeenCalledOnce();
    expect(bundles[1]!.disposeSpy).toHaveBeenCalledOnce();
    expect(view.dispose).toHaveBeenCalledOnce();
    bundles[1]!.activate();
    expect(host.getSnapshot().status).toBe("disposed");
    host.dispose();
    expect(bundles[0]!.disposeSpy).toHaveBeenCalledOnce();
    expect(bundles[1]!.disposeSpy).toHaveBeenCalledOnce();
  });

  it("does not reconnect for silence or an event carrying the same canonical record", async () => {
    const observer = canonicalObserver();
    const view = presentation();
    const resolveConnection = vi.fn(async () => connection("daemon-a"));
    let created!: FakeBundle;
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: observer.observe,
      resolveConnection,
      buildBundle: (resolved, callbacks) => (created = bundle(resolved, callbacks)),
    });
    const started = host.start();
    await flushHostStart();
    created.activate();
    await started;

    expect(resolveConnection).toHaveBeenCalledOnce();
    observer.emit("daemon-a");
    await flushHostStart();
    expect(resolveConnection).toHaveBeenCalledOnce();
    expect(created.revokeSpy).not.toHaveBeenCalled();
  });

  it("revokes once and atomically replaces on a new canonical generation", async () => {
    const observer = canonicalObserver();
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const resolveConnection = vi.fn(async () => connections.shift() ?? null);
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: observer.observe,
      resolveConnection,
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
    });
    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;

    observer.emit("daemon-b");
    expect(bundles[0]!.revokeSpy).toHaveBeenCalledOnce();
    expect(host.getSnapshot()).toMatchObject({ status: "rebinding", daemonGeneration: "daemon-a" });
    await flushHostStart();
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(bundles[0]!.disposeSpy).not.toHaveBeenCalled();

    bundles[1]!.activate();
    expect(host.getSnapshot()).toMatchObject({ status: "live", daemonGeneration: "daemon-b" });
    expect(bundles[0]!.disposeSpy).toHaveBeenCalledOnce();
  });

  it("deduplicates daemon.json replacement bursts into one fresh connection flight", async () => {
    const observer = canonicalObserver();
    const view = presentation();
    const connections = [connection("daemon-a"), connection("daemon-b")];
    const bundles: FakeBundle[] = [];
    const resolveConnection = vi.fn(async () => connections.shift() ?? null);
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: observer.observe,
      resolveConnection,
      buildBundle: (resolved, callbacks) => {
        const created = bundle(resolved, callbacks);
        bundles.push(created);
        return created;
      },
    });
    const started = host.start();
    await flushHostStart();
    bundles[0]!.activate();
    await started;

    observer.emit("daemon-b");
    observer.emit("daemon-b");
    observer.emit("daemon-b");
    await flushHostStart();
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]!.revokeSpy).toHaveBeenCalledOnce();
  });

  it("stops canonical observation and fences late callbacks on dispose", async () => {
    const observer = canonicalObserver();
    const view = presentation();
    const resolveConnection = vi.fn(async () => connection("daemon-a"));
    let created!: FakeBundle;
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration: observer.observe,
      resolveConnection,
      buildBundle: (resolved, callbacks) => (created = bundle(resolved, callbacks)),
    });
    const started = host.start();
    await flushHostStart();
    created.activate();
    await started;

    host.dispose();
    expect(observer.stop).toHaveBeenCalledOnce();
    observer.emit("daemon-b");
    await flushHostStart();
    expect(resolveConnection).toHaveBeenCalledOnce();
    expect(host.getSnapshot().status).toBe("disposed");
  });

  it("stops an observer that finishes installing after host disposal", async () => {
    const view = presentation();
    const stop = vi.fn();
    let finishInstall!: (stopObserver: () => void) => void;
    const observeCanonicalGeneration = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const resolveConnection = vi.fn(async () => connection("daemon-a"));
    const host = createOpenTuiGenerationHost("alpha", view.value, {
      observeCanonicalGeneration,
      resolveConnection,
      buildBundle: (resolved, callbacks) => bundle(resolved, callbacks),
    });

    const started = host.start();
    await Promise.resolve();
    host.dispose();
    finishInstall(stop);

    expect(await started).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(resolveConnection).not.toHaveBeenCalled();
  });
});
