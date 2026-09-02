import {
  PANE_STREAM_MAX_INPUT_TEXT_CHARS,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import type {
  NativeTerminalTransport,
  NativeTerminalTransportError,
} from "../terminal/native-terminal-transport.ts";
import type {
  PaneStreamResizeResult,
  PaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import {
  validateNativeTerminalRequest,
  validateNativeTerminalViewport,
} from "../terminal/native-terminal-transport.ts";
import { createHostPaneStreamTransport } from "./host-pane-stream-transport.ts";

interface PresenceSession {
  updatePresence?(state: "foreground" | "background"): void;
  noteActivity?(activity: "focus"): void;
}

type Card5AuthorityActivityKind = "focus" | "geometry" | "input";
type Card5AuthorityActivityOutcome =
  | "attempt"
  | "ok"
  | "geometry-authority-conflict"
  | "authority-timeout"
  | "viewport-timeout"
  | "stream-closed"
  | "lifecycle-retired"
  | "failed";
type Card5AuthorityActivityHost = typeof globalThis & {
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__?: () => Readonly<{
    count: number;
    overflow: boolean;
    events: readonly Readonly<{
      ordinal: number;
      surface: "web";
      kind: Card5AuthorityActivityKind;
      outcome: Card5AuthorityActivityOutcome;
      operationOrdinal: number | null;
      cols: number | null;
      rows: number | null;
    }>[];
  }>;
};
const authorityActivityEvents: Array<{
  ordinal: number;
  surface: "web";
  kind: Card5AuthorityActivityKind;
  outcome: Card5AuthorityActivityOutcome;
  operationOrdinal: number | null;
  cols: number | null;
  rows: number | null;
}> = [];
let authorityActivityCount = 0;
let geometryOperationCount = 0;

function recordCard5AuthorityActivity(
  kind: Card5AuthorityActivityKind,
  outcome: Card5AuthorityActivityOutcome = "ok",
  viewport: { readonly cols: number; readonly rows: number } | null = null,
  operationOrdinal: number | null = null,
): number | null {
  const host = globalThis as Card5AuthorityActivityHost;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return operationOrdinal;
  if (kind === "geometry" && outcome === "attempt") operationOrdinal = ++geometryOperationCount;
  authorityActivityCount += 1;
  authorityActivityEvents.push({
    ordinal: authorityActivityCount,
    surface: "web",
    kind,
    outcome,
    operationOrdinal,
    cols: viewport?.cols ?? null,
    rows: viewport?.rows ?? null,
  });
  if (authorityActivityEvents.length > 64) authorityActivityEvents.shift();
  host.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__ ??= () =>
    Object.freeze({
      count: Math.min(authorityActivityCount, 0xffff_ffff),
      overflow: authorityActivityCount > authorityActivityEvents.length,
      events: Object.freeze(authorityActivityEvents.map((event) => Object.freeze({ ...event }))),
    });
  return operationOrdinal;
}

interface PresenceGroup {
  readonly sessions: Set<PresenceSession>;
  leader: PresenceSession | null;
  foreground: boolean;
  focusPublished: boolean;
  focusOwner: string | null | undefined;
}

const presenceGroups = new Map<string, PresenceGroup>();
let presenceListenersInstalled = false;

function publishDocumentPresence(): void {
  const foreground = document.visibilityState === "visible" && document.hasFocus();
  for (const group of presenceGroups.values()) {
    // SessionRuntime transport bindings ref-count pane sockets under the host
    // client. One publisher per workspace principal avoids O(panes) duplicate
    // focus traffic while retaining authority if an individual pane reconnects.
    const leader = (group.sessions.values().next().value as PresenceSession | undefined) ?? null;
    const leaderChanged = leader !== group.leader;
    if (leaderChanged || foreground !== group.foreground) {
      leader?.updatePresence?.(foreground ? "foreground" : "background");
      group.leader = leader;
      group.foreground = foreground;
      group.focusPublished = false;
      group.focusOwner = undefined;
    }
    if (foreground && leader && !group.focusPublished) {
      group.focusPublished = true;
      if (leader.noteActivity) {
        leader.noteActivity("focus");
        recordCard5AuthorityActivity("focus");
      }
    }
  }
}

function observePresenceAuthority(
  key: string,
  session: PresenceSession,
  focusOwner: string | null,
): void {
  const group = presenceGroups.get(key);
  if (!group || group.leader !== session) return;
  const previous = group.focusOwner;
  group.focusOwner = focusOwner;
  // Authority observations are evidence, not trusted host-focus transitions.
  // A competing foreground host may legitimately become owner; automatically
  // publishing here would make two process-local publishers steal focus back
  // and forth forever. Only blur→focus or a new binding creates a new epoch.
  if (previous !== undefined && previous !== focusOwner) group.focusPublished = true;
}

function registerPresenceSession(key: string, session: PresenceSession): () => void {
  const group =
    presenceGroups.get(key) ??
    ({
      sessions: new Set<PresenceSession>(),
      leader: null,
      foreground: false,
      focusPublished: false,
      focusOwner: undefined,
    } satisfies PresenceGroup);
  group.sessions.add(session);
  presenceGroups.set(key, group);
  if (!presenceListenersInstalled) {
    presenceListenersInstalled = true;
    document.addEventListener("visibilitychange", publishDocumentPresence);
    globalThis.addEventListener("focus", publishDocumentPresence);
    globalThis.addEventListener("blur", publishDocumentPresence);
  }
  queueMicrotask(publishDocumentPresence);
  return () => {
    group.sessions.delete(session);
    if (group.sessions.size === 0) presenceGroups.delete(key);
    else if (group.leader === session) {
      group.leader = null;
      group.focusPublished = false;
      group.focusOwner = undefined;
      queueMicrotask(publishDocumentPresence);
    }
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

const geometryAuthorityConflict = (): NativeTerminalTransportError => ({
  code: "geometry-authority-conflict",
  reason: "Another client controls terminal geometry.",
  retryable: true,
});

const fatalResizeError = (
  code:
    | "geometry-authority-timeout"
    | "geometry-viewport-timeout"
    | "pane-stream-closed"
    | "geometry-lifecycle-retired"
    | "geometry-resize-failed",
  reason: string,
): NativeTerminalTransportError => ({ code, reason, retryable: false });

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

/** Interactive terminal adapter over one already-owned SessionRuntime pane stream. */
export function createPaneStreamNativeTerminalTransport(
  transport: PaneStreamTransport,
  presenceKey: string,
): NativeTerminalTransport {
  return {
    connect: async (rawRequest, listener) => {
      const request = validateNativeTerminalRequest(rawRequest);
      let sourceGrid = request.viewport;
      let clientViewport = request.viewport;
      let coherent = false;
      const presenceGroupKey = `${presenceKey}\0${request.target.workspaceName}`;
      let presenceSession: PresenceSession | null = null;
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
                  clientViewport,
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
            void listener({ type: "geometry", sourceGrid, clientViewport });
          },
          onLayoutSnapshot: (snapshot) => {
            const pane = snapshot.layouts
              .flatMap((layout) => layout.panes)
              .find(({ pane }) => pane === request.target.semanticPaneId);
            if (!pane) return;
            sourceGrid = { cols: pane.width, rows: pane.height };
            void listener({ type: "geometry", sourceGrid, clientViewport });
          },
          onEnd: (error) => {
            void listener({
              type: "state",
              state: "disconnected",
              error: error ? unavailable(error.reason) : null,
            });
          },
          onAuthoritySnapshot: (snapshot) => {
            if (presenceSession) {
              observePresenceAuthority(presenceGroupKey, presenceSession, snapshot.owners.focus);
            }
          },
        },
      );
      if (result.status === "error")
        return { status: "error", error: unavailable(result.error.reason) };
      const session = result.session;
      presenceSession = session;
      const inputDecoder = createPaneStreamInputDecoder();
      const unregisterPresence = registerPresenceSession(presenceGroupKey, session);
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
                recordCard5AuthorityActivity("input");
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
            let result: PaneStreamResizeResult | undefined;
            if (session.resize) {
              const operationOrdinal = recordCard5AuthorityActivity(
                "geometry",
                "attempt",
                viewport,
              );
              result = await session.resize(viewport.cols, viewport.rows);
              recordCard5AuthorityActivity(
                "geometry",
                result ?? "failed",
                viewport,
                operationOrdinal,
              );
            }
            if (result === "ok") {
              clientViewport = viewport;
              return { status: "ok" };
            }
            if (result === "geometry-authority-conflict") {
              return { status: "error", error: geometryAuthorityConflict() };
            }
            if (result === "authority-timeout") {
              return {
                status: "error",
                error: fatalResizeError(
                  "geometry-authority-timeout",
                  "Geometry authority did not settle before its deadline.",
                ),
              };
            }
            if (result === "viewport-timeout") {
              return {
                status: "error",
                error: fatalResizeError(
                  "geometry-viewport-timeout",
                  "Terminal geometry did not settle before its deadline.",
                ),
              };
            }
            if (result === "stream-closed") {
              return {
                status: "error",
                error: fatalResizeError(
                  "pane-stream-closed",
                  "The terminal stream closed before geometry settled.",
                ),
              };
            }
            if (result === "lifecycle-retired") {
              return {
                status: "error",
                error: fatalResizeError(
                  "geometry-lifecycle-retired",
                  "The terminal runtime retired before geometry settled.",
                ),
              };
            }
            return {
              status: "error",
              error: fatalResizeError(
                "geometry-resize-failed",
                "Terminal geometry was not accepted.",
              ),
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

/** Host-issued compatibility composition; Web WorkspaceClient passes its shared bridge instead. */
export function createHostPaneStreamNativeTerminalTransport(
  host: Pick<HostCapabilities, "daemon">,
  daemon: DaemonInstanceIdentity,
): NativeTerminalTransport {
  return createPaneStreamNativeTerminalTransport(
    createHostPaneStreamTransport(host, daemon),
    `${daemon.instanceId}`,
  );
}
