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
  resize(cols: number, rows: number): void;
  /** x === cols preserves native wrap-pending state; project() returns a cell position. */
  setAuthoritativeCursor(x: number, y: number): void;
  /** Restore observed DECAWM after capture replay without changing other parser modes. */
  setAuthoritativeWraparound(enabled: boolean): void;
  /** Restore only supplied scalar observations after replaying capture bytes. */
  setAuthoritativeModes(modes: MirrorObservedTerminalModes): void;
  /** A pre-existing saved buffer became active without authoritative backing. */
  requiresNativeReseed(): boolean;
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
}

export type TerminalInterpreterBackendFactory = (
  options: TerminalInterpreterBackendFactoryOptions,
) => TerminalInterpreterBackend;
