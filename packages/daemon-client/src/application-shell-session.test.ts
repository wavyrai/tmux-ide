import { describe, expect, it } from "bun:test";
import {
  ApplicationShellProjectionInputV3SchemaZ,
  COHESION_FIXTURE_V1,
  DesktopApplicationShellTargetSchemaZ,
  type ApplicationShellProjectionInputV1,
  type DesktopApplicationShellTarget,
} from "@tmux-ide/contracts";

import {
  createApplicationShellSession,
  type ApplicationShellEventHandlers,
  type ApplicationShellTransport,
} from "./application-shell-session.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-09T12:00:00.000Z",
};

function target(workspaceName: string): DesktopApplicationShellTarget {
  return { daemon, workspaceName };
}

function resource(name: string): ApplicationShellProjectionInputV1 {
  return ApplicationShellProjectionInputV3SchemaZ.parse({
    project: { ...COHESION_FIXTURE_V1.project, name },
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
          ...agent,
          paneId: null,
        })),
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
    terminalInventory: { activeResourceId: null, resources: [] },
    appWindows: {
      version: 1,
      revision: 0,
      updatedAt: "2026-08-09T12:00:00.000Z",
      windows: {},
      dockRoot: null,
      dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
      floatingOrder: [],
      focusedWindowId: null,
      activeLayoutId: null,
      layouts: {},
    },
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ConnectionRecord {
  readonly target: DesktopApplicationShellTarget;
  readonly handlers: ApplicationShellEventHandlers;
  closed: boolean;
}

function broker(initial: Readonly<Record<string, ApplicationShellProjectionInputV1>>) {
  const resources = new Map(Object.entries(initial));
  const fetches: string[] = [];
  const connections: ConnectionRecord[] = [];
  const transport: ApplicationShellTransport = {
    validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
    fetchApplicationShell: async (applicationTarget) => {
      fetches.push(applicationTarget.workspaceName);
      const snapshot = resources.get(applicationTarget.workspaceName);
      if (!snapshot) throw new Error(`missing ${applicationTarget.workspaceName}`);
      return snapshot;
    },
    connectEvents: (applicationTarget, handlers) => {
      const connection = { target: applicationTarget, handlers, closed: false };
      connections.push(connection);
      return { close: () => (connection.closed = true) };
    },
  };
  return { resources, fetches, connections, transport };
}

describe("shared application-shell session", () => {
  it("keeps multiple clients isolated while converging invalidated authority", async () => {
    const runtime = broker({ alpha: resource("alpha-1"), beta: resource("beta-1") });
    const alphaReceipts: string[] = [];
    const betaReceipts: string[] = [];
    const alpha = createApplicationShellSession({
      target: target("alpha"),
      transport: runtime.transport,
      onOperationAcknowledged: (receipt) => alphaReceipts.push(receipt.operationId),
    });
    const beta = createApplicationShellSession({
      target: target("beta"),
      transport: runtime.transport,
      onOperationAcknowledged: (receipt) => betaReceipts.push(receipt.operationId),
    });
    runtime.connections[0]!.handlers.onVerifiedOpen();
    runtime.connections[1]!.handlers.onVerifiedOpen();
    await settle();

    expect(alpha.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "alpha-1" } },
    });
    expect(beta.getState()).toMatchObject({
      status: "live",
      data: { project: { name: "beta-1" } },
    });

    runtime.resources.set("alpha", resource("alpha-2"));
    runtime.connections[0]!.handlers.onInvalidate();
    runtime.connections[0]!.handlers.onOperationAcknowledged?.({
      daemonInstanceId: daemon.instanceId,
      operationId: "op-alpha",
      sequence: 7,
      revision: 3,
    });
    await settle();
    await settle();

    expect(alpha.getState()).toMatchObject({ data: { project: { name: "alpha-2" } } });
    expect(beta.getState()).toMatchObject({ data: { project: { name: "beta-1" } } });
    expect(runtime.fetches).toEqual(["alpha", "beta", "alpha"]);
    expect(alphaReceipts).toEqual(["op-alpha"]);
    expect(betaReceipts).toEqual([]);
    expect(alpha.getMetrics()).toMatchObject({
      idleWakeups: 0,
      activeInterests: 1,
      fetchesStarted: 2,
      fetchesSettled: 2,
      invalidationsObserved: 1,
      subscriptionsOpened: 1,
    });
    alpha.dispose();
    beta.dispose();
  });

  it("retires the old request and event connection across target generations", async () => {
    const requests: Array<ReturnType<typeof deferred<ApplicationShellProjectionInputV1>>> = [];
    const signals: AbortSignal[] = [];
    const connections: ConnectionRecord[] = [];
    const transport: ApplicationShellTransport = {
      validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
      fetchApplicationShell: (_applicationTarget, signal) => {
        const request = deferred<ApplicationShellProjectionInputV1>();
        requests.push(request);
        signals.push(signal);
        return request.promise;
      },
      connectEvents: (applicationTarget, handlers) => {
        const connection = { target: applicationTarget, handlers, closed: false };
        connections.push(connection);
        return { close: () => (connection.closed = true) };
      },
    };
    const session = createApplicationShellSession({ target: target("alpha"), transport });
    const firstGeneration = session.getState().generation;

    session.setTarget(target("beta"));
    expect(signals[0]?.aborted).toBe(true);
    expect(connections[0]?.closed).toBe(true);
    requests[0]!.resolve(resource("stale-alpha"));
    connections[0]!.handlers.onVerifiedOpen();
    connections[0]!.handlers.onInvalidate();
    requests[1]!.resolve(resource("current-beta"));
    connections[1]!.handlers.onVerifiedOpen();
    await settle();

    expect(session.getState()).toMatchObject({
      status: "live",
      generation: firstGeneration + 1,
      target: { workspaceName: "beta" },
      data: { project: { name: "current-beta" } },
    });
    session.dispose();
    expect(connections[1]?.closed).toBe(true);
  });
});
