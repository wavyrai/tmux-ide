import {
  PANE_STREAM_MAX_INPUT_TEXT_CHARS,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import type {
  NativeTerminalTransport,
  NativeTerminalTransportError,
} from "../terminal/native-terminal-transport.ts";
import {
  validateNativeTerminalRequest,
  validateNativeTerminalViewport,
} from "../terminal/native-terminal-transport.ts";
import { createHostPaneStreamTransport } from "./host-pane-stream-transport.ts";

interface PresenceSession {
  updatePresence?(state: "foreground" | "background"): void;
  noteActivity?(activity: "focus"): void;
}

const presenceGroups = new Map<string, Set<PresenceSession>>();
let presenceListenersInstalled = false;

function publishDocumentPresence(): void {
  const foreground = document.visibilityState === "visible" && document.hasFocus();
  for (const sessions of presenceGroups.values()) {
    // SessionRuntime transport bindings ref-count pane sockets under the host
    // client. One publisher per workspace principal avoids O(panes) duplicate
    // focus traffic while retaining authority if an individual pane reconnects.
    const leader = sessions.values().next().value as PresenceSession | undefined;
    leader?.updatePresence?.(foreground ? "foreground" : "background");
    if (foreground) leader?.noteActivity?.("focus");
  }
}

function registerPresenceSession(key: string, session: PresenceSession): () => void {
  const group = presenceGroups.get(key) ?? new Set<PresenceSession>();
  group.add(session);
  presenceGroups.set(key, group);
  if (!presenceListenersInstalled) {
    presenceListenersInstalled = true;
    document.addEventListener("visibilitychange", publishDocumentPresence);
    globalThis.addEventListener("focus", publishDocumentPresence);
    globalThis.addEventListener("blur", publishDocumentPresence);
  }
  queueMicrotask(publishDocumentPresence);
  return () => {
    group.delete(session);
    if (group.size === 0) presenceGroups.delete(key);
    else queueMicrotask(publishDocumentPresence);
    if (presenceGroups.size === 0 && presenceListenersInstalled) {
      presenceListenersInstalled = false;
      document.removeEventListener("visibilitychange", publishDocumentPresence);
      globalThis.removeEventListener("focus", publishDocumentPresence);
      globalThis.removeEventListener("blur", publishDocumentPresence);
    }
  };
}

const unavailable = (reason: string): NativeTerminalTransportError => ({
  code: "pane-stream-unavailable",
  reason,
  retryable: true,
});

/**
 * TerminalSurface exposes bytes while pane-stream input is intentionally a
 * bounded UTF-8 text contract. Keep one streaming decoder per attachment so a
 * code point split across browser write callbacks is reconstructed exactly,
 * then bound each wire frame without splitting surrogate pairs.
 */
export function createPaneStreamInputDecoder(): {
  push(bytes: Uint8Array): readonly string[];
} {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    push(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      if (text.length === 0) return [];
      if (text.includes("\0")) throw new TypeError("Terminal input contains a NUL byte.");
      const chunks: string[] = [];
      for (let offset = 0; offset < text.length; ) {
        let end = Math.min(text.length, offset + PANE_STREAM_MAX_INPUT_TEXT_CHARS);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end -= 1;
        chunks.push(text.slice(offset, end));
        offset = end;
      }
      return chunks;
    },
  };
}

/** Interactive Web terminal adapter over the canonical SessionRuntime pane stream. */
export function createHostPaneStreamNativeTerminalTransport(
  host: Pick<HostCapabilities, "daemon">,
  daemon: DaemonInstanceIdentity,
): NativeTerminalTransport {
  const transport = createHostPaneStreamTransport(host, daemon);
  return {
    connect: async (rawRequest, listener) => {
      const request = validateNativeTerminalRequest(rawRequest);
      let sourceGrid = request.viewport;
      let coherent = false;
      const result = await transport.connect(
        {
          workspaceName: request.target.workspaceName,
          panes: [request.target.semanticPaneId],
          viewerMode: request.viewerMode,
        },
        {
          onPaneEvent: async (_pane, event) => {
            if (event.type === "seed-batch") {
              if (event.batch.reset) sourceGrid = event.batch.reset;
              if (!coherent) {
                coherent = true;
                await listener({
                  type: "state",
                  state: "connected",
                  error: null,
                  sourceGrid,
                  clientViewport: request.viewport,
                });
              }
              await listener({
                type: "output",
                bytes: event.batch.seed,
                ...(event.canonical ? { canonical: event.canonical } : {}),
              });
              for (const held of event.batch.held) await listener({ type: "output", bytes: held });
            } else if (event.type === "output") {
              await listener({
                type: "output",
                bytes: event.bytes,
                ...(event.canonical ? { canonical: event.canonical } : {}),
              });
            } else if (event.type === "closed") {
              await listener({ type: "state", state: "disconnected", error: null });
            }
          },
          onLayout: (layout) => {
            const pane = layout.panes.find(({ pane }) => pane === request.target.semanticPaneId);
            if (!pane) return;
            sourceGrid = { cols: pane.width, rows: pane.height };
            void listener({ type: "geometry", sourceGrid, clientViewport: request.viewport });
          },
          onEnd: (error) => {
            void listener({
              type: "state",
              state: "disconnected",
              error: error ? unavailable(error.reason) : null,
            });
          },
        },
      );
      if (result.status === "error")
        return { status: "error", error: unavailable(result.error.reason) };
      const session = result.session;
      const inputDecoder = createPaneStreamInputDecoder();
      const unregisterPresence = registerPresenceSession(
        `${daemon.instanceId}\0${request.target.workspaceName}`,
        session,
      );
      let disposed = false;
      return {
        status: "connected",
        attachment: {
          write: async (bytes) => {
            try {
              for (const text of inputDecoder.push(bytes)) {
                if (!(await session.write?.(request.target.semanticPaneId, text))) {
                  return {
                    status: "error",
                    error: unavailable("Input authority is held by another client."),
                  };
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
          resize: async (rawViewport) => {
            const viewport = validateNativeTerminalViewport(rawViewport);
            return (await session.resize?.(viewport.cols, viewport.rows))
              ? { status: "ok" }
              : {
                  status: "error",
                  error: unavailable("Geometry authority is held by another client."),
                };
          },
          dispose: () => {
            if (disposed) return;
            disposed = true;
            unregisterPresence();
            session.dispose();
          },
        },
      };
    },
  };
}
