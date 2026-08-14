import { describe, expect, it } from "bun:test";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV3SchemaZ,
  COHESION_FIXTURE_V1,
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
  ApplicationShellEventHandlers,
  ApplicationShellTransport,
} from "./application-shell-session.ts";
import type { GenerationBoundClock } from "./generation-bound-store.ts";
import { createWorkspaceClient } from "./workspace-client.ts";
import { createWorkspaceClientConformanceAdapter } from "./workspace-client-conformance.ts";
import type {
  WorkspaceClientOwnerActionPort,
  WorkspaceClientRuntimeInventory,
  WorkspaceClientRuntimePort,
} from "./workspace-client-types.ts";

const daemon = (instanceId: string) => ({
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId,
  startedAt: "2026-08-14T10:00:00.000Z",
});
const ALPHA_DAEMON = daemon("11111111-1111-4111-8111-111111111111");
const BETA_DAEMON = daemon("22222222-2222-4222-8222-222222222222");

function target(workspaceName: string, identity = ALPHA_DAEMON): DesktopApplicationShellTarget {
  return DesktopApplicationShellTargetSchemaZ.parse({ daemon: identity, workspaceName });
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

class FakeTerminalSubscription {
  readonly listeners = new Set<(update: TerminalReplicaUpdate<string, string>) => void>();
  closeCount = 0;
  constructor(readonly generation: string) {}
  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
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
  async fitViewport(cols: number, rows: number): Promise<void> {
    if (this.viewportGate) await this.viewportGate;
    this.viewportFits.push({ cols, rows });
  }
  onReceipt(listener: (receipt: InteractionReceipt) => void): () => void {
    this.receipts.add(listener);
    return () => this.receipts.delete(listener);
  }
  emitReceipt(receipt: InteractionReceipt): void {
    for (const listener of this.receipts) listener(receipt);
  }
  close(): void {
    this.closeCount += 1;
  }
}

const actions: WorkspaceClientOwnerActionPort = {
  dispatch: async () => null,
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
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

describe("WorkspaceClient", () => {
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
    const client = createWorkspaceClient({
      target: target("alpha"),
      ports: {
        shell: shell.transport,
        connectRuntime: async (_current, inventory) => {
          calls.push(inventory);
          return calls.length === 1 ? first : next.promise;
        },
        didActivateRuntime: (runtime) => activated.push(runtime as FakeRuntime),
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

    client.dispose();
    client.dispose();
    await settle();
    expect(calls).toEqual(["workspace.open.prepare", "workspace.open.cancel"]);
    expect(client.getSnapshot().phase).toBe("disposed");
    expect(runtime.closeCount).toBe(1);
  });
});
