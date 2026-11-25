import type { NativeGridCapture, NativeHistoryPiece } from "../mirror/native-grid-capture.ts";
import type { MirrorObservedTerminalModes } from "../mirror/events.ts";
import type {
  TerminalReplicaCursor,
  TerminalReplicaModes,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";

/**
 * The VT parser boundary owned by SessionRuntime.
 *
 * Backends translate one ordered byte/geometry stream into renderer-neutral
 * terminal state. They never own revisions, generation fencing, delivery, or
 * UI state; those remain in {@link TerminalReplicaInterpreter}. This keeps a
 * native parser replaceable without creating a second terminal authority.
 */
export interface TerminalInterpreterBackend {
  readonly kind: string;
  readonly cols: number;
  readonly rows: number;

  /** Admit exactly the next idle-buffer write without xterm's timer deferral. */
  prioritizeNextWrite(): void;
  /** Public-parser diagnostic OSC seam; installed only for an active probe. */
  registerOscHandler(identifier: number, handler: (data: string) => boolean): () => void;
  write(data: Uint8Array | string): Promise<void>;
  /** SPIKE (kitty graphics): cursor as an absolute buffer line, read mid-parse. */
  graphicsCursor?(): { readonly x: number; readonly line: number; readonly alternate: boolean };
  /** SPIKE (kitty graphics): absolute buffer line of viewport row 0. */
  graphicsViewportTop?(): number;
  /** Exact native painted state; false means this parser cannot import it. */
  canImportNativeGrid?(): boolean;
  importNativeGrid?(snapshot: NativeGridCapture): boolean;
  /**
   * #873: tmux history rows older than the oldest row held, left out by the
   * last native import and not yet prepended or collected. tmux's history
   * size is this plus the history rows held. Zero after any other start.
   */
  omittedHistory?(): number;
  /** #873: the most history rows this parser holds (DAEMON_HISTORY_ROW_CAP unless set). */
  historyRowCap?(): number;
  /**
   * #873: prepend the piece's rows that are older than the oldest row held.
   * Applies only on the normal screen, at the piece's width, when the piece
   * was read at this history size and reaches the oldest row held; otherwise
   * changes nothing and returns false.
   */
  prependNativeHistory?(piece: NativeHistoryPiece): boolean;
  resize(cols: number, rows: number): void;
  /** x === cols preserves native wrap-pending state; project() returns a cell position. */
  setAuthoritativeCursor(x: number, y: number): void;
  /** Restore observed DECAWM after capture replay without changing other parser modes. */
  setAuthoritativeWraparound(enabled: boolean): void;
  /** Restore only supplied scalar observations after replaying capture bytes. */
  setAuthoritativeModes(modes: MirrorObservedTerminalModes): void;
  /** A pre-existing saved buffer became active without authoritative backing. */
  requiresNativeReseed(): boolean;
  /**
   * From now on, collect history at the limit the way tmux does. Off while a
   * capture is replayed: tmux's captured history (which can exceed a lowered
   * limit) is replayed as it is.
   */
  startHistoryCollection?(): void;
  modes(): TerminalReplicaModes;
  dirtyRange(): { readonly start: number; readonly end: number } | undefined;
  project(
    previous: TerminalReplicaSnapshot,
    dirty?: { readonly start: number; readonly end: number },
  ): TerminalInterpreterBackendProjection;
  dispose(): void;
}

export interface TerminalInterpreterBackendProjection {
  readonly cols: number;
  readonly rows: number;
  readonly grid: readonly TerminalReplicaRow[];
  readonly history: readonly TerminalReplicaRow[];
  readonly cursor: TerminalReplicaCursor;
  readonly modes: TerminalReplicaModes;
  readonly historyDelta: {
    readonly trim: number;
    readonly append: TerminalReplicaRow[];
  } | null;
  readonly stats: {
    readonly fullWalks: number;
    readonly gridRowsRead: number;
    readonly historyRowsRead: number;
    readonly cellsRead: number;
  };
}

export interface TerminalInterpreterBackendFactoryOptions {
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  /** Native collection policy; retained capacity can be larger after tmux reflow. */
  readonly historyLimit?: number;
  /**
   * #873: the most history rows the daemon holds for a pane, whatever tmux's
   * history-limit. Older rows stay in tmux and count as left out.
   */
  readonly historyRowCap?: number;
}

/** #873, owner decision of 25 Nov 2026: the daemon holds at most this many history rows per pane. */
export const DAEMON_HISTORY_ROW_CAP = 10_000;

export type TerminalInterpreterBackendFactory = (
  options: TerminalInterpreterBackendFactoryOptions,
) => TerminalInterpreterBackend;
