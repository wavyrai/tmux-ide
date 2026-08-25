import {
  MULTIPLEXER_VERB_TABLE,
  workspacePaneCreateInvocation,
  type ActionInput,
  type ActionName,
  type ActionResult,
  type ApplicationShellProjectionInputV1,
  type DesktopApplicationShellTarget,
  type HostCapabilities,
  type SessionRuntimeSemanticIntent,
  type TerminalReplicaPatchPayload,
  type TerminalReplicaSnapshot,
  type TerminalReplicaTombstonePayload,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import {
  createWorkspaceClient,
  type WorkspaceClient,
  type WorkspaceClientCatalogPort,
  type WorkspaceClientPorts,
  type WorkspaceClientOwnerActionPort,
} from "@tmux-ide/daemon-client";

import { createHostDaemonTransport } from "./host-daemon-transport.ts";
import { createHostPaneStreamTransport } from "./host-pane-stream-transport.ts";
import {
  connectWebWorkspaceRuntime,
  type WebWorkspaceRuntimePort,
} from "./web-workspace-runtime.ts";
import { recordCard5RuntimeReplacement } from "./card5-envelope-evidence.ts";
import {
  createWebWorkspacePaneStreamBridge,
  type WebWorkspacePaneStreamBridge,
} from "./web-workspace-pane-stream-bridge.ts";

export type WebWorkspaceClient = WorkspaceClient<
  ApplicationShellProjectionInputV1,
  TerminalReplicaSnapshot,
  TerminalReplicaPatchPayload,
  TerminalReplicaTombstonePayload
>;

const paneStreamBridges = new WeakMap<WebWorkspaceClient, WebWorkspacePaneStreamBridge>();

export function paneStreamBridgeForWebWorkspaceClient(
  client: WebWorkspaceClient,
): WebWorkspacePaneStreamBridge {
  const bridge = paneStreamBridges.get(client);
  if (!bridge) throw new Error("The Web workspace client has no compositor bridge.");
  return bridge;
}

export class WebWorkspaceHostActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebWorkspaceHostActionError";
  }
}

export function createWebWorkspaceCatalogPort(host: HostCapabilities): WorkspaceClientCatalogPort {
  return {
    async read(target, signal) {
      if (signal.aborted) throw signal.reason;
      const result = await host.daemon.fetchWorkspaceCatalog();
      if (result.status === "error") hostFailure(result);
      if (signal.aborted) throw signal.reason;
      if (result.envelope.daemon.instanceId !== target.daemon.instanceId) {
        throw new Error("The Web catalog returned another daemon generation.");
      }
      return result.envelope;
    },
    subscribe(_target, invalidate) {
      const controller = new AbortController();
      let unsubscribe: (() => void) | null = null;
      void host.daemon
        .subscribe(
          {
            workspaceNames: [],
            resourceInterests: [{ resource: "workspace-catalog", workspaceName: null }],
          },
          (event) => {
            if (!controller.signal.aborted && event.type === "workspaces.changed") {
              invalidate();
            }
          },
          controller.signal,
        )
        .then((result) => {
          if (result.status !== "subscribed") return;
          if (controller.signal.aborted) result.unsubscribe();
          else unsubscribe = result.unsubscribe;
        })
        .catch(() => undefined);
      return {
        close() {
          controller.abort();
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
  };
}

function hostFailure(result: {
  readonly status: "error";
  readonly error: { readonly code?: string; readonly reason: string };
}): never {
  throw new WebWorkspaceHostActionError(result.error.code ?? "request-failed", result.error.reason);
}

export function createWebWorkspaceOwnerActionPort(
  host: HostCapabilities,
): WorkspaceClientOwnerActionPort {
  return {
    async dispatch<Name extends ActionName>({
      target,
      name,
      input,
      operationId,
    }: {
      readonly target: DesktopApplicationShellTarget;
      readonly name: Name;
      readonly input: ActionInput<Name>;
      readonly operationId: string;
    }): Promise<ActionResult<Name> | null> {
      const expectedDaemonInstanceId = target.daemon.instanceId;
      const workspaceName = target.workspaceName;
      let value: unknown;
      if (name === "workspace.open.prepare") {
        const request = input as ActionInput<"workspace.open.prepare">;
        if (
          request.previousWorkspaceName !== undefined &&
          request.previousWorkspaceName !== null &&
          request.previousWorkspaceName !== workspaceName
        ) {
          throw new Error("The Web workspace prepare action targeted another workspace.");
        }
        const result = await host.workspace.prepareProjectDirectory?.(
          request.previousWorkspaceName ?? null,
          operationId,
        );
        if (!result) return null;
        value = result.status === "ok" ? result.result : hostFailure(result);
      } else if (name === "workspace.open.commit") {
        const request = input as ActionInput<"workspace.open.commit">;
        const result = await host.workspace.commitPreparedOpen?.(request, operationId);
        if (!result) throw new Error("Atomic workspace commit is unavailable.");
        value = result.status === "ok" ? result.result : hostFailure(result);
        if (
          result.status === "ok" &&
          (result.result.prepareToken !== request.prepareToken ||
            result.result.preparedRevision !== request.preparedRevision)
        ) {
          throw new Error("The Web workspace commit returned another prepared decision.");
        }
      } else if (name === "workspace.open.cancel") {
        const request = input as ActionInput<"workspace.open.cancel">;
        const result = await host.workspace.cancelPreparedOpen?.(request, operationId);
        if (!result) throw new Error("Atomic workspace cancellation is unavailable.");
        value = result.status === "ok" ? result.result : hostFailure(result);
        if (
          result.status === "ok" &&
          (result.result.prepareToken !== request.prepareToken ||
            result.result.preparedRevision !== request.preparedRevision)
        ) {
          throw new Error("The Web workspace cancellation returned another prepared decision.");
        }
      } else if (name === "workspace.pane.create") {
        const request = input as ActionInput<"workspace.pane.create">;
        if (request.workspaceName !== workspaceName) {
          throw new Error("The Web pane action targeted another workspace.");
        }
        const result = await host.daemon.createWorkspacePane(
          workspacePaneCreateInvocation(
            request,
            {
              kind: "program",
              surface: "web-workspace-client",
            },
            operationId,
          ),
        );
        value = result.status === "ok" ? result.result : hostFailure(result);
      } else if (name === "workspace.app-window.mutate") {
        const request = input as ActionInput<"workspace.app-window.mutate">;
        if (request.workspaceName !== workspaceName) {
          throw new Error("The Web window action targeted another workspace.");
        }
        const result = await host.daemon.mutateAppWindow({ operationId, intent: request });
        value = result.status === "ok" ? result.result : hostFailure(result);
      } else {
        throw new Error(`The Web host does not expose owner action ${name}.`);
      }
      if (
        value &&
        typeof value === "object" &&
        "daemonInstanceId" in value &&
        value.daemonInstanceId !== expectedDaemonInstanceId
      ) {
        throw new Error("The Web workspace action returned another daemon generation.");
      }
      if (
        value &&
        typeof value === "object" &&
        "operationId" in value &&
        value.operationId !== operationId
      ) {
        throw new Error("The Web workspace action returned another operation correlation.");
      }
      return value as ActionResult<Name>;
    },
  };
}

export async function submitWebWorkspaceSemanticIntent(
  host: HostCapabilities,
  expectedDaemonInstanceId: string,
  expectedWorkspaceName: string,
  operationId: string,
  intent: SessionRuntimeSemanticIntent,
): Promise<WorkspaceMultiplexerMutationResult | null> {
  if (intent.verb === "workspace.pane.read") return null;
  if (intent.workspaceName !== expectedWorkspaceName) {
    throw new Error("The semantic workspace intent targeted another workspace.");
  }
  const entry = MULTIPLEXER_VERB_TABLE.find(
    (candidate) =>
      candidate.execution.kind === "daemon-action" && candidate.execution.action === intent.verb,
  );
  if (!entry) throw new Error("The semantic workspace intent has no reviewed host verb.");
  const result = await host.daemon.invokeVerb({ operationId, verbId: entry.id, intent });
  if (result.status === "error") hostFailure(result);
  if (
    result.result.operationId !== operationId ||
    result.result.daemonInstanceId !== expectedDaemonInstanceId
  ) {
    throw new Error("The semantic workspace result did not match its operation authority.");
  }
  return result.result;
}

type WebWorkspaceRuntimeBridgePorts = Pick<
  WorkspaceClientPorts<
    ApplicationShellProjectionInputV1,
    TerminalReplicaSnapshot,
    TerminalReplicaPatchPayload,
    TerminalReplicaTombstonePayload
  >,
  "connectRuntime" | "didActivateRuntime"
>;

function coalesceCandidatePaneEvent(
  current: Parameters<WebWorkspacePaneStreamBridge["publishPane"]>[1] | undefined,
  next: Parameters<WebWorkspacePaneStreamBridge["publishPane"]>[1],
): Parameters<WebWorkspacePaneStreamBridge["publishPane"]>[1] {
  const replayable = (event: typeof next): boolean =>
    event.type === "seed-batch" || (event.type === "output" && event.replay !== undefined);
  if (next.type === "closed" || replayable(next)) return next;
  return current && replayable(current) ? current : next;
}

/** Shared candidate/activation fence between WorkspaceClient and the local compositor. */
export function createWebWorkspaceRuntimeBridgePorts(input: {
  readonly host: HostCapabilities;
  readonly bridge: WebWorkspacePaneStreamBridge;
  readonly connect?: typeof connectWebWorkspaceRuntime;
}): WebWorkspaceRuntimeBridgePorts {
  const { host, bridge } = input;
  const connect = input.connect ?? connectWebWorkspaceRuntime;
  const activateRuntime = new WeakMap<WebWorkspaceRuntimePort, () => void>();
  let activeRuntime: WebWorkspaceRuntimePort | null = null;
  return {
    async connectRuntime(runtimeTarget, inventory, signal, prepare) {
      const stagedPanes = new Map<
        string,
        Parameters<WebWorkspacePaneStreamBridge["publishPane"]>[1]
      >();
      let stagedPaneEvents = 0;
      let stagedLayout: Parameters<WebWorkspacePaneStreamBridge["publishLayout"]>[0] | null = null;
      let stagedLayoutSnapshot:
        | Parameters<WebWorkspacePaneStreamBridge["publishLayoutSnapshot"]>[0]
        | null = null;
      let stagedSession: Parameters<WebWorkspacePaneStreamBridge["bindSession"]>[0] = null;
      let activated = false;
      let runtime!: WebWorkspaceRuntimePort;
      runtime = await connect({
        transport: createHostPaneStreamTransport(host, runtimeTarget.daemon),
        inventory,
        signal,
        submitIntent: (operationId, intent) =>
          submitWebWorkspaceSemanticIntent(
            host,
            runtimeTarget.daemon.instanceId,
            runtimeTarget.workspaceName,
            operationId,
            intent,
          ),
        onPaneEvent: (pane, event) => {
          if (activated) {
            if (activeRuntime === runtime) bridge.publishPane(pane, event);
          } else {
            if (++stagedPaneEvents > 8_192) {
              throw new Error("candidate pane staging exceeded its bounded event count");
            }
            stagedPanes.set(pane, coalesceCandidatePaneEvent(stagedPanes.get(pane), event));
          }
        },
        onLayout: (layout) => {
          if (activated) {
            if (activeRuntime === runtime) bridge.publishLayout(layout);
          } else stagedLayout = layout;
        },
        onLayoutSnapshot: (snapshot) => {
          if (activated) {
            if (activeRuntime === runtime) bridge.publishLayoutSnapshot(snapshot);
          } else stagedLayoutSnapshot = snapshot;
        },
        onSession: (session) => {
          if (activated) {
            if (activeRuntime === runtime) bridge.bindSession(session, inventory.workspaceName);
          } else stagedSession = session;
        },
        onEnd: () => {
          if (activated && activeRuntime === runtime) {
            activeRuntime = null;
            bridge.end(null);
          }
        },
      });
      try {
        await prepare(runtime);
      } catch (error) {
        runtime.close();
        throw error;
      }
      activateRuntime.set(runtime, () => {
        if (activated || signal.aborted) return;
        activated = true;
        recordCard5RuntimeReplacement(activeRuntime?.generation ?? null, runtime.generation);
        activeRuntime = runtime;
        bridge.bindSession(stagedSession, inventory.workspaceName);
        bridge.replacePaneSet(new Set(inventory.semanticPaneIds));
        if (stagedLayoutSnapshot) bridge.publishLayoutSnapshot(stagedLayoutSnapshot);
        else if (stagedLayout) bridge.publishLayout(stagedLayout);
        for (const [pane, event] of stagedPanes) {
          const authoritative =
            event.type === "output" && event.replay
              ? {
                  type: "seed-batch" as const,
                  batch: event.replay(),
                  ...(event.canonical ? { canonical: event.canonical } : {}),
                  ...(event.canonicalUpdate ? { canonicalUpdate: event.canonicalUpdate } : {}),
                  ...(event.canonicalSnapshot
                    ? { canonicalSnapshot: event.canonicalSnapshot }
                    : {}),
                }
              : event;
          bridge.publishPane(pane, authoritative);
        }
        stagedPanes.clear();
        stagedLayout = null;
        stagedLayoutSnapshot = null;
      });
      return runtime;
    },
    didActivateRuntime(runtime) {
      activateRuntime.get(runtime)?.();
      activateRuntime.delete(runtime);
    },
  };
}

/** Creates the one production Web WorkspaceClient for one daemon generation. */
export function createWebWorkspaceClient(input: {
  readonly host: HostCapabilities;
  readonly target: DesktopApplicationShellTarget;
}): WebWorkspaceClient {
  const { host, target } = input;
  const bridge = createWebWorkspacePaneStreamBridge(target.workspaceName);
  const runtimeBridgePorts = createWebWorkspaceRuntimeBridgePorts({ host, bridge });
  const client = createWorkspaceClient<
    ApplicationShellProjectionInputV1,
    TerminalReplicaSnapshot,
    TerminalReplicaPatchPayload,
    TerminalReplicaTombstonePayload
  >({
    target,
    ports: {
      shell: createHostDaemonTransport(host),
      catalog: createWebWorkspaceCatalogPort(host),
      actions: createWebWorkspaceOwnerActionPort(host),
      ...runtimeBridgePorts,
    },
  });
  paneStreamBridges.set(client, bridge);
  return client;
}
