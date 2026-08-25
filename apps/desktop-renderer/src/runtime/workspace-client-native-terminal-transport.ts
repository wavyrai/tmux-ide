import type { CanonicalTerminalReplicaUpdate, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import {
  encodeAnsiTerminalPatchRepresentation,
  encodeAnsiTerminalRepresentation,
} from "@tmux-ide/core";

import type {
  NativeTerminalCanonicalProjection,
  NativeTerminalTransport,
  NativeTerminalTransportError,
} from "../terminal/native-terminal-transport.ts";
import type { PaneStreamTransport } from "../terminal/pane-stream-transport.ts";
import {
  validateNativeTerminalRequest,
  validateNativeTerminalViewport,
} from "../terminal/native-terminal-transport.ts";
import {
  createPaneStreamInputDecoder,
  createPaneStreamNativeTerminalTransport,
} from "./host-pane-stream-native-terminal-transport.ts";
import type { WebWorkspaceClient } from "./web-workspace-client.ts";
import {
  WebWorkspaceViewportError,
  type WebWorkspaceViewportFailureCode,
} from "./web-workspace-runtime.ts";

const unavailable = (reason: string): NativeTerminalTransportError => ({
  code: "workspace-client-unavailable",
  reason,
  retryable: true,
});

const geometryAuthorityConflict = (): NativeTerminalTransportError => ({
  code: "geometry-authority-conflict",
  reason: "Another client controls terminal geometry.",
  retryable: true,
});

const workspaceViewportFailure = (
  code: WebWorkspaceViewportFailureCode,
): NativeTerminalTransportError => ({
  code,
  reason:
    code === "geometry-authority-timeout"
      ? "Geometry authority did not settle before its deadline."
      : code === "geometry-viewport-timeout"
        ? "Terminal geometry did not settle before its deadline."
        : code === "pane-stream-closed"
          ? "The terminal stream closed before geometry settled."
          : code === "geometry-lifecycle-retired"
            ? "The terminal runtime retired before geometry settled."
            : "Terminal geometry was not accepted.",
  retryable: false,
});

const workspaceAuthorityLost = (): NativeTerminalTransportError => ({
  code: "geometry-authority-lost",
  reason: "Geometry authority was lost.",
  retryable: false,
});

/**
 * xterm byte adapter over WorkspaceClient's canonical replica scope. A slow DOM
 * renderer retains only the latest authoritative snapshot and never delays the
 * shared physical pane stream or another client.
 */
export function createWorkspaceClientNativeTerminalTransport(
  client: WebWorkspaceClient,
  paneStream?: PaneStreamTransport,
): NativeTerminalTransport {
  if (paneStream) {
    const daemonInstanceId = client.getSnapshot().target?.daemon.instanceId;
    if (!daemonInstanceId) throw new Error("The WorkspaceClient stream has no daemon authority.");
    return createPaneStreamNativeTerminalTransport(paneStream, daemonInstanceId);
  }
  return {
    async connect(rawRequest, listener) {
      const request = validateNativeTerminalRequest(rawRequest);
      let currentIdentity: { generation: string; incarnation: string; revision: number } | null =
        null;
      let delivered: TerminalReplicaSnapshot | null = null;
      let pending: {
        update: CanonicalTerminalReplicaUpdate;
        snapshot: TerminalReplicaSnapshot | null;
      } | null = null;
      let sourceEpoch = 0;
      let draining = false;
      let connected = false;
      let disposed = false;
      const inputDecoder = createPaneStreamInputDecoder();

      const projection = (
        update: CanonicalTerminalReplicaUpdate,
        snapshot: TerminalReplicaSnapshot,
      ): NativeTerminalCanonicalProjection => ({
        generation: update.generation,
        incarnation: update.incarnation,
        revision: update.revision,
        stateHash: update.stateHash,
        cols: snapshot.cols,
        rows: snapshot.rows,
        sourceEpoch,
        alternateScreen: snapshot.modes.alternateScreen,
        cursor: snapshot.cursor,
        gridRowsRead: snapshot.grid.length,
        gridCellsRead: snapshot.grid.reduce((total, row) => total + row.cells.length, 0),
        fullGridWalks: 1,
      });

      const drain = async (): Promise<void> => {
        if (draining || disposed) return;
        draining = true;
        try {
          while (!disposed && pending) {
            const next = pending;
            pending = null;
            if (!next.snapshot) {
              connected = false;
              delivered = null;
              await listener({ type: "state", state: "disconnected", error: null });
              continue;
            }
            if (!connected) {
              connected = true;
              await listener({
                type: "state",
                state: "connected",
                error: null,
                sourceGrid: { cols: next.snapshot.cols, rows: next.snapshot.rows },
                clientViewport: request.viewport,
              });
            }
            const bytes =
              next.update.type === "terminal.patch" && delivered
                ? encodeAnsiTerminalPatchRepresentation(next.update.patch, next.snapshot, delivered)
                : encodeAnsiTerminalRepresentation(delivered, next.snapshot);
            delivered = next.snapshot;
            await listener({
              type: "output",
              bytes,
              canonical: projection(next.update, next.snapshot),
            });
          }
        } finally {
          draining = false;
          if (!disposed && pending) void drain();
        }
      };

      const stop = client.subscribeTerminal(request.target, (update, metadata) => {
        if (disposed) return;
        if (update.type === "terminal.seed" && currentIdentity?.generation !== update.generation) {
          delivered = null;
          connected = false;
        }
        const snapshot = metadata?.canonicalSnapshot;
        if (update.type !== "terminal.tombstone" && !snapshot) {
          client.requestTerminalRepair(
            request.target,
            currentIdentity?.generation ?? update.generation,
            "conflict",
          );
          return;
        }
        if (update.type === "terminal.seed") sourceEpoch += 1;
        currentIdentity =
          update.type === "terminal.tombstone"
            ? null
            : {
                generation: update.generation,
                incarnation: update.incarnation,
                revision: update.revision,
              };
        pending = { update, snapshot: snapshot ?? null };
        void drain();
      });

      return {
        status: "connected",
        attachment: {
          async write(bytes) {
            try {
              for (const text of inputDecoder.push(bytes)) {
                if (
                  (await client.sendTerminalInput(request.target, { kind: "text", data: text })) !==
                  "ok"
                ) {
                  return { status: "error", error: unavailable("Input authority was lost.") };
                }
              }
              return { status: "ok" };
            } catch {
              return {
                status: "error",
                error: unavailable("Terminal input was not valid UTF-8 text."),
              };
            }
          },
          async resize(rawViewport) {
            const viewport = validateNativeTerminalViewport(rawViewport);
            if (request.geometryOwnership === "passive") return { status: "ok" };
            try {
              const result = await client.fitViewport(viewport.cols, viewport.rows);
              if (result === "ok") return { status: "ok" };
              return {
                status: "error",
                error:
                  result === "geometry-authority-conflict"
                    ? geometryAuthorityConflict()
                    : workspaceAuthorityLost(),
              };
            } catch (error) {
              return {
                status: "error",
                error:
                  error instanceof WebWorkspaceViewportError
                    ? workspaceViewportFailure(error.code)
                    : workspaceAuthorityLost(),
              };
            }
          },
          dispose() {
            if (disposed) return;
            disposed = true;
            stop();
          },
        },
      };
    },
  };
}
