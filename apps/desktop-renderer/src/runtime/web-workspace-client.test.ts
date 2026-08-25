import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApplicationShellTarget,
  DesktopDaemonEvent,
  HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createWebWorkspaceOwnerActionPort,
  createWebWorkspaceCatalogPort,
  createWebWorkspaceRuntimeBridgePorts,
  submitWebWorkspaceSemanticIntent,
} from "./web-workspace-client.ts";
import { createWebWorkspacePaneStreamBridge } from "./web-workspace-pane-stream-bridge.ts";
import type {
  WebWorkspaceRuntimeOptions,
  WebWorkspaceRuntimePort,
} from "./web-workspace-runtime.ts";

const OPERATION = "10000000-0000-4000-8000-000000000001";
const GENERATION = "20000000-0000-4000-8000-000000000001";
const TARGET = {
  daemon: {
    protocolVersion: 1,
    productVersion: "test",
    instanceId: GENERATION,
    startedAt: "2026-08-23T00:00:00.000Z",
  },
  workspaceName: "workspace-a",
} satisfies DesktopApplicationShellTarget;

describe("Web WorkspaceClient owner action binding", () => {
  it("activates a candidate from one authoritative replay and retires prior panes", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const captures: WebWorkspaceRuntimeOptions[] = [];
    const connect = vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
      captures.push(options);
      return {
        generation: GENERATION,
        closed: new Promise<unknown>(() => undefined),
        close: vi.fn(),
      } as unknown as WebWorkspaceRuntimePort;
    });
    const ports = createWebWorkspaceRuntimeBridgePorts({
      host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
      bridge,
      connect,
    });
    const inventory = {
      workspaceName: "workspace-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      daemonGeneration: GENERATION,
      shellGeneration: 1,
      semanticPaneIds: ["pane.primary"],
    };
    const a = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[0]!.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
    });
    ports.didActivateRuntime?.(a, inventory);
    const events: Array<{ pane: string; type: string; byte: number | undefined }> = [];
    await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.primary"] },
      {
        onPaneEvent: (pane, event) => {
          events.push({
            pane,
            type: event.type,
            byte:
              event.type === "seed-batch"
                ? event.batch.seed[0]
                : event.type === "output"
                  ? event.bytes[0]
                  : undefined,
          });
        },
        onEnd: vi.fn(),
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const b = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([2]), held: [], cursor: null },
    });
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "output",
      bytes: new Uint8Array([9]),
      replay: () => ({ reset: null, seed: new Uint8Array([3]), held: [], cursor: null }),
    });
    captures[1]!.onPaneEvent?.("pane.primary", { type: "cursor", x: 7, y: 8 });
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    ports.didActivateRuntime?.(b, inventory);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      { pane: "pane.primary", type: "seed-batch", byte: 1 },
      { pane: "pane.primary", type: "seed-batch", byte: 3 },
    ]);

    const removed = { ...inventory, semanticPaneIds: ["pane.secondary"] };
    const c = await ports.connectRuntime(
      TARGET,
      removed,
      new AbortController().signal,
      async () => undefined,
    );
    captures[2]!.onPaneEvent?.("pane.secondary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([4]), held: [], cursor: null },
    });
    ports.didActivateRuntime?.(c, removed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toEqual({ pane: "pane.primary", type: "closed", byte: undefined });
  });

  it("fences late runtime A end from active B and closes a rejected candidate", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const captures: WebWorkspaceRuntimeOptions[] = [];
    const runtimes: Array<WebWorkspaceRuntimePort & { close: ReturnType<typeof vi.fn> }> = [];
    const sessionPresence: Array<ReturnType<typeof vi.fn>> = [];
    const connect = vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
      captures.push(options);
      const close = vi.fn();
      const runtime = {
        generation: GENERATION,
        closed: new Promise<unknown>(() => undefined),
        close,
      } as unknown as WebWorkspaceRuntimePort & { close: ReturnType<typeof vi.fn> };
      runtimes.push(runtime);
      const updatePresence = vi.fn();
      sessionPresence.push(updatePresence);
      options.onSession?.({ dispose: vi.fn(), updatePresence });
      return runtime;
    });
    const ports = createWebWorkspaceRuntimeBridgePorts({
      host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
      bridge,
      connect,
    });
    const inventory = {
      workspaceName: "workspace-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      daemonGeneration: GENERATION,
      shellGeneration: 1,
      semanticPaneIds: ["pane.primary"],
    };
    const a = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    ports.didActivateRuntime?.(a, inventory);
    const b = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    ports.didActivateRuntime?.(b, inventory);
    captures[0]?.onEnd?.(new Error("late A"));
    const paneEvent = vi.fn();
    const layout = vi.fn();
    const connected = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.primary"] },
      { onPaneEvent: paneEvent, onLayout: layout, onEnd: vi.fn() },
    );
    expect(connected).toMatchObject({ status: "connected" });
    captures[0]?.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([8]), held: [], cursor: null },
    });
    captures[0]?.onLayout?.({
      semanticWindowId: "window.late-a",
      windowName: "late-a",
      currentWindow: true,
      cols: 80,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [],
    });
    const latePresence = vi.fn();
    captures[0]?.onSession?.({ dispose: vi.fn(), updatePresence: latePresence });
    await Promise.resolve();
    expect(paneEvent).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    if (connected.status !== "connected") throw new Error("bridge did not connect");
    connected.session.updatePresence?.("background");
    expect(sessionPresence[1]).toHaveBeenCalledWith("background");
    expect(latePresence).not.toHaveBeenCalled();

    await expect(
      ports.connectRuntime(TARGET, inventory, new AbortController().signal, async () => {
        throw new Error("prepare rejected");
      }),
    ).rejects.toThrow("prepare rejected");
    expect(runtimes.at(-1)?.close).toHaveBeenCalledTimes(1);
  });

  it("reads one coherent catalog and invalidates only its exact global resource", async () => {
    const subscription = {
      listener: null as ((event: DesktopDaemonEvent) => void) | null,
    };
    const invalidate = vi.fn();
    const unsubscribe = vi.fn();
    const host = {
      daemon: {
        fetchWorkspaceCatalog: vi.fn(async () => ({
          status: "ok" as const,
          envelope: {
            version: 2 as const,
            daemon: TARGET.daemon,
            intents: [
              {
                workspaceName: "workspace-a",
                sessionName: "session-a",
                source: "project" as const,
                availability: "live" as const,
              },
            ],
            liveSessions: [
              { sessionName: "session-a", fleetSessionId: "fleet.session-a", paneCount: 2 },
            ],
          },
        })),
        subscribe: vi.fn(async (_request, next) => {
          subscription.listener = next;
          return { status: "subscribed" as const, unsubscribe };
        }),
      },
    } as unknown as HostCapabilities;
    const port = createWebWorkspaceCatalogPort(host);
    await expect(port.read(TARGET, new AbortController().signal)).resolves.toMatchObject({
      version: 2,
      intents: [{ workspaceName: "workspace-a" }],
    });
    const connection = port.subscribe(TARGET, invalidate);
    await Promise.resolve();
    subscription.listener?.({ type: "workspaces.changed" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    connection.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("preserves one operation id and current target through pane and semantic dispatch", async () => {
    const createWorkspacePane = vi.fn(async (request: { operationId?: string }) => ({
      status: "ok" as const,
      result: {
        operationId: request.operationId!,
        daemonInstanceId: GENERATION,
        outcome: "created" as const,
        resource: {
          resourceVersion: 1 as const,
          workspaceName: "workspace-a",
          semanticPaneId: "pane.created",
          displayTitle: "Shell",
          kind: "terminal" as const,
          harnessProfileId: null,
          role: null,
          missionId: null,
        },
      },
    }));
    const invokeVerb = vi.fn(async (request: { operationId?: string }) => ({
      status: "ok" as const,
      result: {
        operationId: request.operationId!,
        daemonInstanceId: GENERATION,
        outcome: "applied" as const,
        workspaceName: "workspace-a",
        verb: "workspace.pane.select" as const,
        semanticPaneId: "pane.primary",
      },
    }));
    const host = {
      daemon: { createWorkspacePane, invokeVerb },
      workspace: {},
    } as unknown as HostCapabilities;
    const actions = createWebWorkspaceOwnerActionPort(host);
    const pane = await actions.dispatch({
      target: TARGET,
      name: "workspace.pane.create",
      operationId: OPERATION,
      input: { kind: "terminal", workspaceName: "workspace-a", displayTitle: "Shell" },
    });
    expect(pane?.operationId).toBe(OPERATION);
    expect(createWorkspacePane.mock.calls[0]?.[0]).toMatchObject({ operationId: OPERATION });

    await submitWebWorkspaceSemanticIntent(host, GENERATION, "workspace-a", OPERATION, {
      verb: "workspace.pane.select",
      workspaceName: "workspace-a",
      semanticPaneId: "pane.primary",
    });
    expect(invokeVerb.mock.calls[0]?.[0]).toMatchObject({ operationId: OPERATION });
  });

  it("binds prepare/commit/cancel tokens and operation ids without exposing the selected path", async () => {
    const prepareToken = "30000000-0000-4000-8000-000000000001";
    const prepareProjectDirectory = vi.fn(
      async (_previous: string | null, operationId?: string) => ({
        status: "ok" as const,
        result: {
          operationId: operationId!,
          daemonInstanceId: GENERATION,
          phase: "prepared" as const,
          prepareToken,
          preparedRevision: 7,
          outcome: "created" as const,
          workspaceName: "workspace-b",
          previousWorkspaceName: "workspace-a",
          proof: {
            semanticPaneId: "pane.primary",
            paneCount: 1,
            terminalRevision: 0,
            terminalStateHash: "0123456789abcdef",
          },
        },
      }),
    );
    const commitPreparedOpen = vi.fn(async (decision, operationId?: string) => ({
      status: "ok" as const,
      result: {
        operationId: operationId!,
        daemonInstanceId: GENERATION,
        phase: "committed" as const,
        ...decision,
        workspaceName: "workspace-b",
        previousWorkspaceName: "workspace-a",
      },
    }));
    const cancelPreparedOpen = vi.fn(async (decision, operationId?: string) => ({
      status: "ok" as const,
      result: {
        operationId: operationId!,
        daemonInstanceId: GENERATION,
        phase: "cancelled" as const,
        ...decision,
        workspaceName: "workspace-b",
        previousWorkspaceName: "workspace-a",
      },
    }));
    const actions = createWebWorkspaceOwnerActionPort({
      workspace: { prepareProjectDirectory, commitPreparedOpen, cancelPreparedOpen },
      daemon: {},
    } as unknown as HostCapabilities);
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.prepare",
      operationId: OPERATION,
      input: { source: { kind: "host-selection" }, previousWorkspaceName: "workspace-a" },
    });
    expect(prepareProjectDirectory).toHaveBeenCalledWith("workspace-a", OPERATION);
    expect(JSON.stringify(prepareProjectDirectory.mock.calls)).not.toMatch(/projectDir|\/Users\//u);
    const decision = { prepareToken, preparedRevision: 7 };
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.commit",
      operationId: OPERATION,
      input: decision,
    });
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.cancel",
      operationId: OPERATION,
      input: decision,
    });
    expect(commitPreparedOpen).toHaveBeenCalledWith(decision, OPERATION);
    expect(cancelPreparedOpen).toHaveBeenCalledWith(decision, OPERATION);
  });

  it("rejects cross-workspace actions before invoking the issued host capability", async () => {
    const createWorkspacePane = vi.fn();
    const actions = createWebWorkspaceOwnerActionPort({
      daemon: { createWorkspacePane },
      workspace: {},
    } as unknown as HostCapabilities);
    await expect(
      actions.dispatch({
        target: TARGET,
        name: "workspace.pane.create",
        operationId: OPERATION,
        input: { kind: "terminal", workspaceName: "workspace-b" },
      }),
    ).rejects.toThrow(/another workspace/u);
    expect(createWorkspacePane).not.toHaveBeenCalled();
  });
});
