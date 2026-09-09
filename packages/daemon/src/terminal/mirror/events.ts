import type { NativeGridCapture } from "./native-grid-capture.ts";
/**
 * Public event contract of the daemon MirrorService (m43 card 1).
 *
 * Everything a consumer receives speaks SEMANTIC identity only — runtime tmux
 * addresses (`%N`, `@N`, `$N`) never cross this boundary. Pane content arrives
 * as a typed event stream a renderer can apply verbatim to a VT emulator:
 *
 *   reset → seed → [held deltas] → cursor → live deltas…
 *
 * The seed batch is emitted ATOMICALLY (one synchronous callback sequence) so
 * a consumer can apply it as a single paint: `reset` replaces emulator state
 * (tmux is a painter, not a stream — never composite two captures), `seed`
 * carries one capture from one instant, any deltas the server emitted between
 * the capture and cursor probes replay next (they are strictly-after-capture
 * bytes the capture cannot contain), and `cursor` lands the emulator cursor on
 * tmux's truth. Everything after is a live delta.
 */

/** Modes observed at the native capture seam; omitted fields stay unknown. */
export interface MirrorObservedTerminalModes {
  /** Authoritative tmux pane option; absent when the capture cannot resolve it. */
  readonly scrollOnClear?: boolean;
  readonly alternateScreen?: boolean;
  readonly applicationCursor?: boolean;
  readonly applicationKeypad?: boolean;
  readonly insert?: boolean;
  readonly cursorVisible?: boolean;
  readonly bracketedPaste?: boolean;
  readonly mouseProtocol?: "none" | "vt200" | "drag" | "any";
  readonly mouseSgr?: boolean;
  readonly mouseUtf8?: boolean;
  /** Zero-based inclusive margins, coupled with DECOM to keep cursor addressing coherent. */
  readonly scrolling?: { readonly top: number; readonly bottom: number; readonly origin: boolean };
}

/** One pane-scoped stream event. `seed`/`delta` bytes are raw VT output. */
export type MirrorPaneEvent =
  | {
      /** Discard emulator state and resize to `cols`x`rows` before the seed. */
      type: "reset";
      cols: number;
      rows: number;
    }
  | {
      /** Screen + history bytes captured at ONE instant (`capture-pane -e -J`). */
      type: "seed";
      /** Only requested by the canonical parser owner. */
      native?: NativeGridCapture;
      /** Mixed-format recovery: canonical owner waits for its own fresh seed. */
      requiresNativeRecapture?: boolean;
      data: Uint8Array;
    }
  | {
      /** Native cursor truth; x may equal cols to represent wrap pending. */
      type: "cursor";
      /** Native pane retention limit, when supplied by the capture probe. */
      historyLimit?: number;
      /** Actual retained rows; resize reflow may exceed the configured limit. */
      historySize?: number;
      /** Observed DECAWM state at the cursor probe seam, when supplied. */
      wraparound?: boolean;
      observedModes?: MirrorObservedTerminalModes;
      x: number;
      y: number;
    }
  | {
      /** Live output bytes, strictly after the seed instant. */
      type: "delta";
      data: Uint8Array;
    }
  | {
      /** Delivery state changed. `backpressure` mirrors tmux `%pause`;
       *  `requested` is a subscriber's own freeze. A `resumed` flow event is
       *  always followed by a fresh atomic seed batch. */
      type: "flow";
      state: "paused" | "resumed";
      reason: "backpressure" | "requested";
    }
  | {
      /** Native recovery exhausted its bounds; this is not evidence of pane deletion. */
      type: "fault";
      reason: "native-recovery-failed";
    }
  | {
      /** The pane is gone from tmux truth (a successful list-panes reply that
       *  omits it — probe FAILURE never reads as absence). Terminal event. */
      type: "closed";
    };

/** One visible pane rectangle inside a layout event, in window cells. */
export interface MirrorLayoutPane {
  /** Null while the pane's semantic identity join is still unverified. */
  semanticPaneId: string | null;
  /** Daemon-authored presentation; clients never infer this from terminal bytes. */
  displayName: string | null;
  displayNameSource: "manual" | "agent" | "process" | "title" | "generated" | null;
  left: number;
  top: number;
  width: number;
  height: number;
  active: boolean;
}

/**
 * A window layout push (`%layout-change` / `%window-pane-changed`), joined to
 * semantic identity daemon-side and emitted in channel order — always ahead
 * of any output the server produced after the layout was applied.
 */
export interface MirrorLayoutEvent {
  type: "layout";
  session: string;
  /** Durable `@tmux_ide_window_id` stamp; null while the window join is
   *  unverified (stamp-back pending or failed). */
  semanticWindowId: string | null;
  windowName: string | null;
  /** The window is its session's current window. */
  currentWindow: boolean;
  cols: number;
  rows: number;
  zoomed: boolean;
  /** Where tmux reserves its pane-border title row for this window. */
  paneBorderStatus: "top" | "bottom" | "off";
  /** Effective native window copy key mode; absent from older observations. */
  modeKeys?: "emacs" | "vi";
  panes: MirrorLayoutPane[];
}

/** Full, incarnation-bound layout authority; replacement semantics remove absent windows. */
export interface MirrorLayoutAuthoritySnapshot {
  readonly session: string;
  readonly runtimeSessionId: string;
  readonly topologyEpoch: number;
  readonly layouts: readonly MirrorLayoutEvent[];
}

/** A pane row of {@link MirrorSessionDescription} — semantic identity only. */
export interface MirrorPaneDescription {
  semanticPaneId: string;
  semanticWindowId: string | null;
  role: string | null;
  paneType: string | null;
  currentCommand: string | null;
  cwd: string | null;
  title: string | null;
  displayName: string;
  displayNameSource: "manual" | "agent" | "process" | "title" | "generated";
  windowName: string | null;
  active: boolean;
}

/** Identity-join diagnostic, stripped of runtime addresses at the boundary. */
export interface MirrorDiagnostic {
  code: string;
  message: string;
  degraded: boolean;
}

export interface MirrorSessionDescription {
  session: string;
  panes: MirrorPaneDescription[];
  diagnostics: MirrorDiagnostic[];
  degraded: boolean;
}
