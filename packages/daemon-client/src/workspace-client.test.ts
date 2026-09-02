import { describe, expect, it } from "bun:test";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellProjectionInputV3SchemaZ,
  COHESION_FIXTURE_V1,
  DAEMON_WIRE_PROTOCOL_VERSION,
  DesktopApplicationShellTargetSchemaZ,
  applicationShellCommandInvocation,
  type ApplicationShellProjectionInputV3,
  type DesktopApplicationShellTarget,
  type InteractionReceipt,
  type SessionRuntimeTerminalInput,
  type TerminalReplicaAddress,
  type TerminalReplicaUpdate,
} from "@tmux-ide/contracts";

import type {
  WorkspaceClient,
  ApplicationShellEventHandlers,
  ApplicationShellTransport,
} from "./application-shell-session.ts";
import type { GenerationBoundClock } from "./generation-bound-store.ts";
import {
  createDirectLoopbackDaemonTransport,
  type TerminalFirstDaemonTransport,
} from "./direct-application-shell-transport.ts";
import type {
  WorkspaceEventSocket,
  WorkspaceEventSocketEvent,
  WorkspaceEventSocketEventType,
  WorkspaceEventSocketListener,
} from "./workspace-event-supervisor.ts";
import { createWorkspaceClient } from "./workspace-client.ts";
import { runtimeResourceSnapshot } from "./runtime-resource-ledger.ts";
import {
  createTerminalFastLane,
  createWorkspaceClientTerminalSource,
  type TerminalFastLane,
} from "./terminal-fast-lane.ts";
import { createWorkspaceClientConformanceAdapter } from "./workspace-client-conformance.ts";
import type {
  WorkspaceClientOwnerActionPort,
  WorkspaceClientRuntimeInventory,
  WorkspaceClientRuntimePort,
} from "./workspace-client-types.ts";

const daemon = (instanceId: string) => ({
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId,
  startedAt: "2026-08-14T10:00:00.000Z",
});
const ALPHA_DAEMON = daemon("11111111-1111-4111-8111-111111111111");
const BETA_DAEMON = daemon("22222222-2222-4222-8222-222222222222");

function target(workspaceName: string, identity = ALPHA_DAEMON): DesktopApplicationShellTarget {
  return DesktopApplicationShellTargetSchemaZ.parse({ daemon: identity, workspaceName });
}

function workspaceCatalog(workspaceName: string, identity = ALPHA_DAEMON) {
  return {
    version: 2,
    daemon: identity,
    intents: [
      {
        workspaceName,
        sessionName: workspaceName,
        source: "workspace",
        availability: "live",
      },
    ],
    liveSessions: [
      {
        sessionName: workspaceName,
        fleetSessionId: `session.${workspaceName === "alpha" ? "a" : "b"}`.padEnd(28, "0"),
        paneCount: 1,
      },
    ],
  };
}

function shellResource(
  name: string,
  semanticPaneIds: readonly string[] = [`pane.${name}`],
): ApplicationShellProjectionInputV3 {
  return ApplicationShellProjectionInputV3SchemaZ.parse({
    project: { ...COHESION_FIXTURE_V1.project, name },
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      id: `workspace.${name}`,
      activeMode: "terminals",
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
    terminalInventory: {
      activeResourceId: semanticPaneIds[0] ?? null,
      resources: semanticPaneIds.map((semanticPaneId, index) => ({
        id: semanticPaneId,
        title: `Terminal ${index + 1}`,
        kind: "terminal" as const,
        active: index === 0,
        attachability: { status: "available" as const, semanticPaneId },
      })),
    },
    appWindows: {
      version: 1,
      revision: 7,
      updatedAt: "2026-08-14T10:00:00.000Z",
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

class FakeClock implements GenerationBoundClock {
  nowValue = 1_000;
  nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.nowValue;
  }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowValue + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.nowValue += ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowValue)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

interface ShellConnection {
  readonly target: DesktopApplicationShellTarget;
  readonly handlers: ApplicationShellEventHandlers;
  closed: boolean;
}

function shellBroker(resources: Readonly<Record<string, ApplicationShellProjectionInputV3>>) {
  const byWorkspace = new Map(Object.entries(resources));
  const connections: ShellConnection[] = [];
  const transport: ApplicationShellTransport<ApplicationShellProjectionInputV3> = {
    validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
    fetchApplicationShell: async (current) => {
      const resource = byWorkspace.get(current.workspaceName);
      if (resource === undefined) throw new Error(`missing ${current.workspaceName}`);
      return resource;
    },
    connectEvents: (current, handlers) => {
      const connection = { target: current, handlers, closed: false };
      connections.push(connection);
      return { close: () => (connection.closed = true) };
    },
  };
  return { transport, connections, byWorkspace };
}

class WorkspaceClientEventSocket implements WorkspaceEventSocket {
  readyState = 1;
  readonly sent: unknown[] = [];
  readonly listeners = new Map<WorkspaceEventSocketEventType, Set<WorkspaceEventSocketListener>>();
  addEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: WorkspaceEventSocketEventType, listener: WorkspaceEventSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {}
  emit(type: WorkspaceEventSocketEventType, event: WorkspaceEventSocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  frame(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
}

class FakeTerminalSubscription {
  readonly listeners = new Set<(update: TerminalReplicaUpdate<string, string>) => void>();
  closeCount = 0;
  closeGate: Promise<void> | null = null;
  constructor(readonly generation: string) {}
  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeGate) await this.closeGate;
  }
  freeze(): void {}
  thaw(): void {}
  onUpdate(listener: (update: TerminalReplicaUpdate<string, string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(update: TerminalReplicaUpdate<string, string>): void {
    for (const listener of this.listeners) listener(update);
  }
}

class FakeRuntime implements WorkspaceClientRuntimePort<string, string> {
  readonly closed = new Promise<never>(() => undefined);
  readonly receipts = new Set<(receipt: InteractionReceipt) => void>();
  readonly subscriptions = new Map<string, FakeTerminalSubscription>();
  closeCount = 0;
  submitCount = 0;
  readonly inputs: Array<{
    target: TerminalReplicaAddress;
    input: SessionRuntimeTerminalInput;
    traceId?: string;
  }> = [];
  inputResult: "ok" | "authority-lost" = "ok";
  inputGate: Promise<void> | null = null;
  readonly viewportFits: Array<{ cols: number; rows: number }> = [];
  viewportGate: Promise<void> | null = null;
  viewportResult: "ok" | "geometry-authority-conflict" = "ok";
  authorityGate: Promise<void> | null = null;
  closeGate: Promise<void> | null = null;
  readonly repairRequests: Array<{
    target: TerminalReplicaAddress;
    reason: "gap" | "conflict" | "wrong-address" | "missing-state";
  }> = [];
  constructor(readonly generation: string) {}
  async subscribeTerminal(address: TerminalReplicaAddress): Promise<FakeTerminalSubscription> {
    const subscription = new FakeTerminalSubscription(this.generation);
    this.subscriptions.set(address.semanticPaneId, subscription);
    return subscription;
  }
  async submitIntent(): Promise<void> {
    this.submitCount += 1;
  }
  async sendTerminalInput(
    nextTarget: TerminalReplicaAddress,
    input: SessionRuntimeTerminalInput,
    traceId?: string,
  ): Promise<"ok" | "authority-lost"> {
    if (this.inputGate) await this.inputGate;
    this.inputs.push({ target: nextTarget, input, ...(traceId ? { traceId } : {}) });
    return this.inputResult;
  }
  async fitViewport(cols: number, rows: number): Promise<"ok" | "geometry-authority-conflict"> {
    if (this.viewportGate) await this.viewportGate;
    this.viewportFits.push({ cols, rows });
    return this.viewportResult;
  }
  async requestAuthority(authority: "input" | "focus" | "geometry") {
    if (this.authorityGate) await this.authorityGate;
    return {
      generation: this.generation,
      session: "alpha",
      clientId: "opentui:test",
      authority,
      token: "55555555-5555-4555-8555-555555555555",
      revision: 1,
    } as const;
  }
  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void {
    this.receipts.add(listener);
    return () => this.receipts.delete(listener);
  }
  emitReceipt(receipt: InteractionReceipt): void {
    for (const listener of this.receipts) listener(receipt);
  }
  requestTerminalRepair = (
    nextTarget: TerminalReplicaAddress,
    reason: "gap" | "conflict" | "wrong-address" | "missing-state",
  ): void => {
    this.repairRequests.push({ target: nextTarget, reason });
  };
  async close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeGate) await this.closeGate;
  }
}

class EagerSeedRuntime extends FakeRuntime {
  constructor(
    generation: string,
    private readonly snapshot: string,
  ) {
    super(generation);
  }

  override async subscribeTerminal(
    address: TerminalReplicaAddress,
  ): Promise<FakeTerminalSubscription> {
    const subscription = new FakeTerminalSubscription(this.generation);
    const onUpdate = subscription.onUpdate.bind(subscription);
    subscription.onUpdate = (listener) => {
      const unsubscribe = onUpdate(listener);
      listener({
        ...terminalSeedFor(address.semanticPaneId, this.generation),
        snapshot: this.snapshot,
      });
      return unsubscribe;
    };
    this.subscriptions.set(address.semanticPaneId, subscription);
    return subscription;
  }
}

class ClosableFakeRuntime extends FakeRuntime {
  private readonly closedState = deferred<void>();
  override readonly closed = this.closedState.promise;
  fail(): void {
    this.closedState.resolve();
  }
}

const actions: WorkspaceClientOwnerActionPort = {
  dispatch: async () => null,
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function receipt(operationId: string, phase: InteractionReceipt["phase"]): InteractionReceipt {
  return {
    type: "interaction.receipt",
    sequence: phase === "accepted" ? 1 : 2,
    operationId,
    origin: "sdk",
    workspaceName: "alpha",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.alpha" },
    operationKind: "workspace.pane.send",
    phase,
    summary: {
      operationKind: "workspace.pane.send",
      characterCount: 1,
      byteCount: 1,
      submitted: true,
    },
    proof:
      phase === "observed"
        ? {
            operationKind: "workspace.pane.send",
            observed: true,
            semanticPaneId: "pane.alpha",
          }
        : null,
    at: "2026-08-14T10:00:00.000Z",
    resourceRevision: null,
  };
}

function terminalSeed(generation: string): TerminalReplicaUpdate<string, string> {
  return {
    type: "terminal.seed",
    workspaceName: "alpha",
    semanticPaneId: "pane.alpha",
    generation,
    incarnation: "incarnation-1",
    revision: 0,
    cols: 80,
    rows: 24,
    stateHash: "0000000000000000",
    hashAlgorithm: "fnv1a64-v1",
    snapshot: "terminal bytes stay outside semantic snapshots",
  };
}

function terminalSeedFor(
  semanticPaneId: string,
  generation: string,
): TerminalReplicaUpdate<string, string> {
  return { ...terminalSeed(generation), semanticPaneId };
}

describe("WorkspaceClient", () => {
  it("publishes a bounded degraded state when semantic shell projection rejects", async () => {
    const valid = shellResource("alpha");
    const corrupt = {
      ...valid,
      workspace: {
        ...valid.workspace,
        sidebar: {
          ...valid.workspace.sidebar,
          agents: valid.workspace.sidebar.agents.map((agent, index) =>
            index < 2 ? { ...agent, paneId: "pane.alpha" } : agent,
          ),
        },
      },
    } as ApplicationShellProjectionInputV3;
    const shell = shellBroker({ alpha: corrupt });
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => new FakeRuntime(ALPHA_DAEMON.instanceId),
        actions,
      },
    });

    await settle();
    expect(client.getSnapshot().shell).toMatchObject({
      status: "degraded",
      code: "schema-invalid",
      data: null,
      reason: "The application shell failed semantic projection.",
    });
    expect(client.getSnapshot().semantic).toBeNull();
    await client.dispose();
  });

  it("defers application-shell until terminal authority adopts through runtime staging", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return runtime;
        },
        actions,
      },
    });
    await settle();
    expect(shell.connections).toHaveLength(0);
    expect(inventories).toHaveLength(0);

    expect(
      client.adoptTerminalRuntimeInventory({
        workspaceName: "alpha",
        workspaceId: "workspace.alpha",
        sessionId: COHESION_FIXTURE_V1.workspace.session.id,
        resourceRevision: 7,
        semanticPaneIds: ["pane.alpha"],
      }),
    ).toBe(true);
    await settle();
    expect(inventories).toHaveLength(1);
    expect(inventories[0]).toMatchObject({
      terminalResourceRevision: 7,
      shellGeneration: 1,
      semanticPaneIds: ["pane.alpha"],
    });
    expect(shell.connections).toHaveLength(1);
    await client.dispose();
  });

  it("never lets late V2 topology roll back a newer terminal revision", async () => {
    const lateV2 = deferred<ApplicationShellProjectionInputV3>();
    const shellConnections: ShellConnection[] = [];
    const shellTransport: ApplicationShellTransport<ApplicationShellProjectionInputV3> = {
      validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
      fetchApplicationShell: () => lateV2.promise,
      connectEvents: (current, handlers) => {
        shellConnections.push({ target: current, handlers, closed: false });
        return { close: () => undefined };
      },
    };
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shellTransport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return new FakeRuntime(ALPHA_DAEMON.instanceId);
        },
        actions,
      },
    });
    const base = {
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
    };
    client.adoptTerminalRuntimeInventory({
      ...base,
      resourceRevision: 1,
      semanticPaneIds: ["pane.a"],
    });
    client.adoptTerminalRuntimeInventory({
      ...base,
      resourceRevision: 2,
      semanticPaneIds: ["pane.b"],
    });
    lateV2.resolve(shellResource("alpha", ["pane.a"]));
    await settle();
    expect(inventories.map((inventory) => inventory.semanticPaneIds)).toEqual([
      ["pane.a"],
      ["pane.b"],
    ]);
    expect(
      client.adoptTerminalRuntimeInventory({
        ...base,
        resourceRevision: 1,
        semanticPaneIds: ["pane.a"],
      }),
    ).toBe(false);
    await client.dispose();
  });

  it("treats V2 mismatch as a terminal-authority refresh request only", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.b"]) });
    let refreshes = 0;
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return new FakeRuntime(ALPHA_DAEMON.instanceId);
        },
        requestTerminalRuntimeInventoryRefresh: () => {
          refreshes += 1;
        },
        actions,
      },
    });
    client.adoptTerminalRuntimeInventory({
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
      resourceRevision: 1,
      semanticPaneIds: ["pane.a"],
    });
    await settle();
    expect(inventories.map((inventory) => inventory.semanticPaneIds)).toEqual([["pane.a"]]);
    expect(refreshes).toBe(1);
    for (let index = 0; index < 2_000; index += 1) {
      expect(
        client.adoptTerminalRuntimeInventory({
          workspaceName: "alpha",
          workspaceId: "workspace.alpha",
          sessionId: COHESION_FIXTURE_V1.workspace.session.id,
          resourceRevision: 1,
          semanticPaneIds: ["pane.a"],
        }),
      ).toBe(true);
    }
    await settle();
    expect(refreshes).toBe(1);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.c"]));
    shell.connections.at(-1)?.handlers.onInvalidate();
    await settle();
    expect(refreshes).toBe(2);

    expect(
      client.adoptTerminalRuntimeInventory({
        workspaceName: "alpha",
        workspaceId: "workspace.alpha",
        sessionId: COHESION_FIXTURE_V1.workspace.session.id,
        resourceRevision: 2,
        semanticPaneIds: ["pane.c"],
      }),
    ).toBe(true);
    await settle();
    expect(refreshes).toBe(2);
    await client.dispose();
  });

  it("bounds stale-topology refresh and reopens only the replacement inventory", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.a"]) });
    const inventories: string[][] = [];
    let refreshes = 0;
    let client!: ReturnType<typeof createWorkspaceClient>;
    client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push([...inventory.semanticPaneIds]);
          if (inventories.length === 1)
            throw Object.assign(new Error("stale terminal topology"), {
              code: "topology-changed",
            });
          return new FakeRuntime(ALPHA_DAEMON.instanceId);
        },
        requestTerminalRuntimeInventoryRefresh: () => {
          refreshes += 1;
          shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.b"]));
          queueMicrotask(() => {
            client.adoptTerminalRuntimeInventory({
              workspaceName: "alpha",
              workspaceId: "workspace.alpha",
              sessionId: COHESION_FIXTURE_V1.workspace.session.id,
              resourceRevision: 2,
              semanticPaneIds: ["pane.b"],
            });
          });
        },
        actions,
      },
    });
    client.adoptTerminalRuntimeInventory({
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
      resourceRevision: 1,
      semanticPaneIds: ["pane.a"],
    });

    await settle();
    await settle();
    expect(refreshes).toBe(2);
    expect(inventories).toEqual([["pane.a"], ["pane.b"]]);
    await client.dispose();
  });

  it("refreshes stale topology when an active runtime reconnects after ordinary tmux changes", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.a"]) });
    const clock = new FakeClock();
    const firstRuntime = new ClosableFakeRuntime(ALPHA_DAEMON.instanceId);
    const replacementRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const inventories: string[][] = [];
    const activatedInventories: string[][] = [];
    let refreshes = 0;
    let client!: ReturnType<typeof createWorkspaceClient>;
    client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      clock,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push([...inventory.semanticPaneIds]);
          if (inventories.length === 1) return firstRuntime;
          if (inventory.semanticPaneIds.includes("pane.a")) {
            throw Object.assign(new Error("ordinary tmux changed the pane topology"), {
              code: "topology-changed",
            });
          }
          return replacementRuntime;
        },
        requestTerminalRuntimeInventoryRefresh: () => {
          refreshes += 1;
          if (refreshes !== 1) return;
          shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.b"]));
          shell.connections.at(-1)?.handlers.onInvalidate();
          queueMicrotask(() => {
            client.adoptTerminalRuntimeInventory({
              workspaceName: "alpha",
              workspaceId: "workspace.alpha",
              sessionId: COHESION_FIXTURE_V1.workspace.session.id,
              resourceRevision: 2,
              semanticPaneIds: ["pane.b"],
            });
          });
        },
        didActivateRuntime: (_runtime, inventory) => {
          activatedInventories.push([...inventory.semanticPaneIds]);
        },
        actions,
      },
    });
    client.adoptTerminalRuntimeInventory({
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
      resourceRevision: 1,
      semanticPaneIds: ["pane.a"],
    });
    await settle();
    expect(inventories).toEqual([["pane.a"]]);

    firstRuntime.fail();
    await settle();
    clock.advance(1_000);
    await settle();
    await settle();

    expect(inventories).toEqual([["pane.a"], ["pane.a"], ["pane.b"]]);
    expect(refreshes).toBe(2);
    expect(activatedInventories).toEqual([["pane.a"], ["pane.b"]]);
    await client.dispose();
  });

  it("fails closed when one terminal revision carries conflicting authority", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.a"]) });
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    let refreshes = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return new FakeRuntime(ALPHA_DAEMON.instanceId);
        },
        requestTerminalRuntimeInventoryRefresh: () => {
          refreshes += 1;
        },
        actions,
      },
    });
    const base = {
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
      resourceRevision: 7,
    };
    expect(client.adoptTerminalRuntimeInventory({ ...base, semanticPaneIds: ["pane.a"] })).toBe(
      true,
    );
    await settle();
    expect(client.adoptTerminalRuntimeInventory({ ...base, semanticPaneIds: ["pane.b"] })).toBe(
      false,
    );
    await settle();
    expect(inventories.map((inventory) => inventory.semanticPaneIds)).toEqual([["pane.a"]]);
    expect(refreshes).toBe(1);
    expect(client.adoptTerminalRuntimeInventory({ ...base, semanticPaneIds: ["pane.b"] })).toBe(
      false,
    );
    expect(refreshes).toBe(1);
    await client.dispose();
  });

  it("treats empty inventory and same-name session replacement as terminal revisions", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", []) });
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    let retirements = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return new FakeRuntime(ALPHA_DAEMON.instanceId);
        },
        didRetireRuntime: () => {
          retirements += 1;
        },
        actions,
      },
    });
    const base = { workspaceName: "alpha", workspaceId: "workspace.alpha" };
    client.adoptTerminalRuntimeInventory({
      ...base,
      sessionId: "session.aaaaaaaaaaaaaaaaaaaa",
      resourceRevision: 1,
      semanticPaneIds: ["pane.a"],
    });
    await settle();
    client.adoptTerminalRuntimeInventory({
      ...base,
      sessionId: "session.bbbbbbbbbbbbbbbbbbbb",
      resourceRevision: 2,
      semanticPaneIds: ["pane.a"],
    });
    await settle();
    expect(inventories.map(({ sessionId }) => sessionId)).toEqual([
      "session.aaaaaaaaaaaaaaaaaaaa",
      "session.bbbbbbbbbbbbbbbbbbbb",
    ]);
    client.adoptTerminalRuntimeInventory({
      ...base,
      sessionId: "session.bbbbbbbbbbbbbbbbbbbb",
      resourceRevision: 3,
      semanticPaneIds: [],
    });
    await settle();
    expect(retirements).toBeGreaterThan(0);
    await client.dispose();
  });

  it("waits for shell authority and connects with its exact immutable terminal inventory", async () => {
    const shellAuthority = deferred<ApplicationShellProjectionInputV3>();
    const shellConnections: ShellConnection[] = [];
    const shellTransport: ApplicationShellTransport<ApplicationShellProjectionInputV3> = {
      validateTarget: (value) => DesktopApplicationShellTargetSchemaZ.parse(value),
      fetchApplicationShell: async () => shellAuthority.promise,
      connectEvents: (current, handlers) => {
        const connection = { target: current, handlers, closed: false };
        shellConnections.push(connection);
        return { close: () => (connection.closed = true) };
      },
    };
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shellTransport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return runtime;
        },
        actions,
      },
    });

    await settle();
    expect(inventories).toHaveLength(0);
    shellAuthority.resolve(shellResource("alpha", ["pane.z", "pane.a"]));
    await settle();

    expect(inventories).toHaveLength(1);
    expect(inventories[0]).toEqual({
      workspaceName: "alpha",
      workspaceId: "workspace.alpha",
      sessionId: COHESION_FIXTURE_V1.workspace.session.id,
      daemonGeneration: ALPHA_DAEMON.instanceId,
      shellGeneration: 1,
      semanticPaneIds: ["pane.a", "pane.z"],
    });
    expect(Object.isFrozen(inventories[0])).toBe(true);
    expect(Object.isFrozen(inventories[0]!.semanticPaneIds)).toBe(true);
    client.dispose();
    await settle();
  });

  it("primes every inventory pane before coherence and adopts the retained candidate bindings", async () => {
    const paneIds = ["pane.window-a.one", "pane.window-a.two", "pane.window-b.hidden"];
    const shell = shellBroker({ alpha: shellResource("alpha", paneIds) });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const coherent = deferred<void>();
    const updates = new Map<string, TerminalReplicaUpdate<string, string>[]>();
    let client!: WorkspaceClient<string, string>;
    let prepared = false;
    client = createWorkspaceClient<string, string>({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, _runtimeInventory, _signal, prepare) => {
          await prepare(runtime);
          prepared = true;
          await coherent.promise;
          return runtime;
        },
        actions,
      },
    });
    const unsubscribes = paneIds.map((semanticPaneId) =>
      client.subscribeTerminal({ workspaceName: "alpha", semanticPaneId }, (update) => {
        const seen = updates.get(semanticPaneId) ?? [];
        seen.push(update);
        updates.set(semanticPaneId, seen);
      }),
    );

    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(prepared).toBe(true);
    expect([...runtime.subscriptions.keys()].sort()).toEqual(paneIds);

    for (const semanticPaneId of paneIds) {
      runtime.subscriptions
        .get(semanticPaneId)!
        .emit(terminalSeedFor(semanticPaneId, ALPHA_DAEMON.instanceId));
    }
    expect(updates.get("pane.window-b.hidden")).toBeUndefined();

    coherent.resolve();
    await settle();
    expect(updates.get("pane.window-b.hidden")).toHaveLength(1);
    expect(client.getSnapshot().authorityShell).not.toBeNull();
    expect([...runtime.subscriptions.keys()].sort()).toEqual(paneIds);
    expect(
      [...runtime.subscriptions.values()].every((subscription) => subscription.closeCount === 0),
    ).toBe(true);

    for (const unsubscribe of unsubscribes) unsubscribe();
    client.dispose();
    await settle();
    expect(
      [...runtime.subscriptions.values()].every((subscription) => subscription.closeCount === 1),
    ).toBe(true);
  });

  it("does not charge an eager canonical seed against the candidate update buffer", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const runtime = new EagerSeedRuntime(
      ALPHA_DAEMON.instanceId,
      "x".repeat(8 * 1024 * 1024 + 1),
    );
    const publications: TerminalReplicaUpdate<string, string>[] = [];
    const activations: FakeRuntime[] = [];
    const client = createWorkspaceClient<string, string>({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, _inventory, _signal, prepare) => {
          await prepare(runtime);
          return runtime;
        },
        didActivateRuntime: (nextRuntime) => activations.push(nextRuntime as FakeRuntime),
        actions,
      },
    });
    client.subscribeTerminal(
      { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      (update) => publications.push(update),
    );

    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    expect(activations).toEqual([runtime]);
    expect(publications).toHaveLength(1);
    expect(publications[0]?.type).toBe("terminal.seed");
    await client.dispose();
  });

  it("does not reconnect when a shell refresh leaves runtime inventory unchanged", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    let connects = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => {
          connects += 1;
          return runtime;
        },
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(connects).toBe(1);

    shell.byWorkspace.set(
      "alpha",
      ApplicationShellProjectionInputV3SchemaZ.parse({
        ...shellResource("alpha"),
        project: { ...shellResource("alpha").project, rootLabel: "refreshed label" },
      }),
    );
    shell.connections[0]!.handlers.onInvalidate();
    await settle();
    expect(connects).toBe(1);
    expect(runtime.closeCount).toBe(0);
    client.dispose();
    await settle();
  });

  it("prepares a changed pane inventory and atomically swaps only after it is live", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const first = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const second = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const next = deferred<FakeRuntime>();
    const calls: WorkspaceClientRuntimeInventory[] = [];
    const activated: FakeRuntime[] = [];
    const activatedInventories: string[][] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          calls.push(inventory);
          return calls.length === 1 ? first : next.promise;
        },
        didActivateRuntime: (runtime, inventory) => {
          activated.push(runtime as FakeRuntime);
          activatedInventories.push([...inventory.semanticPaneIds]);
        },
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(calls).toHaveLength(1);
    expect(activated).toEqual([first]);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.beta", "pane.alpha"]));
    shell.connections[0]!.handlers.onInvalidate();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.semanticPaneIds).toEqual(["pane.alpha", "pane.beta"]);
    expect(first.closeCount).toBe(0);
    expect(activated).toEqual([first]);
    expect(activatedInventories).toEqual([["pane.alpha"]]);
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
        { kind: "key", data: "Enter" },
      ),
    ).toBe("ok");
    expect(first.inputs).toHaveLength(1);

    next.resolve(second);
    await settle();
    expect(activated).toEqual([first, second]);
    expect(activatedInventories).toEqual([["pane.alpha"], ["pane.alpha", "pane.beta"]]);
    expect(first.closeCount).toBe(1);
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.beta" },
        { kind: "text", data: "ready" },
      ),
    ).toBe("ok");
    expect(second.inputs).toHaveLength(1);
    expect(calls).toHaveLength(2);
    client.dispose();
    await settle();
  });

  it("does not reconnect a closed incumbent after a replacement inventory is desired", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const clock = new FakeClock();
    const incumbent = new ClosableFakeRuntime(ALPHA_DAEMON.instanceId);
    const replacement = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const replacementGate = deferred<FakeRuntime>();
    const inventories: WorkspaceClientRuntimeInventory[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      clock,
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          inventories.push(inventory);
          return inventories.length === 1 ? incumbent : replacementGate.promise;
        },
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(inventories).toHaveLength(1);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.beta"]));
    shell.connections[0]!.handlers.onInvalidate();
    await settle();
    expect(inventories).toHaveLength(2);

    incumbent.fail();
    await settle();
    clock.advance(30_000);
    await settle();
    expect(inventories).toHaveLength(2);
    expect(clock.timers.size).toBe(0);

    replacementGate.resolve(replacement);
    await settle();
    await client.dispose();
  });

  it("converges a rebound runtime select receipt with the invalidated active shell inventory", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const first = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const second = new FakeRuntime(ALPHA_DAEMON.instanceId);
    let connections = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => (++connections === 1 ? first : second),
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.beta"]));
    shell.connections[0]!.handlers.onInvalidate();
    await settle();
    expect(connections).toBe(2);

    const operationId = "13000000-0000-4000-8000-000000000013";
    await client.dispatch({
      kind: "semantic-intent",
      operationId,
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "alpha",
        semanticPaneId: "pane.beta",
      },
    });
    second.emitReceipt({
      ...receipt(operationId, "observed"),
      target: { kind: "pane", semanticPaneId: "pane.beta" },
      operationKind: "workspace.pane.select",
      summary: { operationKind: "workspace.pane.select" },
      proof: {
        operationKind: "workspace.pane.select",
        outcome: "applied",
        semanticPaneId: "pane.beta",
      },
    });
    const externalRenameId = "14000000-0000-4000-8000-000000000014";
    shell.connections[0]!.handlers.onOperationAcknowledged?.({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: externalRenameId,
      sequence: 10,
      revision: 8,
    });
    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.beta", "pane.alpha"]));
    shell.connections[0]!.handlers.onInvalidate();
    await settle();

    const snapshot = client.getSnapshot();
    expect(snapshot.operations.pending).toEqual([]);
    expect(snapshot.operations.lastReceipt).toMatchObject({
      operationId,
      operationKind: "workspace.pane.select",
      phase: "observed",
      proof: { outcome: "applied", semanticPaneId: "pane.beta" },
    });
    expect(snapshot.operations.lastResourceChangeAcknowledgement).toEqual({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: externalRenameId,
      sequence: 10,
      revision: 8,
    });
    expect(snapshot.authorityShell?.terminalInventory?.activeResourceId).toBe("pane.beta");
    expect(snapshot.semantic?.terminalInventory?.activeResourceId).toBe("pane.beta");
    expect(connections).toBe(2);

    const acknowledgementAfterRefreshId = "15000000-0000-4000-8000-000000000015";
    const priorShell = shellResource("alpha", ["pane.beta", "pane.alpha"]);
    const renamedShell = ApplicationShellProjectionInputV3SchemaZ.parse({
      ...priorShell,
      terminalInventory: {
        ...priorShell.terminalInventory,
        resources: priorShell.terminalInventory.resources.map((resource, index) =>
          index === 0 ? { ...resource, title: "Lifecycle Renamed" } : resource,
        ),
      },
    });
    shell.byWorkspace.set("alpha", renamedShell);
    shell.connections[0]!.handlers.onInvalidate();
    await settle();
    shell.connections[0]!.handlers.onOperationAcknowledged?.({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: acknowledgementAfterRefreshId,
      sequence: 11,
      revision: 8,
    });
    expect(connections).toBe(2);
    expect(client.getSnapshot().semantic?.terminalInventory?.resources[0]?.title).toBe(
      "Lifecycle Renamed",
    );
    expect(client.getSnapshot().operations.lastResourceChangeAcknowledgement).toEqual({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: acknowledgementAfterRefreshId,
      sequence: 11,
      revision: 8,
    });
    second.emitReceipt({
      ...receipt(externalRenameId, "observed"),
      operationKind: "workspace.rename",
      summary: { operationKind: "workspace.rename", scope: "window" },
      target: { kind: "window", target: { by: "pane", semanticPaneId: "pane.beta" } },
      proof: { operationKind: "workspace.rename", outcome: "applied", scope: "window" },
    });
    expect(client.getSnapshot().operations.lastReceipt?.operationId).toBe(operationId);
    client.dispose();
    await settle();
  });

  it("fences resource-change acknowledgements by generation and monotonic sequence", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) => new FakeRuntime(current.daemon.instanceId),
        actions,
      },
    });
    const retiredHandlers = shell.connections[0]!.handlers;
    retiredHandlers.onVerifiedOpen();
    await settle();
    await client.setTarget(target("beta", ALPHA_DAEMON));
    const activeHandlers = shell.connections.findLast(
      (connection) => connection.target.workspaceName === "beta" && !connection.closed,
    )!.handlers;
    activeHandlers.onVerifiedOpen();
    await settle();

    retiredHandlers.onOperationAcknowledged?.({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: "16000000-0000-4000-8000-000000000016",
      sequence: 20,
      revision: 9,
    });
    expect(client.getSnapshot().operations.lastResourceChangeAcknowledgement).toBeNull();
    activeHandlers.onOperationAcknowledged?.({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: "17000000-0000-4000-8000-000000000017",
      sequence: 21,
      revision: 10,
    });
    const accepted = client.getSnapshot().operations.lastResourceChangeAcknowledgement;
    expect(accepted).toEqual({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId: "17000000-0000-4000-8000-000000000017",
      sequence: 21,
      revision: 10,
    });
    for (const acknowledgement of [
      {
        daemonInstanceId: ALPHA_DAEMON.instanceId,
        operationId: "18000000-0000-4000-8000-000000000018",
        sequence: 20,
        revision: 11,
      },
      {
        daemonInstanceId: BETA_DAEMON.instanceId,
        operationId: "18000000-0000-4000-8000-000000000018",
        sequence: 22,
        revision: 11,
      },
      {
        daemonInstanceId: ALPHA_DAEMON.instanceId,
        operationId: "NOT-A-MINTED-OPERATION",
        sequence: 22,
        revision: 11,
      },
    ])
      activeHandlers.onOperationAcknowledged?.(acknowledgement);
    expect(client.getSnapshot().operations.lastResourceChangeAcknowledgement).toBe(accepted);
    client.dispose();
    await settle();
  });

  it("carries a supervised application-shell acknowledgement into WorkspaceClient before refresh", async () => {
    const socket = new WorkspaceClientEventSocket();
    const initialShell = shellResource("alpha", ["pane.alpha"]);
    let currentShell = ApplicationShellProjectionInputV3SchemaZ.parse({
      ...initialShell,
      workspace: {
        ...initialShell.workspace,
        id: "workspace.0123456789abcdefabcd",
        session: {
          ...initialShell.workspace.session,
          id: "session.0123456789abcdefabcd",
        },
      },
    });
    const transport = createDirectLoopbackDaemonTransport({
      descriptor: { ...ALPHA_DAEMON, apiBaseUrl: "http://127.0.0.1:6060/" },
      resolveSessionName: () => "alpha",
      terminalRuntimeAuthority: true,
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V3_VERSION,
      createWebSocket: () => socket,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/terminal-runtime-inventory")) {
          return new Response(
            JSON.stringify({
              version: 1,
              daemon: ALPHA_DAEMON,
              resource: {
                workspaceName: "alpha",
                workspaceId: currentShell.workspace.id,
                sessionId: currentShell.workspace.session.id,
                resourceRevision: 7,
                semanticPaneIds: ["pane.alpha"],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            version: APPLICATION_SHELL_RESOURCE_V3_VERSION,
            daemon: ALPHA_DAEMON,
            resource: currentShell,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    }) as TerminalFirstDaemonTransport;
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      deferApplicationShell: true,
      ports: { shell: transport, connectRuntime: async () => runtime, actions },
    });
    const preparation = transport.prepareTerminalRuntimeInventory(
      target("alpha"),
      new AbortController().signal,
    );
    socket.emit("open");
    socket.frame({ type: "hello", daemon: ALPHA_DAEMON, sessions: [], eventSequence: 0 });
    await settle();
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 1,
      sequence: 0,
      unavailableInterests: [],
    });
    const prepared = await preparation;
    const terminalAuthority = transport.adoptTerminalRuntimeInventory(prepared, (resource) => {
      client.adoptTerminalRuntimeInventory(resource);
    });
    expect(terminalAuthority).not.toBeNull();
    client.adoptTerminalRuntimeInventory(terminalAuthority!);
    await settle();
    expect(socket.sent[1]).toMatchObject({
      type: "subscribe",
      interestRevision: 2,
      interests: [{ resource: "terminal-runtime-inventory" }, { resource: "application-shell" }],
    });
    socket.frame({
      type: "resource.interests-ack",
      interestRevision: 2,
      sequence: 0,
      unavailableInterests: [],
    });
    await settle();
    expect(client.getSnapshot().phase).toBe("live");

    const renamedShell = ApplicationShellProjectionInputV3SchemaZ.parse({
      ...currentShell,
      terminalInventory: {
        ...currentShell.terminalInventory,
        resources: currentShell.terminalInventory.resources.map((resource) => ({
          ...resource,
          title: "Lifecycle Renamed",
        })),
      },
    });
    currentShell = renamedShell;
    const operationId = "19000000-0000-4000-8000-000000000019";
    socket.frame({
      type: "resource.changed",
      sequence: 1,
      workspaceName: "alpha",
      resource: "application-shell",
      revision: 8,
      causeOperationId: operationId,
    });
    expect(client.getSnapshot().operations.lastResourceChangeAcknowledgement).toEqual({
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      operationId,
      sequence: 1,
      revision: 8,
    });
    expect(client.getSnapshot().semantic?.terminalInventory?.resources[0]?.title).toBe(
      "Terminal 1",
    );
    await settle();
    expect(client.getSnapshot().semantic?.terminalInventory?.resources[0]?.title).toBe(
      "Lifecycle Renamed",
    );
    expect(client.getSnapshot().operations.lastReceipt).toBeNull();
    await client.dispose();
    transport.disposeEventSupervisor();
  });

  it("suspends only the exact active runtime while its supervisor reconnects", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const first = new ClosableFakeRuntime(ALPHA_DAEMON.instanceId);
    const replacement = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const suspended: FakeRuntime[] = [];
    let connects = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => (++connects === 1 ? first : replacement),
        didSuspendRuntime: (runtime) => suspended.push(runtime as FakeRuntime),
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(client.ownsRuntimeAuthority("input")).toBe(false);

    first.fail();
    await settle();
    expect(suspended).toEqual([first]);
    expect(connects).toBe(1);
    expect(await client.requestAuthority("input")).toBeNull();
    expect(replacement.closeCount).toBe(0);

    await client.dispose();
  });

  it("isolates overlapping candidate preparation and publishes only the winning runtime", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const active = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const candidateB = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const candidateC = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const coherentB = deferred<void>();
    const coherentC = deferred<void>();
    const preparedB = deferred<void>();
    const preparedC = deferred<void>();
    const publications: string[] = [];
    const activated: FakeRuntime[] = [];
    const client = createWorkspaceClient<string, string>({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory, _signal, prepare) => {
          if (inventory.semanticPaneIds.includes("pane.b")) {
            await prepare(candidateB);
            preparedB.resolve();
            await coherentB.promise;
            return candidateB;
          }
          if (inventory.semanticPaneIds.includes("pane.c")) {
            await prepare(candidateC);
            preparedC.resolve();
            await coherentC.promise;
            return candidateC;
          }
          return active;
        },
        didActivateRuntime: (runtime) => activated.push(runtime as FakeRuntime),
        actions,
      },
    });
    client.subscribeTerminal({ workspaceName: "alpha", semanticPaneId: "pane.alpha" }, (update) =>
      publications.push(update.snapshot ?? update.patch ?? "tombstone"),
    );
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(activated).toEqual([active]);
    const activeSubscription = active.subscriptions.get("pane.alpha")!;
    const activeClose = deferred<void>();
    activeSubscription.closeGate = activeClose.promise;

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.b"]));
    shell.connections[0]!.handlers.onInvalidate();
    await preparedB.promise;
    candidateB.subscriptions
      .get("pane.alpha")!
      .emit({ ...terminalSeed(ALPHA_DAEMON.instanceId), snapshot: "candidate-b" });
    expect(publications).toEqual([]);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.c"]));
    shell.connections[0]!.handlers.onInvalidate();
    await preparedC.promise;
    candidateC.subscriptions
      .get("pane.alpha")!
      .emit({ ...terminalSeed(ALPHA_DAEMON.instanceId), snapshot: "candidate-c" });
    expect(publications).toEqual([]);

    coherentC.resolve();
    await settle();
    expect(activated).toEqual([active, candidateC]);
    expect(publications).toEqual(["candidate-c"]);
    expect(candidateB.subscriptions.get("pane.alpha")!.closeCount).toBe(1);
    expect(activeSubscription.closeCount).toBe(1);
    expect(activeSubscription.listeners.size).toBe(0);
    activeSubscription.emit({
      ...terminalSeed(ALPHA_DAEMON.instanceId),
      snapshot: "retired-active",
    });
    expect(publications).toEqual(["candidate-c"]);
    candidateC.subscriptions.get("pane.alpha")!.emit({
      ...terminalSeed(ALPHA_DAEMON.instanceId),
      snapshot: "candidate-c-live",
    });
    expect(publications).toEqual(["candidate-c", "candidate-c-live"]);
    activeClose.resolve();

    coherentB.resolve();
    await settle();
    expect(activated).toEqual([active, candidateC]);
    expect(publications).toEqual(["candidate-c", "candidate-c-live"]);
    expect(candidateB.closeCount).toBe(1);
    await client.dispose();
  });

  it("stages the production fast-lane inventory before candidate coherence without trimming the incumbent", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const active = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const candidate = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const candidateCoherent = deferred<void>();
    const candidatePrepared = deferred<void>();
    const staged = new WeakMap<FakeRuntime, () => void>();
    let lane!: TerminalFastLane;
    let client!: ReturnType<typeof createWorkspaceClient<string, string>>;
    client = createWorkspaceClient<string, string>({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory, _signal, prepare) => {
          const runtime = inventory.semanticPaneIds.includes("pane.beta") ? candidate : active;
          const release = lane.stagePanes(inventory.semanticPaneIds);
          await prepare(runtime);
          staged.set(runtime, release);
          if (runtime === candidate) {
            candidatePrepared.resolve();
            await candidateCoherent.promise;
          }
          return runtime;
        },
        didActivateRuntime: (runtime, inventory) => {
          lane.retainPanes(inventory.semanticPaneIds);
          const release = staged.get(runtime as FakeRuntime);
          staged.delete(runtime as FakeRuntime);
          release?.();
        },
        actions,
      },
    });
    lane = createTerminalFastLane({
      address: { workspaceName: "alpha", generation: ALPHA_DAEMON.instanceId },
      source: createWorkspaceClientTerminalSource(client as never),
      repair: { request: () => undefined },
      control: {
        owns: () => true,
        request: async () => true,
        write: async () => "ok",
        resize: async () => "ok",
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(active.subscriptions.has("pane.alpha")).toBe(true);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.beta"]));
    shell.connections[0]!.handlers.onInvalidate();
    await candidatePrepared.promise;
    // This is the production-order proof: prepare() saw the new fast-lane
    // interest, while the incumbent remained subscribed and paint-capable.
    expect(candidate.subscriptions.has("pane.alpha")).toBe(true);
    expect(candidate.subscriptions.has("pane.beta")).toBe(true);
    expect(active.subscriptions.get("pane.alpha")?.listeners.size).toBe(1);

    candidateCoherent.resolve();
    await settle();
    expect(active.subscriptions.get("pane.alpha")?.listeners.size).toBe(0);
    expect(candidate.subscriptions.get("pane.alpha")?.listeners.size).toBe(1);
    expect(candidate.subscriptions.get("pane.beta")?.listeners.size).toBe(1);
    lane.dispose();
    await client.dispose();
  });

  it("retires a flooded candidate without dropping, reordering, or publishing partial state", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha", ["pane.alpha"]) });
    const active = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const flooded = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const prepared = deferred<void>();
    const coherent = deferred<void>();
    const publications: string[] = [];
    const activated: FakeRuntime[] = [];
    const client = createWorkspaceClient<string, string>({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory, _signal, prepare) => {
          if (!inventory.semanticPaneIds.includes("pane.flood")) return active;
          await prepare(flooded);
          prepared.resolve();
          await coherent.promise;
          return flooded;
        },
        didActivateRuntime: (runtime) => activated.push(runtime as FakeRuntime),
        actions,
      },
    });
    client.subscribeTerminal({ workspaceName: "alpha", semanticPaneId: "pane.alpha" }, (update) =>
      publications.push(update.snapshot ?? update.patch ?? "tombstone"),
    );
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(activated).toEqual([active]);

    shell.byWorkspace.set("alpha", shellResource("alpha", ["pane.alpha", "pane.flood"]));
    shell.connections[0]!.handlers.onInvalidate();
    await prepared.promise;
    const subscription = flooded.subscriptions.get("pane.alpha")!;
    for (let index = 0; index <= 256; index += 1) {
      subscription.emit({
        ...terminalSeed(ALPHA_DAEMON.instanceId),
        snapshot: `flood-${index}`,
      });
    }
    await settle();
    expect(publications).toEqual([]);
    expect(activated).toEqual([active]);
    expect(subscription.closeCount).toBe(1);
    expect(subscription.listeners.size).toBe(0);

    coherent.resolve();
    await settle();
    expect(flooded.closeCount).toBe(1);
    expect(activated).toEqual([active]);
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
        { kind: "text", data: "incumbent-still-live" },
      ),
    ).toBe("ok");
    expect(active.inputs).toHaveLength(1);
    await client.dispose();
  });

  it("retires the runtime cleanly when authority publishes an empty inventory", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    let connects = 0;
    let retirements = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => {
          connects += 1;
          return runtime;
        },
        didRetireRuntime: () => {
          retirements += 1;
        },
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    shell.byWorkspace.set("alpha", shellResource("alpha", []));
    shell.connections[0]!.handlers.onInvalidate();
    await settle();

    expect(connects).toBe(1);
    expect(runtime.closeCount).toBe(1);
    expect(retirements).toBe(1);
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
        { kind: "key", data: "Enter" },
      ),
    ).toBe("authority-lost");
    client.dispose();
    await settle();
  });

  it("fences a late runtime candidate after target replacement", async () => {
    const shell = shellBroker({
      alpha: shellResource("alpha"),
      beta: shellResource("beta"),
    });
    const alpha = deferred<FakeRuntime>();
    const staleAlpha = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const beta = new FakeRuntime(BETA_DAEMON.instanceId);
    const calls: string[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) => {
          calls.push(current.workspaceName);
          return current.workspaceName === "alpha" ? alpha.promise : beta;
        },
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    expect(calls).toEqual(["alpha"]);

    client.setTarget(target("beta", BETA_DAEMON));
    alpha.resolve(staleAlpha);
    shell.connections[1]!.handlers.onVerifiedOpen();
    await settle();

    expect(calls).toEqual(["alpha", "beta"]);
    expect(staleAlpha.closeCount).toBe(1);
    expect(
      await client.sendTerminalInput(
        { workspaceName: "beta", semanticPaneId: "pane.beta" },
        { kind: "key", data: "Enter" },
      ),
    ).toBe("ok");
    expect(beta.inputs).toHaveLength(1);
    client.dispose();
    await settle();
  });

  it("ignores a delayed catalog read from a retired target generation", async () => {
    const alphaCatalog = deferred<ReturnType<typeof workspaceCatalog>>();
    const betaCatalog = deferred<ReturnType<typeof workspaceCatalog>>();
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        catalog: {
          read: (current) =>
            current.workspaceName === "alpha" ? alphaCatalog.promise : betaCatalog.promise,
          subscribe: () => ({ close: () => undefined }),
        },
        connectRuntime: async (current) => new FakeRuntime(current.daemon.instanceId),
        actions,
      },
    });
    await settle();
    const replacing = client.setTarget(target("beta", BETA_DAEMON));
    await settle();
    alphaCatalog.resolve(workspaceCatalog("alpha"));
    betaCatalog.resolve(workspaceCatalog("beta", BETA_DAEMON));
    await replacing;
    await settle();
    expect(client.getSnapshot().catalog).toMatchObject({
      daemonInstanceId: BETA_DAEMON.instanceId,
      intents: [{ workspaceName: "beta" }],
      liveSessions: [{ sessionName: "beta" }],
    });
    await client.dispose();
  });

  it("settles target replacement even when the retired connect adapter never resolves", async () => {
    const shell = shellBroker({
      alpha: shellResource("alpha"),
      beta: shellResource("beta"),
    });
    const never = new Promise<FakeRuntime>(() => undefined);
    const beta = new FakeRuntime(BETA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: (current) =>
          current.workspaceName === "alpha" ? never : Promise.resolve(beta),
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    await client.setTarget(target("beta", BETA_DAEMON));
    shell.connections[1]!.handlers.onVerifiedOpen();
    await settle();
    expect(client.getSnapshot().target?.workspaceName).toBe("beta");
    await client.dispose();
  });

  it("fences terminal repair to the active daemon generation", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const pane = { workspaceName: "alpha", semanticPaneId: "pane.alpha" };

    client.requestTerminalRepair(pane, BETA_DAEMON.instanceId, "conflict");
    client.requestTerminalRepair(pane, ALPHA_DAEMON.instanceId, "conflict");
    expect(runtime.repairRequests).toEqual([{ target: pane, reason: "conflict" }]);
    await client.dispose();
  });

  it("produces byte-identical semantic traces for core, OpenTUI, Web, and SDK adapters", async () => {
    const labels = ["core", "opentui", "web", "sdk"] as const;
    const clients = labels.map((surface) => {
      const shell = shellBroker({ alpha: shellResource("alpha") });
      const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
      const clock = new FakeClock();
      const client = createWorkspaceClient({
        target: target("alpha"),
        ports: {
          shell: shell.transport,
          connectRuntime: async () => runtime,
          actions,
        },
        clock,
        operationId: () => "10000000-0000-4000-8000-000000000001",
      });
      shell.connections[0]!.handlers.onVerifiedOpen();
      return {
        client,
        shell,
        runtime,
        adapter: createWorkspaceClientConformanceAdapter(surface, client),
      };
    });
    await settle();
    const liveTraceHashes = clients.map(({ adapter }) => adapter.traceHash());
    expect(new Set(liveTraceHashes).size).toBe(1);

    const invocation = applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.activateMode,
      { mode: "home" },
      { kind: "program", surface: "workspace-client-conformance" },
    );
    for (const { client } of clients) {
      await client.dispatch({ kind: "application-shell", invocation });
    }
    const localProjectionTraceHashes = clients.map(({ adapter }) => adapter.traceHash());
    expect(new Set(localProjectionTraceHashes).size).toBe(1);

    const operationId = "10000000-0000-4000-8000-000000000001";
    for (const { client } of clients) {
      await client.dispatch({
        kind: "semantic-intent",
        operationId,
        intent: {
          verb: "workspace.pane.read",
          workspaceName: "alpha",
          semanticPaneId: "pane.alpha",
          origin: "sdk",
        },
      });
    }
    for (const { runtime } of clients) {
      runtime.emitReceipt(receipt(operationId, "accepted"));
      runtime.emitReceipt(receipt(operationId, "observed"));
    }
    const receiptTraceHashes = clients.map(({ adapter }) => adapter.traceHash());
    expect(new Set(receiptTraceHashes).size).toBe(1);

    const beforeTerminal = clients.map(({ adapter }) => adapter.traceHash());
    for (const { client, runtime } of clients) {
      client.subscribeTerminal(
        { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
        () => undefined,
      );
      await settle();
      runtime.subscriptions.get("pane.alpha")!.emit(terminalSeed(ALPHA_DAEMON.instanceId));
    }
    expect(clients.map(({ adapter }) => adapter.traceHash())).toEqual(beforeTerminal);

    const bytes = clients.map(({ adapter }) => adapter.semanticBytes());
    const hashes = clients.map(({ adapter }) => adapter.semanticHash());
    expect(new Set(bytes).size).toBe(1);
    expect(new Set(hashes).size).toBe(1);
    expect(clients[0]!.client.getSnapshot().authorityShell?.appWindows.revision).toBe(7);
    for (const { adapter, client } of clients) {
      adapter.dispose();
      client.dispose();
    }
  });

  it("fences stale target work, terminal frames, receipts, and timers", async () => {
    const clock = new FakeClock();
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    let resolveAlpha!: (runtime: FakeRuntime) => void;
    const alphaRuntimePromise = new Promise<FakeRuntime>((resolve) => (resolveAlpha = resolve));
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: (current) =>
          current.workspaceName === "alpha" ? alphaRuntimePromise : Promise.resolve(betaRuntime),
        actions,
      },
      clock,
      operationTimeoutMs: 50,
    });
    const generations: number[] = [];
    client.subscribe("lifecycle", ({ generation }) => generations.push(generation));
    const staleAlphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    client.setTarget(target("beta", BETA_DAEMON));
    client.setTarget(target("beta", BETA_DAEMON));
    resolveAlpha(staleAlphaRuntime);
    shell.connections[0]!.handlers.onVerifiedOpen();
    shell.connections[0]!.handlers.onInvalidate();
    await settle();

    expect(client.getSnapshot()).toMatchObject({
      generation: 2,
      target: { workspaceName: "beta" },
    });
    expect(Math.max(...generations)).toBe(2);
    // Inventory authority never arrived for alpha, so no speculative runtime was opened.
    expect(staleAlphaRuntime.closeCount).toBe(0);
    expect(client.getSnapshot().authorityShell?.project.name).toBe("beta");
    clock.advance(10_000);
    expect(client.getSnapshot().generation).toBe(2);
    client.dispose();
  });

  it("routes canonical terminal input through one runtime and fences late generation acks", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) =>
          current.workspaceName === "alpha" ? alphaRuntime : betaRuntime,
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    expect(
      await Promise.all([
        client.sendTerminalInput(
          { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
          { kind: "text", data: "hello" },
        ),
        client.sendTerminalInput(
          { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
          { kind: "key", data: "Enter" },
        ),
      ]),
    ).toEqual(["ok", "ok"]);
    expect(alphaRuntime.inputs.map(({ input }) => input)).toEqual([
      { kind: "text", data: "hello" },
      { kind: "key", data: "Enter" },
    ]);

    const lateAck = deferred<void>();
    alphaRuntime.inputGate = lateAck.promise;
    const stale = client.sendTerminalInput(
      { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      { kind: "key", data: "C-c" },
    );
    client.setTarget(target("beta", BETA_DAEMON));
    lateAck.resolve();
    expect(await stale).toBe("authority-lost");
    expect(
      await client.sendTerminalInput(
        { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
        { kind: "key", data: "Up" },
      ),
    ).toBe("authority-lost");
    client.dispose();
  });

  it("fits the shared runtime viewport and fences a late retired generation", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const lateFit = deferred<void>();
    alphaRuntime.viewportGate = lateFit.promise;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) =>
          current.workspaceName === "alpha" ? alphaRuntime : betaRuntime,
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    const retiredFit = client.fitViewport(132, 44);
    client.setTarget(target("beta", BETA_DAEMON));
    lateFit.resolve();
    shell.connections[1]!.handlers.onVerifiedOpen();
    await settle();
    expect(await retiredFit).toBe("authority-lost");
    expect(alphaRuntime.viewportFits).toEqual([{ cols: 132, rows: 44 }]);
    expect(await client.fitViewport(100, 30)).toBe("ok");
    expect(betaRuntime.viewportFits).toEqual([{ cols: 100, rows: 30 }]);
    client.dispose();
    await settle();
  });

  it("preserves an exact geometry-authority conflict from the current runtime", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    runtime.viewportResult = "geometry-authority-conflict";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    expect(await client.fitViewport(140, 46)).toBe("geometry-authority-conflict");
    expect(runtime.viewportFits).toEqual([{ cols: 140, rows: 46 }]);
    client.dispose();
    await settle();
  });

  it("rejects an authority grant that settles after its exact runtime was replaced", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const lateAuthority = deferred<void>();
    alphaRuntime.authorityGate = lateAuthority.promise;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) =>
          current.workspaceName === "alpha" ? alphaRuntime : betaRuntime,
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    const staleGrant = client.requestAuthority("input");
    client.setTarget(target("beta", BETA_DAEMON));
    shell.connections[1]!.handlers.onVerifiedOpen();
    await settle();
    lateAuthority.resolve();
    await expect(staleGrant).resolves.toBeNull();
    await expect(client.requestAuthority("input")).resolves.toMatchObject({
      generation: BETA_DAEMON.instanceId,
      authority: "input",
    });
    client.dispose();
    await settle();
  });

  it("settles duplicate and reordered receipts once without waking semantic subscribers", async () => {
    const clock = new FakeClock();
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const operationId = "10000000-0000-4000-8000-000000000001";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
      clock,
      operationId: () => operationId,
      operationTimeoutMs: 50,
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    let semanticPublications = 0;
    let operationPublications = 0;
    client.subscribe("semantic", () => (semanticPublications += 1));
    client.subscribe("operations", () => (operationPublications += 1));
    const baselineSemantic = semanticPublications;
    await client.dispatch({
      kind: "semantic-intent",
      operationId,
      intent: {
        verb: "workspace.pane.read",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        origin: "sdk",
      },
    });
    runtime.emitReceipt(receipt(operationId, "accepted"));
    runtime.emitReceipt(receipt(operationId, "accepted"));
    runtime.emitReceipt(receipt(operationId, "observed"));
    runtime.emitReceipt(receipt(operationId, "observed"));
    const afterTerminal = operationPublications;
    clock.advance(1_000);

    expect(client.getSnapshot().operations.pending).toEqual([]);
    expect(client.getSnapshot().operations.terminalOperationIds).toEqual([operationId]);
    expect(operationPublications).toBe(afterTerminal);
    expect(semanticPublications).toBe(baselineSemantic);
    client.dispose();
    client.dispose();
    await settle();
    expect(runtime.closeCount).toBe(1);
  });

  it("rejects pending and terminal duplicate operation ids before semantic transport", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const operationId = "11000000-0000-4000-8000-000000000011";
    let resolveSubmit!: () => void;
    const submitCompletion = new Promise<void>((resolve) => (resolveSubmit = resolve));
    runtime.submitIntent = async () => {
      runtime.submitCount += 1;
      await submitCompletion;
    };
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const command = {
      kind: "semantic-intent" as const,
      operationId,
      intent: {
        verb: "workspace.pane.read" as const,
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        origin: "sdk" as const,
      },
    };

    const first = client.dispatch(command);
    await settle();
    await expect(client.dispatch(command)).rejects.toThrow("already pending or terminal");
    expect(runtime.submitCount).toBe(1);
    resolveSubmit();
    await first;
    runtime.emitReceipt(receipt(operationId, "observed"));
    await expect(client.dispatch(command)).rejects.toThrow("already pending or terminal");
    expect(runtime.submitCount).toBe(1);
    client.dispose();
    await settle();
  });

  it("rejects pending and terminal duplicate operation ids before owner transport", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const operationId = "12000000-0000-4000-8000-000000000012";
    let resolveOwner!: (value: null) => void;
    const ownerCompletion = new Promise<null>((resolve) => (resolveOwner = resolve));
    let ownerSubmitCount = 0;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => runtime,
        actions: {
          async dispatch() {
            ownerSubmitCount += 1;
            return ownerCompletion;
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const command = {
      kind: "owner-action" as const,
      operationId,
      name: "workspace.pane.select" as const,
      input: { semanticPaneId: "pane.alpha" },
    };

    const first = client.dispatch(command);
    await settle();
    await expect(client.dispatch(command)).rejects.toThrow("already pending or terminal");
    expect(ownerSubmitCount).toBe(1);
    resolveOwner(null);
    await first;
    await expect(client.dispatch(command)).rejects.toThrow("already pending or terminal");
    expect(ownerSubmitCount).toBe(1);
    client.dispose();
    await settle();
  });

  it("retires pane publications, receipts, and operation timers with a target generation", async () => {
    const timerBaseline = runtimeResourceSnapshot()["runtime-timer"].active;
    const clock = new FakeClock();
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const operationId = "10000000-0000-4000-8000-000000000001";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) =>
          current.workspaceName === "alpha" ? alphaRuntime : betaRuntime,
        actions,
      },
      clock,
      operationTimeoutMs: 50,
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    let terminalWakeups = 0;
    client.subscribeTerminal(
      { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      () => (terminalWakeups += 1),
    );
    await settle();
    await client.dispatch({
      kind: "semantic-intent",
      operationId,
      intent: {
        verb: "workspace.pane.read",
        workspaceName: "alpha",
        semanticPaneId: "pane.alpha",
        origin: "sdk",
      },
    });
    const retiredSubscription = alphaRuntime.subscriptions.get("pane.alpha")!;
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBeGreaterThan(timerBaseline);

    client.setTarget(target("beta", BETA_DAEMON));
    retiredSubscription.emit(terminalSeed(ALPHA_DAEMON.instanceId));
    alphaRuntime.emitReceipt(receipt(operationId, "observed"));
    clock.advance(1_000);
    await settle();

    expect(terminalWakeups).toBe(0);
    expect(client.getSnapshot().generation).toBe(2);
    expect(client.getSnapshot().operations).toMatchObject({
      pending: [],
      terminalOperationIds: [],
      lastReceipt: null,
    });
    expect(retiredSubscription.closeCount).toBe(1);
    expect(runtimeResourceSnapshot()["runtime-timer"].active).toBe(timerBaseline);
    client.dispose();
    await settle();
  });

  it("keeps pane delivery scoped and bounded across 2, 4, and 8 clients", async () => {
    for (const count of [2, 4, 8]) {
      const clients = [];
      const runtimes: FakeRuntime[] = [];
      let semanticWakeups = 0;
      let terminalWakeups = 0;
      for (let index = 0; index < count; index += 1) {
        const shell = shellBroker({ alpha: shellResource("alpha") });
        const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
        const client = createWorkspaceClient({
          target: target("alpha"),
          ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
        });
        shell.connections[0]!.handlers.onVerifiedOpen();
        client.subscribe("semantic", () => (semanticWakeups += 1));
        client.subscribeTerminal(
          { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
          () => (terminalWakeups += 1),
        );
        clients.push(client);
        runtimes.push(runtime);
      }
      await settle();
      const semanticBaseline = semanticWakeups;
      for (const runtime of runtimes) {
        runtime.subscriptions.get("pane.alpha")!.emit(terminalSeed(ALPHA_DAEMON.instanceId));
      }
      expect(terminalWakeups).toBe(count);
      expect(semanticWakeups).toBe(semanticBaseline);
      expect(runtimes.reduce((sum, runtime) => sum + runtime.subscriptions.size, 0)).toBe(count);
      for (const client of clients) client.dispose();
      await settle();
      expect(runtimes.every((runtime) => runtime.closeCount === 1)).toBe(true);
    }
  });

  it("keeps workspace prepare and decision in one generation-fenced action lifecycle", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const prepareToken = "30000000-0000-4000-8000-000000000003";
    const calls: string[] = [];
    const handoffActions: WorkspaceClientOwnerActionPort = {
      async dispatch(input) {
        calls.push(input.name);
        if (input.name === "workspace.open.prepare") {
          return {
            operationId: "20000000-0000-4000-8000-000000000002",
            daemonInstanceId: ALPHA_DAEMON.instanceId,
            phase: "prepared",
            prepareToken,
            preparedRevision: 1,
            outcome: "reopened",
            workspaceName: "alpha",
            previousWorkspaceName: null,
            proof: {
              semanticPaneId: "pane.alpha",
              paneCount: 1,
              terminalRevision: 0,
              terminalStateHash: "0000000000000000",
            },
          } as never;
        }
        return {
          operationId: "40000000-0000-4000-8000-000000000004",
          daemonInstanceId: ALPHA_DAEMON.instanceId,
          phase: "committed",
          prepareToken,
          preparedRevision: 1,
          workspaceName: "alpha",
          previousWorkspaceName: null,
        } as never;
      },
    };
    let nextOperation = 10;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => runtime,
        actions: handoffActions,
      },
      operationId: () => `50000000-0000-4000-8000-${String(nextOperation++).padStart(12, "0")}`,
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    await client.dispatch({
      kind: "owner-action",
      name: "workspace.open.prepare",
      input: { source: { kind: "project", projectDir: "/project" } },
    });
    await expect(
      client.dispatch({
        kind: "owner-action",
        name: "workspace.open.commit",
        input: {
          prepareToken: "60000000-0000-4000-8000-000000000006",
          preparedRevision: 1,
        },
      }),
    ).rejects.toThrow("does not match");
    await client.dispatch({
      kind: "owner-action",
      name: "workspace.open.commit",
      input: { prepareToken, preparedRevision: 1 },
    });
    expect(calls).toEqual(["workspace.open.prepare", "workspace.open.commit"]);
    client.dispose();
    await settle();
  });

  it("terminalizes a rejected owner action immediately", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const operationId = "70000000-0000-4000-8000-000000000007";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => runtime,
        actions: {
          dispatch: async () => {
            throw new Error("owner rejected");
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    await expect(
      client.dispatch({
        kind: "owner-action",
        operationId,
        name: "workspace.pane.select",
        input: { semanticPaneId: "pane.alpha" },
      }),
    ).rejects.toThrow("owner rejected");

    expect(client.getSnapshot().operations.pending).toEqual([]);
    expect(client.getSnapshot().operations.terminalOperationIds).toContain(operationId);
    client.dispose();
    await settle();
  });

  it("actively cancels a prepared open on target replacement and fences its late completion", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alphaRuntime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const betaRuntime = new FakeRuntime(BETA_DAEMON.instanceId);
    const prepareToken = "80000000-0000-4000-8000-000000000008";
    let rejectCancel!: (error: Error) => void;
    const cancelCompletion = new Promise<void>((_resolve, reject) => (rejectCancel = reject));
    const calls: Array<{ name: string; workspaceName: string; input: unknown }> = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) =>
          current.workspaceName === "alpha" ? alphaRuntime : betaRuntime,
        actions: {
          async dispatch(input) {
            calls.push({
              name: input.name,
              workspaceName: input.target.workspaceName,
              input: input.input,
            });
            if (input.name === "workspace.open.prepare") {
              return {
                operationId: input.operationId,
                daemonInstanceId: ALPHA_DAEMON.instanceId,
                phase: "prepared",
                prepareToken,
                preparedRevision: 4,
                outcome: "reopened",
                workspaceName: "alpha",
                previousWorkspaceName: null,
                proof: {
                  semanticPaneId: "pane.alpha",
                  paneCount: 1,
                  terminalRevision: 0,
                  terminalStateHash: "0000000000000000",
                },
              } as never;
            }
            if (input.name === "workspace.open.cancel") await cancelCompletion;
            return null as never;
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    await client.dispatch({
      kind: "owner-action",
      name: "workspace.open.prepare",
      input: { source: { kind: "project", projectDir: "/project" } },
    });

    client.setTarget(target("beta", BETA_DAEMON));
    await settle();
    expect(calls).toContainEqual({
      name: "workspace.open.cancel",
      workspaceName: "alpha",
      input: { prepareToken, preparedRevision: 4 },
    });
    expect(client.getSnapshot().generation).toBe(2);
    expect(client.getSnapshot().operations.pending).toEqual([]);

    rejectCancel(new Error("late retired cancellation failure"));
    await settle();
    expect(client.getSnapshot().generation).toBe(2);
    expect(client.getSnapshot().target?.workspaceName).toBe("beta");
    expect(client.getSnapshot().operations.pending).toEqual([]);
    client.dispose();
    await settle();
  });

  it("cancels a capability whose prepare resolves after its exact target retired", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const pending = deferred<unknown>();
    const calls: Array<{ name: string; workspaceName: string; input: unknown }> = [];
    const prepareToken = "81000000-0000-4000-8000-000000000008";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) => new FakeRuntime(current.daemon.instanceId),
        actions: {
          async dispatch(input) {
            calls.push({
              name: input.name,
              workspaceName: input.target.workspaceName,
              input: input.input,
            });
            if (input.name === "workspace.open.prepare") return (await pending.promise) as never;
            return null as never;
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const preparing = client.dispatch({
      kind: "owner-action",
      name: "workspace.open.prepare",
      input: { source: { kind: "project", projectDir: "/project" } },
    });
    client.setTarget(target("beta", BETA_DAEMON));
    pending.resolve({
      operationId: "late-prepare",
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      phase: "prepared",
      prepareToken,
      preparedRevision: 7,
      outcome: "reopened",
      workspaceName: "alpha",
      previousWorkspaceName: null,
      proof: {
        semanticPaneId: "pane.alpha",
        paneCount: 1,
        terminalRevision: 0,
        terminalStateHash: "0000000000000000",
      },
    });
    await expect(preparing).rejects.toThrow("retired");
    expect(calls.at(-1)).toEqual({
      name: "workspace.open.cancel",
      workspaceName: "alpha",
      input: { prepareToken, preparedRevision: 7 },
    });
    await client.dispose();
  });

  it("actively cancels a prepared open during idempotent disposal", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const prepareToken = "90000000-0000-4000-8000-000000000009";
    const calls: string[] = [];
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => runtime,
        actions: {
          async dispatch(input) {
            calls.push(input.name);
            if (input.name === "workspace.open.prepare") {
              return {
                operationId: input.operationId,
                daemonInstanceId: ALPHA_DAEMON.instanceId,
                phase: "prepared",
                prepareToken,
                preparedRevision: 2,
                outcome: "reopened",
                workspaceName: "alpha",
                previousWorkspaceName: null,
                proof: {
                  semanticPaneId: "pane.alpha",
                  paneCount: 1,
                  terminalRevision: 0,
                  terminalStateHash: "0000000000000000",
                },
              } as never;
            }
            return null as never;
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    await client.dispatch({
      kind: "owner-action",
      name: "workspace.open.prepare",
      input: { source: { kind: "project", projectDir: "/project" } },
    });

    await client.dispose();
    await client.dispose();
    await settle();
    expect(calls).toEqual(["workspace.open.prepare", "workspace.open.cancel"]);
    expect(client.getSnapshot().phase).toBe("disposed");
    expect(runtime.closeCount).toBe(1);
  });

  it("cancels a capability whose prepare resolves after disposal", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const pending = deferred<unknown>();
    const calls: string[] = [];
    const prepareToken = "91000000-0000-4000-8000-000000000009";
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => new FakeRuntime(ALPHA_DAEMON.instanceId),
        actions: {
          async dispatch(input) {
            calls.push(input.name);
            if (input.name === "workspace.open.prepare") return (await pending.promise) as never;
            return null as never;
          },
        },
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const preparing = client.dispatch({
      kind: "owner-action",
      name: "workspace.open.prepare",
      input: { source: { kind: "project", projectDir: "/project" } },
    });
    const disposal = client.dispose();
    pending.resolve({
      operationId: "late-disposed-prepare",
      daemonInstanceId: ALPHA_DAEMON.instanceId,
      phase: "prepared",
      prepareToken,
      preparedRevision: 8,
      outcome: "reopened",
      workspaceName: "alpha",
      previousWorkspaceName: null,
      proof: {
        semanticPaneId: "pane.alpha",
        paneCount: 1,
        terminalRevision: 0,
        terminalStateHash: "0000000000000000",
      },
    });
    await expect(preparing).rejects.toThrow("retired");
    await disposal;
    expect(calls).toEqual(["workspace.open.prepare", "workspace.open.cancel"]);
  });

  it("does not settle disposal until the runtime supervisor closes its transport", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const closing = deferred<void>();
    runtime.closeGate = closing.promise;
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async () => runtime,
        actions,
      },
    });
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();

    let settled = false;
    const disposing = client.dispose().then(() => (settled = true));
    await settle();
    expect(runtime.closeCount).toBe(1);
    expect(settled).toBe(false);
    closing.resolve();
    await disposing;
    expect(settled).toBe(true);
  });

  it("does not settle target retirement until its terminal subscription closes", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha"), beta: shellResource("beta") });
    const alpha = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const beta = new FakeRuntime(BETA_DAEMON.instanceId);
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (current) => (current.workspaceName === "alpha" ? alpha : beta),
        actions,
      },
    });
    client.subscribeTerminal(
      { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      () => undefined,
    );
    shell.connections[0]!.handlers.onVerifiedOpen();
    await settle();
    const subscription = alpha.subscriptions.get("pane.alpha")!;
    const closeGate = deferred<void>();
    subscription.closeGate = closeGate.promise;

    let retired = false;
    const retirement = client.setTarget(target("beta", BETA_DAEMON)).then(() => (retired = true));
    await settle();
    expect(subscription.closeCount).toBe(1);
    expect(retired).toBe(false);
    closeGate.resolve();
    await retirement;
    expect(retired).toBe(true);
    await client.dispose();
  });

  it("fences and closes a terminal subscription that resolves after disposal settled", async () => {
    const shell = shellBroker({ alpha: shellResource("alpha") });
    const runtime = new FakeRuntime(ALPHA_DAEMON.instanceId);
    const subscriptionStarted = deferred<void>();
    const subscriptionReady = deferred<FakeTerminalSubscription>();
    runtime.subscribeTerminal = async () => {
      subscriptionStarted.resolve();
      return subscriptionReady.promise;
    };
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: { shell: shell.transport, connectRuntime: async () => runtime, actions },
    });
    client.subscribeTerminal(
      { workspaceName: "alpha", semanticPaneId: "pane.alpha" },
      () => undefined,
    );
    shell.connections[0]!.handlers.onVerifiedOpen();
    await subscriptionStarted.promise;

    await client.dispose();
    expect(client.getSnapshot().phase).toBe("disposed");

    const closeStarted = deferred<void>();
    const closeFinished = deferred<void>();
    const late = new FakeTerminalSubscription(ALPHA_DAEMON.instanceId);
    const closeGate = deferred<void>();
    late.close = async () => {
      late.closeCount += 1;
      closeStarted.resolve();
      await closeGate.promise;
      closeFinished.resolve();
    };
    subscriptionReady.resolve(late);
    await closeStarted.promise;
    expect(late.closeCount).toBe(1);
    closeGate.resolve();
    await closeFinished.promise;
    expect(late.closeCount).toBe(1);
  });
});
