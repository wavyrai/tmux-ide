import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  PaneStreamServerFrame,
  SessionRuntimeSemanticIntent,
  TerminalDeliveryAck,
  TerminalDeliveryNack,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import {
  openPaneStreamRuntimeClient,
  type PaneStreamClientSocket,
} from "@tmux-ide/daemon-client/pane-stream-client";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import {
  fetchCanonicalWorkspaceCatalog,
  workspaceNameForSession,
} from "./canonical-workspace-routing.ts";
import {
  SemanticPaneReplica,
  SemanticTerminalRenderSource,
  type SemanticPaneReplicaChange,
} from "./semantic-pane-render-source.ts";

const OPENTUI_ORIGIN = "tmux-ide://opentui";
const OPENTUI_HOST_CLIENT_ID = `opentui:${process.pid}`;

export interface OpenTuiSessionRuntimeLane {
  readonly daemonInstanceId: string;
  readonly workspaceName: string;
  readonly generation: string | null;
  readonly connectionIdentity: string;
  readonly viewerMode: "interactive" | "read-only";
  readonly ownsInput: boolean;
  readonly ownsGeometry: boolean;
  readonly source: SemanticTerminalRenderSource;
  sendText(semanticPaneId: string, text: string, performanceTraceId?: string): void;
  sendKey(semanticPaneId: string, key: string, performanceTraceId?: string): void;
  fitViewport(cols: number, rows: number): Promise<void>;
  submit(
    intent: SessionRuntimeSemanticIntent,
    operationId?: string,
  ): Promise<WorkspaceMultiplexerMutationResult | null>;
  close(): void;
}

export interface ConnectOpenTuiSessionRuntimeOptions {
  readonly sessionName: string;
  readonly semanticPaneIds: readonly string[];
  readonly onPaneChange: (paneId: string, change: SemanticPaneReplicaChange) => void;
  readonly onLayout?: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
  readonly onFault?: (error: Error) => void;
}

/**
 * Open the one owner-brokered, generation-bound runtime lane for an OpenTUI
 * process/session. One WebSocket carries layout, N semantic terminal replicas,
 * controller input, resize/focus intents and their observed settlements.
 */
export async function connectOpenTuiSessionRuntime(
  options: ConnectOpenTuiSessionRuntimeOptions,
): Promise<OpenTuiSessionRuntimeLane | null> {
  if (options.semanticPaneIds.length === 0) return null;
  const daemon = readCanonicalDaemonInfo();
  if (!daemon?.authToken || !(await isCanonicalDaemonAlive(daemon))) return null;
  const ownerToken = daemon.authToken;
  const catalog = await fetchCanonicalWorkspaceCatalog(daemon);
  const workspaceName = workspaceNameForSession(catalog, options.sessionName);
  if (!workspaceName) return null;

  const source = new SemanticTerminalRenderSource();
  const pending = new Map<string, Parameters<SemanticPaneReplica["accept"]>[0][]>();
  let runtimeGeneration: string | null = null;
  const outbound: Array<TerminalDeliveryAck | TerminalDeliveryNack> = [];
  let runtimeClient: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>> | null = null;
  const sendControl = (message: TerminalDeliveryAck | TerminalDeliveryNack): void => {
    if (!runtimeClient) {
      outbound.push(message);
      return;
    }
    if (message.type === "terminal.delivery.ack") runtimeClient.ack(message);
    else runtimeClient.nack(message);
  };
  const open = (viewerMode: "interactive" | "read-only", requestId: string) =>
    openPaneStreamRuntimeClient({
      baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
      ownerToken,
      daemonInstanceId: daemon.instanceId,
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
      createSocket: (descriptor, headers) =>
        new WebSocket(descriptor.webSocketUrl, descriptor.subprotocol, {
          origin: headers.Origin,
          headers: { "X-Tmux-Ide-Host-Client-Id": headers["X-Tmux-Ide-Host-Client-Id"]! },
          perMessageDeflate: false,
        }) as unknown as PaneStreamClientSocket,
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

  return {
    daemonInstanceId: activeClient.daemonInstanceId,
    workspaceName,
    generation: runtimeGeneration,
    connectionIdentity: `${activeClient.daemonInstanceId}:${activeClient.requestId}`,
    viewerMode,
    ownsInput: viewerMode === "interactive",
    ownsGeometry: viewerMode === "interactive",
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
    close: () => activeClient.close(),
  };
}
