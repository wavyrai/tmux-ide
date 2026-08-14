import {
  applicationShellSessionTargetKey,
  createApplicationShellSession,
  type ApplicationShellSession,
  type ApplicationShellSessionState,
} from "./application-shell-session.ts";
import {
  defaultGenerationBoundClock,
  type GenerationBoundClock,
} from "./generation-bound-store.ts";
import {
  createRuntimeConnectionSupervisor,
  type RuntimeConnectionSupervisor,
} from "./connection-supervisor.ts";
import {
  createWorkspaceClientOperationLedger,
  type WorkspaceClientOperationLedger,
} from "./workspace-client-operations.ts";
import {
  initialWorkspaceCatalogV2State,
  replaceWorkspaceCatalogV2,
  type WorkspaceCatalogV2State,
} from "./workspace-catalog-v2.ts";
import type {
  ActionName,
  ApplicationShellProjectionInputV1,
  ApplicationShellReplayStateV1,
  SessionRuntimeAuthorityKind,
  TerminalReplicaAddress,
  TerminalReplicaUpdate,
  WorkspaceOpenPreparedResult,
} from "@tmux-ide/contracts";
import {
  createApplicationShellReplayState,
  projectApplicationShellSession,
  reconcileApplicationShellReplayState,
  reduceApplicationShellTransaction,
} from "@tmux-ide/core";

import type {
  WorkspaceClient,
  WorkspaceClientDispatch,
  WorkspaceClientDispatchResult,
  WorkspaceClientOptions,
  WorkspaceClientPhase,
  WorkspaceClientRuntimePort,
  WorkspaceClientScope,
  WorkspaceClientScopeValue,
  WorkspaceClientSnapshot,
} from "./workspace-client-types.ts";

const DEFAULT_OPERATION_TIMEOUT_MS = 2_000;

interface TerminalInterest<Snapshot, Patch> {
  readonly target: TerminalReplicaAddress;
  readonly listeners: Set<(update: TerminalReplicaUpdate<Snapshot, Patch>) => void>;
  subscription: Awaited<
    ReturnType<WorkspaceClientRuntimePort<Snapshot, Patch>["subscribeTerminal"]>
  > | null;
  unsubscribeUpdate: (() => void) | null;
  opening: boolean;
}

interface PreparedOpen {
  readonly generation: number;
  readonly result: WorkspaceOpenPreparedResult;
}

function phaseOf<Shell extends ApplicationShellProjectionInputV1>(
  state: ApplicationShellSessionState<Shell>,
): WorkspaceClientPhase {
  switch (state.status) {
    case "loading":
    case "live":
    case "stale":
    case "degraded":
    case "unavailable":
    case "error":
    case "disposed":
      return state.status;
  }
}

function terminalKey(target: TerminalReplicaAddress): string {
  return `${target.workspaceName}\u0000${target.semanticPaneId}`;
}

function scopeValue<
  Shell extends ApplicationShellProjectionInputV1,
  Scope extends WorkspaceClientScope,
>(snapshot: WorkspaceClientSnapshot<Shell>, scope: Scope): WorkspaceClientScopeValue<Shell, Scope> {
  switch (scope) {
    case "lifecycle":
      return {
        generation: snapshot.generation,
        target: snapshot.target,
        phase: snapshot.phase,
        shell: snapshot.shell,
      } as WorkspaceClientScopeValue<Shell, Scope>;
    case "semantic":
      return snapshot.semantic as WorkspaceClientScopeValue<Shell, Scope>;
    case "catalog":
      return snapshot.catalog as WorkspaceClientScopeValue<Shell, Scope>;
    case "authority":
      return snapshot.authority as WorkspaceClientScopeValue<Shell, Scope>;
    case "operations":
      return snapshot.operations as WorkspaceClientScopeValue<Shell, Scope>;
  }
}

function isPreparedOpen(value: unknown): value is WorkspaceOpenPreparedResult {
  if (typeof value !== "object" || value === null) return false;
  return (value as { phase?: unknown }).phase === "prepared";
}

function waitWithClock(
  clock: GenerationBoundClock,
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = clock.setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Renderer-neutral product client. It composes already-validated ports and the
 * shared core reducers; transport credentials and physical socket policy stay
 * in host adapters.
 */
export function createWorkspaceClient<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
  TerminalSnapshot = unknown,
  TerminalPatch = unknown,
>(
  options: WorkspaceClientOptions<Shell, TerminalSnapshot, TerminalPatch>,
): WorkspaceClient<Shell, TerminalSnapshot, TerminalPatch> {
  const clock: GenerationBoundClock = options.clock ?? defaultGenerationBoundClock;
  const operationId = options.operationId ?? (() => crypto.randomUUID());
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const listeners = new Map<WorkspaceClientScope, Set<(value: unknown) => void>>();
  const terminals = new Map<string, TerminalInterest<TerminalSnapshot, TerminalPatch>>();

  let disposed = false;
  let generation = 1;
  let target = options.target;
  let targetKey = applicationShellSessionTargetKey(target);
  let shellState!: ApplicationShellSessionState<Shell>;
  let authorityShell: Shell | null = null;
  let replay: ApplicationShellReplayStateV1 | null = null;
  let semantic: WorkspaceClientSnapshot<Shell>["semantic"] = null;
  let catalog: WorkspaceCatalogV2State = initialWorkspaceCatalogV2State();
  let authority: WorkspaceClientSnapshot<Shell>["authority"] = null;
  let snapshot!: WorkspaceClientSnapshot<Shell>;
  let runtime: WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch> | null = null;
  let runtimeSupervisor: RuntimeConnectionSupervisor<
    WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch>
  > | null = null;
  let runtimeSupervisorUnsubscribe: (() => void) | null = null;
  let runtimeReceiptUnsubscribe: (() => void) | null = null;
  let runtimeAuthorityUnsubscribe: (() => void) | null = null;
  let catalogController: AbortController | null = null;
  let catalogConnection: { close(): void } | null = null;
  let preparedOpen: PreparedOpen | null = null;

  const notify = (scope: WorkspaceClientScope): void => {
    const value = scopeValue(snapshot, scope);
    for (const listener of [...(listeners.get(scope) ?? [])]) {
      try {
        listener(value);
      } catch {
        // Renderer observers cannot interrupt another observer or lifecycle cleanup.
      }
    }
  };
  const rebuild = (scopes: readonly WorkspaceClientScope[]): void => {
    snapshot = Object.freeze({
      generation,
      target: disposed ? null : target,
      phase: disposed ? "disposed" : phaseOf(shellState),
      shell: shellState,
      authorityShell,
      semantic,
      catalog,
      authority,
      operations: ledger.getSnapshot(),
    });
    for (const scope of new Set(scopes)) notify(scope);
  };
  const ledger: WorkspaceClientOperationLedger = createWorkspaceClientOperationLedger({
    clock,
    initialGeneration: generation,
    onChange: () => rebuild(["operations"]),
  });

  const applyShell = (next: ApplicationShellSessionState<Shell>): void => {
    if (disposed) return;
    shellState = next;
    const nextInput = "data" in next ? next.data : null;
    if (nextInput !== null) {
      replay =
        authorityShell === null || replay === null
          ? createApplicationShellReplayState(nextInput)
          : reconcileApplicationShellReplayState(authorityShell, nextInput, replay);
      authorityShell = nextInput;
      semantic = projectApplicationShellSession(nextInput, replay);
      rebuild(["lifecycle", "semantic"]);
      return;
    }
    if (next.status !== "stale" && next.status !== "degraded") {
      authorityShell = null;
      replay = null;
      semantic = null;
    }
    rebuild(["lifecycle", "semantic"]);
  };

  const shellSession: ApplicationShellSession<Shell> = createApplicationShellSession({
    target,
    transport: options.ports.shell,
    clock,
    onInteractionReceipt: (receipt) => {
      ledger.receipt(receipt, generation);
    },
  });
  shellState = shellSession.getState();
  snapshot = Object.freeze({
    generation,
    target,
    phase: phaseOf(shellState),
    shell: shellState,
    authorityShell,
    semantic,
    catalog,
    authority,
    operations: ledger.getSnapshot(),
  });
  const unsubscribeShell = shellSession.subscribe(applyShell);

  const closeTerminal = (interest: TerminalInterest<TerminalSnapshot, TerminalPatch>): void => {
    interest.opening = false;
    interest.unsubscribeUpdate?.();
    interest.unsubscribeUpdate = null;
    const subscription = interest.subscription;
    interest.subscription = null;
    void subscription?.close().catch(() => undefined);
  };
  const openTerminal = (interest: TerminalInterest<TerminalSnapshot, TerminalPatch>): void => {
    if (
      disposed ||
      runtime === null ||
      interest.opening ||
      interest.subscription !== null ||
      interest.listeners.size === 0
    ) {
      return;
    }
    const expectedGeneration = generation;
    const expectedRuntime = runtime;
    interest.opening = true;
    void expectedRuntime
      .subscribeTerminal(interest.target)
      .then((subscription) => {
        interest.opening = false;
        if (
          disposed ||
          generation !== expectedGeneration ||
          runtime !== expectedRuntime ||
          interest.listeners.size === 0 ||
          subscription.generation !== target.daemon.instanceId
        ) {
          void subscription.close().catch(() => undefined);
          return;
        }
        interest.subscription = subscription;
        interest.unsubscribeUpdate = subscription.onUpdate((update) => {
          if (
            disposed ||
            generation !== expectedGeneration ||
            runtime !== expectedRuntime ||
            update.generation !== target.daemon.instanceId ||
            update.workspaceName !== interest.target.workspaceName ||
            update.semanticPaneId !== interest.target.semanticPaneId
          ) {
            return;
          }
          // The terminal fast lane intentionally never rebuilds the semantic snapshot.
          for (const listener of [...interest.listeners]) listener(update);
        });
      })
      .catch(() => {
        interest.opening = false;
      });
  };

  const retireRuntime = (): void => {
    runtimeSupervisorUnsubscribe?.();
    runtimeSupervisorUnsubscribe = null;
    const supervisor = runtimeSupervisor;
    runtimeSupervisor = null;
    runtimeReceiptUnsubscribe?.();
    runtimeReceiptUnsubscribe = null;
    runtimeAuthorityUnsubscribe?.();
    runtimeAuthorityUnsubscribe = null;
    for (const interest of terminals.values()) closeTerminal(interest);
    runtime = null;
    void supervisor?.stop();
  };
  const connectRuntime = (): void => {
    retireRuntime();
    const expectedGeneration = generation;
    const expectedTarget = target;
    const supervisor = createRuntimeConnectionSupervisor<
      WorkspaceClientRuntimePort<TerminalSnapshot, TerminalPatch>
    >({
      wait: (delayMs, signal) => waitWithClock(clock, delayMs, signal),
      connect: async ({ signal }) => {
        const nextRuntime = await options.ports.connectRuntime(expectedTarget, signal);
        if (nextRuntime.generation !== expectedTarget.daemon.instanceId) {
          void nextRuntime.close();
          throw new Error("session runtime connected to another daemon generation");
        }
        return {
          value: nextRuntime,
          closed: nextRuntime.closed,
          dispose: () => nextRuntime.close(),
        };
      },
    });
    runtimeSupervisor = supervisor;
    runtimeSupervisorUnsubscribe = supervisor.subscribe((state) => {
      if (
        disposed ||
        generation !== expectedGeneration ||
        target !== expectedTarget ||
        runtimeSupervisor !== supervisor
      ) {
        return;
      }
      if (state.phase !== "live" || state.value === null) {
        runtimeReceiptUnsubscribe?.();
        runtimeReceiptUnsubscribe = null;
        runtimeAuthorityUnsubscribe?.();
        runtimeAuthorityUnsubscribe = null;
        runtime = null;
        for (const interest of terminals.values()) closeTerminal(interest);
        return;
      }
      const nextRuntime = state.value;
      if (runtime === nextRuntime) return;
      runtime = nextRuntime;
      runtimeReceiptUnsubscribe = nextRuntime.onReceipt((receipt) => {
        if (generation !== expectedGeneration || runtime !== nextRuntime) return;
        ledger.receipt(receipt, expectedGeneration);
      });
      runtimeAuthorityUnsubscribe =
        nextRuntime.onAuthority?.((nextAuthority) => {
          if (
            generation !== expectedGeneration ||
            runtime !== nextRuntime ||
            nextAuthority.generation !== expectedTarget.daemon.instanceId
          ) {
            return;
          }
          authority = nextAuthority;
          rebuild(["authority"]);
        }) ?? null;
      for (const interest of terminals.values()) openTerminal(interest);
    });
    supervisor.start();
  };

  const retireCatalog = (): void => {
    catalogController?.abort();
    catalogController = null;
    try {
      catalogConnection?.close();
    } catch {
      // Logical retirement is already complete.
    }
    catalogConnection = null;
  };
  const readCatalog = (): void => {
    const port = options.ports.catalog;
    if (port === undefined || disposed) return;
    catalogController?.abort();
    const expectedGeneration = generation;
    const expectedTarget = target;
    const controller = new AbortController();
    catalogController = controller;
    void port
      .read(expectedTarget, controller.signal)
      .then((input) => {
        if (
          disposed ||
          controller.signal.aborted ||
          expectedGeneration !== generation ||
          expectedTarget !== target
        ) {
          return;
        }
        catalogController = null;
        catalog = replaceWorkspaceCatalogV2(catalog, input);
        rebuild(["catalog"]);
      })
      .catch(() => {
        if (expectedGeneration === generation && catalogController === controller) {
          catalogController = null;
        }
      });
  };
  const connectCatalog = (): void => {
    retireCatalog();
    const port = options.ports.catalog;
    if (port === undefined) return;
    const expectedGeneration = generation;
    const expectedTarget = target;
    catalogConnection = port.subscribe(expectedTarget, () => {
      if (generation === expectedGeneration && target === expectedTarget) readCatalog();
    });
    readCatalog();
  };

  connectRuntime();
  connectCatalog();

  const cancelPreparedOpenBestEffort = (): void => {
    const prepared = preparedOpen;
    if (prepared === null) return;
    preparedOpen = null;
    const expectedGeneration = prepared.generation;
    const expectedTarget = target;
    const id = operationId();
    const began = ledger.begin({
      operationId: id,
      generation: expectedGeneration,
      kind: "owner-action",
      timeoutMs: operationTimeoutMs,
    });
    if (!began) return;
    void options.ports.actions
      .dispatch({
        target: expectedTarget,
        name: "workspace.open.cancel",
        input: {
          prepareToken: prepared.result.prepareToken,
          preparedRevision: prepared.result.preparedRevision,
        },
        operationId: id,
      })
      .then(
        () => ledger.terminal(id, expectedGeneration),
        () => ledger.terminal(id, expectedGeneration),
      );
  };

  const dispatchOwnerAction = async (
    command: Extract<WorkspaceClientDispatch, { kind: "owner-action" }>,
  ): Promise<WorkspaceClientDispatchResult> => {
    const expectedGeneration = generation;
    const expectedTarget = target;
    const id = command.operationId ?? operationId();
    const began = ledger.begin({
      operationId: id,
      generation: expectedGeneration,
      kind: "owner-action",
      timeoutMs: operationTimeoutMs,
    });
    if (!began) throw new Error(`operation ${id} is already pending or terminal`);
    if (
      (command.name === "workspace.open.commit" || command.name === "workspace.open.cancel") &&
      preparedOpen === null
    ) {
      ledger.terminal(id, expectedGeneration);
      throw new Error("workspace open decision requires a prepared open in this generation");
    }
    if (command.name === "workspace.open.commit" || command.name === "workspace.open.cancel") {
      const decision = command.input as { prepareToken: string; preparedRevision: number };
      if (
        preparedOpen?.generation !== expectedGeneration ||
        preparedOpen.result.prepareToken !== decision.prepareToken ||
        preparedOpen.result.preparedRevision !== decision.preparedRevision
      ) {
        ledger.terminal(id, expectedGeneration);
        throw new Error("workspace open decision does not match the prepared open");
      }
    }
    let result;
    try {
      result = await options.ports.actions.dispatch({
        target: expectedTarget,
        name: command.name as ActionName,
        input: command.input,
        operationId: id,
      });
    } catch (error) {
      ledger.terminal(id, expectedGeneration);
      throw error;
    }
    if (disposed || generation !== expectedGeneration || target !== expectedTarget) {
      throw new Error("workspace action completed after its client generation was retired");
    }
    if (command.name === "workspace.open.prepare" && isPreparedOpen(result)) {
      preparedOpen = { generation: expectedGeneration, result };
    }
    if (command.name === "workspace.open.commit" || command.name === "workspace.open.cancel") {
      preparedOpen = null;
    }
    ledger.terminal(id, expectedGeneration);
    return { kind: "owner-action", operationId: id, result };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(scope, listener) {
      const bucket = listeners.get(scope) ?? new Set<(value: unknown) => void>();
      listeners.set(scope, bucket);
      const untyped = listener as (value: unknown) => void;
      bucket.add(untyped);
      untyped(scopeValue(snapshot, scope));
      return () => bucket.delete(untyped);
    },
    setTarget(nextTarget) {
      if (disposed) return;
      const nextKey = applicationShellSessionTargetKey(nextTarget);
      if (nextKey === targetKey) return;
      cancelPreparedOpenBestEffort();
      generation += 1;
      target = nextTarget;
      targetKey = nextKey;
      preparedOpen = null;
      authorityShell = null;
      replay = null;
      semantic = null;
      catalog = initialWorkspaceCatalogV2State();
      authority = null;
      ledger.replaceGeneration(generation);
      retireRuntime();
      retireCatalog();
      shellSession.setTarget(nextTarget);
      rebuild(["lifecycle", "semantic", "catalog", "authority", "operations"]);
      connectRuntime();
      connectCatalog();
    },
    refresh() {
      if (disposed) return;
      shellSession.refresh();
      readCatalog();
    },
    async dispatch(command) {
      if (disposed) throw new Error("workspace client is disposed");
      if (command.kind === "application-shell") {
        if (authorityShell === null || replay === null) {
          throw new Error("application shell is not available");
        }
        replay = reduceApplicationShellTransaction(replay, [command.invocation]).state;
        semantic = projectApplicationShellSession(authorityShell, replay);
        rebuild(["semantic"]);
        return { kind: "application-shell", operationId: null };
      }
      if (command.kind === "owner-action") return dispatchOwnerAction(command);
      const expectedGeneration = generation;
      const expectedRuntime = runtime;
      if (expectedRuntime === null) throw new Error("session runtime is not connected");
      const id = command.operationId ?? operationId();
      const began = ledger.begin({
        operationId: id,
        generation: expectedGeneration,
        kind: "semantic-intent",
        timeoutMs: operationTimeoutMs,
      });
      if (!began) throw new Error(`operation ${id} is already pending or terminal`);
      try {
        const result = await expectedRuntime.submitIntent(id, command.intent);
        if (disposed || generation !== expectedGeneration || runtime !== expectedRuntime) {
          throw new Error("semantic intent completed after its client generation was retired");
        }
        return { kind: "semantic-intent", operationId: id, result };
      } catch (error) {
        ledger.terminal(id, expectedGeneration);
        throw error;
      }
    },
    subscribeTerminal(nextTarget, listener) {
      if (disposed) return () => undefined;
      const key = terminalKey(nextTarget);
      const interest =
        terminals.get(key) ??
        ({
          target: nextTarget,
          listeners: new Set(),
          subscription: null,
          unsubscribeUpdate: null,
          opening: false,
        } satisfies TerminalInterest<TerminalSnapshot, TerminalPatch>);
      terminals.set(key, interest);
      interest.listeners.add(listener);
      openTerminal(interest);
      return () => {
        interest.listeners.delete(listener);
        if (interest.listeners.size > 0) return;
        terminals.delete(key);
        closeTerminal(interest);
      };
    },
    setPresence(state) {
      runtime?.setPresence?.(state);
    },
    noteActivity(activity) {
      runtime?.noteActivity?.(activity);
    },
    requestAuthority(authorityKind: SessionRuntimeAuthorityKind) {
      return runtime?.requestAuthority?.(authorityKind) ?? Promise.resolve(null);
    },
    releaseAuthority(authorityKind: SessionRuntimeAuthorityKind) {
      return runtime?.releaseAuthority?.(authorityKind) ?? Promise.resolve();
    },
    dispose() {
      if (disposed) return;
      cancelPreparedOpenBestEffort();
      disposed = true;
      retireRuntime();
      retireCatalog();
      unsubscribeShell();
      shellSession.dispose();
      ledger.dispose();
      shellState = shellSession.getState();
      snapshot = Object.freeze({
        generation,
        target: null,
        phase: "disposed",
        shell: shellState,
        authorityShell: null,
        semantic: null,
        catalog: initialWorkspaceCatalogV2State(),
        authority: null,
        operations: ledger.getSnapshot(),
      });
      for (const scope of listeners.keys()) notify(scope);
      listeners.clear();
      terminals.clear();
    },
  };
}
