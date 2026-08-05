import type {
  PaneMirrorEvent,
  PaneStreamConnectResult,
  PaneStreamRequest,
  PaneStreamSessionListeners,
  PaneStreamTransport,
  PaneStreamTransportError,
} from "./pane-stream-transport.ts";
import type {
  MirrorTerminalRenderer,
  MirrorTerminalRendererFactory,
} from "./mirror-xterm-renderer.ts";

/**
 * Scripted pane-stream fixture (m43 card 3): a deterministic transport whose
 * frames the test author emits, plus a recording mirror renderer that proves
 * seed-batch atomicity — a reseed lands as exactly ONE `seed-commit` entry,
 * never as separate reset/write commits.
 */

export interface ScriptedPaneStreamSession {
  readonly request: PaneStreamRequest;
  readonly emit: (pane: string, event: PaneMirrorEvent) => void | Promise<void>;
  readonly end: (error: PaneStreamTransportError | null) => void;
  readonly dispose: () => void;
  disposed: boolean;
}

export interface ScriptedPaneStream {
  readonly transport: PaneStreamTransport;
  readonly sessions: ScriptedPaneStreamSession[];
  latest(): ScriptedPaneStreamSession;
}

export function createScriptedPaneStream(): ScriptedPaneStream {
  const sessions: ScriptedPaneStreamSession[] = [];
  const transport: PaneStreamTransport = {
    connect: (
      request: PaneStreamRequest,
      listeners: PaneStreamSessionListeners,
    ): Promise<PaneStreamConnectResult> => {
      const session: ScriptedPaneStreamSession = {
        request,
        emit: (pane, event) => listeners.onPaneEvent(pane, event),
        end: (error) => listeners.onEnd(error),
        dispose: () => {
          session.disposed = true;
        },
        disposed: false,
      };
      sessions.push(session);
      return Promise.resolve({ status: "connected", session: { dispose: session.dispose } });
    },
  };
  return {
    transport,
    sessions,
    latest: () => {
      const session = sessions.at(-1);
      if (!session) throw new Error("scripted pane stream has no session");
      return session;
    },
  };
}

export type MirrorRendererCommit =
  | {
      readonly kind: "seed-commit";
      readonly reset: { readonly cols: number; readonly rows: number } | null;
      readonly seed: string;
      readonly held: readonly string[];
      readonly cursor: { readonly x: number; readonly y: number } | null;
    }
  | { readonly kind: "write"; readonly text: string }
  | { readonly kind: "cursor"; readonly x: number; readonly y: number }
  | { readonly kind: "fit" };

export interface RecordingMirrorRenderer extends MirrorTerminalRenderer {
  readonly commits: MirrorRendererCommit[];
}

export function createRecordingMirrorRendererFactory(): {
  readonly factory: MirrorTerminalRendererFactory;
  readonly renderers: RecordingMirrorRenderer[];
} {
  const renderers: RecordingMirrorRenderer[] = [];
  const factory: MirrorTerminalRendererFactory = () => {
    const commits: MirrorRendererCommit[] = [];
    const decoder = new TextDecoder();
    const renderer: RecordingMirrorRenderer = {
      commits,
      open: () => undefined,
      applySeedBatch: async (batch) => {
        commits.push({
          kind: "seed-commit",
          reset: batch.reset,
          seed: decoder.decode(batch.seed),
          held: batch.held.map((held) => decoder.decode(held)),
          cursor: batch.cursor,
        });
      },
      write: async (bytes) => {
        commits.push({ kind: "write", text: decoder.decode(bytes) });
      },
      applyCursor: (x, y) => {
        commits.push({ kind: "cursor", x, y });
      },
      resizeGrid: () => undefined,
      refreshTheme: () => undefined,
      fitToContainer: () => {
        commits.push({ kind: "fit" });
      },
      setReducedMotion: () => undefined,
      dispose: () => undefined,
    };
    renderers.push(renderer);
    return renderer;
  };
  return { factory, renderers };
}
