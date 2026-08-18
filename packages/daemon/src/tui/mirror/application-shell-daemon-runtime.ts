import { randomUUID } from "node:crypto";
import type {
  PaneStreamServerFrame,
  SessionRuntimeActivityKind,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthorityLease,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimePresenceState,
  SessionRuntimeSemanticIntent,
  TerminalDeliveryAck,
  TerminalDeliveryNack,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import { type PaneStreamRuntimeClient } from "@tmux-ide/daemon-client/pane-stream-client";

import { isCanonicalDaemonAlive, readCanonicalDaemonInfo } from "../../lib/canonical-daemon.ts";
import {
  fetchCanonicalWorkspaceRouting,
  workspaceNameForLiveSession,
} from "./canonical-workspace-routing.ts";
import {
  createOpenTuiVerifiedRoutingContext,
  type OpenTuiVerifiedRoutingContext,
  type OpenTuiVerifiedRoutingIdentity,
} from "./open-tui-verified-routing.ts";
import {
  createOpenTuiPaneStreamSocket,
  type OpenTuiPaneStreamSocketDependencies,
} from "./open-tui-pane-stream-socket.ts";
import {
  SemanticPaneReplica,
  SemanticTerminalRenderSource,
  type SemanticPaneReplicaChange,
} from "./semantic-pane-render-source.ts";

const OPENTUI_ORIGIN = "tmux-ide://opentui";
const OPENTUI_HOST_CLIENT_ID = `opentui:${process.pid}`;

export { createOpenTuiPaneStreamSocket };
export type { OpenTuiPaneStreamSocketDependencies };

export interface OpenTuiSessionRuntimeLane {
  readonly daemonInstanceId: string;
  readonly workspaceName: string;
  readonly generation: string | null;
  readonly connectionIdentity: string;
  readonly viewerMode: "interactive" | "read-only";
  readonly ownsInput: boolean;
  readonly ownsGeometry: boolean;
  readonly authoritySnapshot: SessionRuntimeAuthoritySnapshot | null;
  readonly source: SemanticTerminalRenderSource;
  sendText(semanticPaneId: string, text: string, performanceTraceId?: string): void;
  sendKey(semanticPaneId: string, key: string, performanceTraceId?: string): void;
  fitViewport(cols: number, rows: number): Promise<void>;
  submit(
    intent: SessionRuntimeSemanticIntent,
    operationId?: string,
  ): Promise<WorkspaceMultiplexerMutationResult | null>;
  setPresence(state: SessionRuntimePresenceState): void;
  noteActivity(activity: SessionRuntimeActivityKind): void;
  requestAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthorityLease | null>;
  releaseAuthority(
    authority: SessionRuntimeAuthorityKind,
  ): Promise<SessionRuntimeAuthoritySnapshot>;
  close(): void;
}

export interface ConnectOpenTuiSessionRuntimeOptions {
  readonly sessionName: string;
  readonly semanticPaneIds: readonly string[];
  readonly routing?: OpenTuiVerifiedRoutingContext | null;
  readonly onPaneChange: (paneId: string, change: SemanticPaneReplicaChange) => void;
  readonly onLayout?: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
  readonly onAuthoritySnapshot?: (snapshot: SessionRuntimeAuthoritySnapshot) => void;
  readonly onFault?: (error: Error) => void;
}

interface ConnectOpenTuiSessionRuntimeDependencies {
  readonly readCanonicalDaemonInfo: typeof readCanonicalDaemonInfo;
  readonly isCanonicalDaemonAlive: typeof isCanonicalDaemonAlive;
  readonly fetchCanonicalWorkspaceRouting: typeof fetchCanonicalWorkspaceRouting;
  readonly createRoutingContext: typeof createOpenTuiVerifiedRoutingContext;
}

const DEFAULT_RUNTIME_DEPENDENCIES: ConnectOpenTuiSessionRuntimeDependencies = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetchCanonicalWorkspaceRouting,
  createRoutingContext: createOpenTuiVerifiedRoutingContext,
};

/**
 * Open the one owner-brokered, generation-bound runtime lane for an OpenTUI
 * process/session. One WebSocket carries layout, N semantic terminal replicas,
 * controller input, resize/focus intents and their observed settlements.
 */
export async function connectOpenTuiSessionRuntime(
  options: ConnectOpenTuiSessionRuntimeOptions,
  overrides: Partial<ConnectOpenTuiSessionRuntimeDependencies> = {},
): Promise<OpenTuiSessionRuntimeLane | null> {
  if (options.semanticPaneIds.length === 0) return null;
  const dependencies = { ...DEFAULT_RUNTIME_DEPENDENCIES, ...overrides };
  let routing = options.routing ?? null;
  if (!routing) {
    const daemon = dependencies.readCanonicalDaemonInfo();
    if (!daemon?.authToken || !(await dependencies.isCanonicalDaemonAlive(daemon))) return null;
    const catalog = await dependencies.fetchCanonicalWorkspaceRouting(daemon);
    const workspaceName = workspaceNameForLiveSession(catalog, options.sessionName);
    if (!workspaceName) return null;
    routing = dependencies.createRoutingContext(daemon, workspaceName, options.sessionName);
    if (!routing) return null;
  }
  const expectedRouting: OpenTuiVerifiedRoutingIdentity = {
    daemonInstanceId: routing.daemonInstanceId,
    workspaceName: routing.workspaceName,
    sessionName: options.sessionName,
  };
  routing.assertCurrent(expectedRouting);
  const workspaceName = routing.workspaceName;

  const source = new SemanticTerminalRenderSource();
  const pending = new Map<string, Parameters<SemanticPaneReplica["accept"]>[0][]>();
  let runtimeGeneration: string | null = null;
  const outbound: Array<TerminalDeliveryAck | TerminalDeliveryNack> = [];
  let runtimeClient: PaneStreamRuntimeClient | null = null;
  const sendControl = (message: TerminalDeliveryAck | TerminalDeliveryNack): void => {
    if (!runtimeClient) {
      outbound.push(message);
      return;
    }
    if (message.type === "terminal.delivery.ack") runtimeClient.ack(message);
    else runtimeClient.nack(message);
  };
  const open = (viewerMode: "interactive" | "read-only", requestId: string) =>
    routing.openPaneStream(expectedRouting, {
      origin: OPENTUI_ORIGIN,
      hostClientId: OPENTUI_HOST_CLIENT_ID,
      requestId,
      stream: {
        protocolVersion: 1,
        workspaceName,
        panes: [...options.semanticPaneIds],
        viewerMode,
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: true,
        },
      },
      createSocket: createOpenTuiPaneStreamSocket,
      onNegotiated: (paneId, negotiation) => {
        if (!negotiation.accepted) {
          options.onFault?.(
            new Error(`Terminal delivery negotiation failed: ${negotiation.reason}`),
          );
          return;
        }
        runtimeGeneration ??= negotiation.negotiated.generation;
        const replica = new SemanticPaneReplica({
          negotiated: negotiation.negotiated,
          workspaceName,
          semanticPaneId: paneId,
          ack: sendControl,
          nack: sendControl,
          onChange: (change) => options.onPaneChange(paneId, change),
          onControlFailure: (error) => options.onFault?.(error),
        });
        source.set(replica);
        for (const message of pending.get(paneId) ?? []) replica.accept(message);
        pending.delete(paneId);
      },
      onTerminalDelivery: (paneId, message) => {
        const replica = source.replica(paneId);
        if (replica) replica.accept(message);
        else pending.set(paneId, [...(pending.get(paneId) ?? []), message]);
      },
      ...(options.onAuthoritySnapshot ? { onAuthoritySnapshot: options.onAuthoritySnapshot } : {}),
      ...(options.onLayout ? { onLayout: options.onLayout } : {}),
      ...(options.onFault
        ? {
            // An interactive redemption may fail because another renderer owns
            // the controller; that is the expected trigger for the read-only
            // retry, not a fault in the eventual passive lane.
            onFault: (error: Error) => {
              if (runtimeClient) options.onFault?.(error);
            },
          }
        : {}),
    });
  try {
    runtimeClient = await open("interactive", randomUUID());
  } catch (interactiveError) {
    try {
      runtimeClient = await open("read-only", randomUUID());
    } catch (viewerError) {
      options.onFault?.(
        new AggregateError(
          [interactiveError, viewerError],
          "OpenTUI could not acquire an interactive or read-only semantic runtime lane",
        ),
      );
      throw viewerError;
    }
  }
  for (const message of outbound.splice(0)) sendControl(message);

  const activeClient = runtimeClient;
  const viewerMode = activeClient.effectiveViewerMode;
  const requireInteractive = (): void => {
    if (viewerMode !== "interactive") {
      throw new Error("This OpenTUI connection is a passive viewer; another client owns input");
    }
  };
  const owns = (authority: SessionRuntimeAuthorityKind): boolean =>
    activeClient.authoritySnapshot?.owners[authority] === OPENTUI_HOST_CLIENT_ID;

  return {
    daemonInstanceId: activeClient.daemonInstanceId,
    workspaceName,
    generation: runtimeGeneration,
    connectionIdentity: `${activeClient.daemonInstanceId}:${activeClient.requestId}`,
    viewerMode,
    get ownsInput() {
      return viewerMode === "interactive" && owns("input");
    },
    get ownsGeometry() {
      return viewerMode === "interactive" && owns("geometry");
    },
    get authoritySnapshot() {
      return activeClient.authoritySnapshot;
    },
    source,
    sendText: (semanticPaneId, text, performanceTraceId) => {
      requireInteractive();
      activeClient.sendText(semanticPaneId, text, performanceTraceId);
    },
    sendKey: (semanticPaneId, key, performanceTraceId) => {
      requireInteractive();
      activeClient.sendKey(semanticPaneId, key, performanceTraceId);
    },
    fitViewport: (cols, rows) => {
      requireInteractive();
      return activeClient.fitViewport(cols, rows);
    },
    submit: (intent, operationId = randomUUID()) => {
      requireInteractive();
      return activeClient.submitIntent(operationId, intent);
    },
    setPresence: (state) => activeClient.setPresence(state),
    noteActivity: (activity) => activeClient.noteActivity(activity),
    requestAuthority: (authority) => activeClient.requestAuthority(authority),
    releaseAuthority: (authority) => activeClient.releaseAuthority(authority),
    close: () => activeClient.close(),
  };
}
