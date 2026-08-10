import {
  layoutBorders,
  layoutTiles,
  type LayoutBorder,
  type LayoutFrame,
  type TileRect,
} from "./workspace-layout-tiles.ts";

/** Live resize traffic is allowed at most once in this interval. */
export const PANE_RESIZE_WIRE_INTERVAL_MS = 80;

/** A pane title remains a click until the pointer has travelled this far. */
export const PANE_DRAG_THRESHOLD_PX = 5;

export interface WorkspacePointerSample {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /** Monotonic time supplied by the event adapter (`performance.now()`). */
  readonly atMs: number;
  /** A false primary flag identifies a second touch/stylus contact. */
  readonly isPrimary?: boolean;
}

export interface WorkspaceGridBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneManipulationPresentation {
  readonly reducedMotion: boolean;
  /** Pointer samples are never delayed by presentation. */
  readonly inputDelayMs: 0;
  /** Gesture feedback is compositor-only. */
  readonly liveProperties: readonly ["transform", "opacity"];
  /** Live pointer response is direct, not eased behind the cursor. */
  readonly liveTransitionMs: 0;
  /** Only post-gesture reconciliation may settle with a transition. */
  readonly settleTransition: {
    readonly properties: readonly ["transform", "opacity"];
    readonly durationMs: 0 | 150;
    readonly easing: "var(--ease-smooth)";
  };
}

export interface WorkspaceLayoutSnapshot {
  readonly frame: LayoutFrame;
  readonly tiles: ReturnType<typeof layoutTiles>;
  readonly borders: ReturnType<typeof layoutBorders>;
}

interface ManipulationBase {
  readonly snapshot: WorkspaceLayoutSnapshot;
  readonly presentation: PaneManipulationPresentation;
}

export interface WorkspacePaneIdle extends ManipulationBase {
  readonly kind: "idle";
}

export interface WorkspacePaneResize extends ManipulationBase {
  readonly kind: "resize";
  readonly pointerId: number;
  readonly origin: WorkspacePointerSample;
  readonly current: WorkspacePointerSample;
  readonly border: LayoutBorder;
  readonly gridBox: WorkspaceGridBox;
  readonly previewCells: number;
  readonly lastWireAtMs: number | null;
  readonly lastWiredCells: number | null;
  readonly pendingWire: {
    readonly cells: number;
    readonly dueAtMs: number;
  } | null;
}

export interface WorkspacePaneDrag extends ManipulationBase {
  readonly kind: "drag";
  readonly pointerId: number;
  readonly origin: WorkspacePointerSample;
  readonly current: WorkspacePointerSample;
  readonly sourcePane: string;
  readonly gridBox: WorkspaceGridBox;
  readonly activated: boolean;
  readonly targetPane: string | null;
}

export type WorkspacePaneManipulation = WorkspacePaneIdle | WorkspacePaneResize | WorkspacePaneDrag;

export interface PaneTransform {
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export interface PanePreviewPlacement {
  /** Stable key: never changes when a swap preview changes targets. */
  readonly pane: string;
  readonly rect: TileRect;
  readonly transform: PaneTransform;
  readonly opacity: number;
  readonly elevated: boolean;
}

export type WorkspacePanePreview =
  | {
      readonly kind: "idle";
      readonly placements: readonly PanePreviewPlacement[];
    }
  | {
      readonly kind: "resize";
      readonly pane: string;
      readonly axis: "cols" | "rows";
      readonly originalCells: number;
      readonly cells: number;
      readonly movedCells: number;
      /** A cell-snapped compositor translation for the resize guide. */
      readonly guideTransform: PaneTransform;
      readonly placements: readonly PanePreviewPlacement[];
    }
  | {
      readonly kind: "drag";
      readonly sourcePane: string;
      readonly targetPane: string | null;
      readonly activated: boolean;
      readonly dropRect: TileRect | null;
      readonly placements: readonly PanePreviewPlacement[];
    };

export interface PaneResizeCommand {
  readonly pane: string;
  readonly axis: "cols" | "rows";
  readonly cells: number;
}

export interface PaneResizeWireDispatch {
  readonly command: PaneResizeCommand;
  readonly reason: "live" | "timer" | "final" | "rollback";
}

/**
 * A replaceable scheduling plan. The adapter dispatches `dispatch` immediately,
 * cancels its old timer, then installs `trailing` (if present). A trailing timer
 * calls {@link flushWorkspacePaneResizeWire}; it must not dispatch a stale
 * command captured by an earlier pointer sample.
 */
export interface PaneResizeWirePlan {
  readonly dispatch: PaneResizeWireDispatch | null;
  readonly trailing: {
    readonly dueAtMs: number;
    readonly delayMs: number;
    readonly command: PaneResizeCommand;
  } | null;
}

export interface WorkspacePaneManipulationUpdate {
  readonly state: WorkspacePaneManipulation;
  readonly preview: WorkspacePanePreview;
  readonly wire: PaneResizeWirePlan;
  readonly ignored: boolean;
}

export interface WorkspacePaneManipulationUpdateOptions {
  /**
   * Whether a resize sample may produce a tmux wire command. Browser surfaces
   * use local compositor feedback and commit once on release; the TUI's direct
   * control channel can opt into latest-wins live wire previews.
   */
  readonly wireResize?: boolean;
}

export type WorkspacePaneCompletion =
  | { readonly kind: "noop" }
  | {
      readonly kind: "resize";
      readonly pane: string;
      readonly axis: "cols" | "rows";
      readonly cells: number;
      readonly changed: boolean;
    }
  | {
      readonly kind: "swap";
      readonly sourcePane: string;
      readonly targetPane: string;
    }
  | { readonly kind: "cancelled"; readonly rolledBack: boolean };

export interface WorkspacePaneManipulationCompletion {
  readonly state: WorkspacePaneManipulation;
  readonly preview: WorkspacePanePreview;
  readonly wire: PaneResizeWirePlan;
  readonly completion: WorkspacePaneCompletion | null;
  readonly ignored: boolean;
}

const IDENTITY_TRANSFORM: PaneTransform = Object.freeze({
  translateX: 0,
  translateY: 0,
  scaleX: 1,
  scaleY: 1,
});

const EMPTY_WIRE: PaneResizeWirePlan = Object.freeze({ dispatch: null, trailing: null });

function frozenFrame(frame: LayoutFrame): LayoutFrame {
  const panes = Object.freeze(
    frame.panes.map((pane) =>
      Object.freeze({
        ...pane,
      }),
    ),
  );
  return Object.freeze({ ...frame, panes });
}

function snapshot(frame: LayoutFrame): WorkspaceLayoutSnapshot {
  const immutableFrame = frozenFrame(frame);
  const tiles = Object.freeze(
    layoutTiles(immutableFrame).map((tile) =>
      Object.freeze({
        ...tile,
        rect: Object.freeze({ ...tile.rect }),
        cells: Object.freeze({ ...tile.cells }),
      }),
    ),
  );
  const borders = Object.freeze(
    layoutBorders(immutableFrame).map((border) =>
      Object.freeze({ ...border, rect: Object.freeze({ ...border.rect }) }),
    ),
  );
  return Object.freeze({ frame: immutableFrame, tiles, borders });
}

export function paneManipulationPresentation(reducedMotion = false): PaneManipulationPresentation {
  return Object.freeze({
    reducedMotion,
    inputDelayMs: 0,
    liveProperties: Object.freeze(["transform", "opacity"] as const),
    liveTransitionMs: 0,
    settleTransition: Object.freeze({
      properties: Object.freeze(["transform", "opacity"] as const),
      durationMs: reducedMotion ? 0 : 150,
      easing: "var(--ease-smooth)",
    }),
  });
}

export function createWorkspacePaneIdle(
  frame: LayoutFrame,
  options: { readonly reducedMotion?: boolean } = {},
): WorkspacePaneIdle {
  return {
    kind: "idle",
    snapshot: snapshot(frame),
    presentation: paneManipulationPresentation(options.reducedMotion ?? false),
  };
}

function idleFrom(state: ManipulationBase): WorkspacePaneIdle {
  return { kind: "idle", snapshot: state.snapshot, presentation: state.presentation };
}

function primary(sample: WorkspacePointerSample): boolean {
  return sample.isPrimary !== false;
}

export function beginWorkspacePaneResize(
  state: WorkspacePaneManipulation,
  input: {
    readonly borderId: string;
    readonly pointer: WorkspacePointerSample;
    readonly gridBox: WorkspaceGridBox;
  },
): WorkspacePaneManipulation {
  if (state.kind !== "idle" || !primary(input.pointer)) return state;
  const border = state.snapshot.borders.find((candidate) => candidate.id === input.borderId);
  if (!border || input.gridBox.width <= 0 || input.gridBox.height <= 0) return state;
  return {
    kind: "resize",
    snapshot: state.snapshot,
    presentation: state.presentation,
    pointerId: input.pointer.pointerId,
    origin: input.pointer,
    current: input.pointer,
    border,
    gridBox: Object.freeze({ ...input.gridBox }),
    previewCells: border.cells,
    lastWireAtMs: null,
    lastWiredCells: null,
    pendingWire: null,
  };
}

export function beginWorkspacePaneDrag(
  state: WorkspacePaneManipulation,
  input: {
    readonly pane: string;
    readonly pointer: WorkspacePointerSample;
    readonly gridBox: WorkspaceGridBox;
  },
): WorkspacePaneManipulation {
  if (state.kind !== "idle" || !primary(input.pointer)) return state;
  if (
    input.gridBox.width <= 0 ||
    input.gridBox.height <= 0 ||
    !state.snapshot.tiles.some((tile) => tile.pane === input.pane)
  ) {
    return state;
  }
  return {
    kind: "drag",
    snapshot: state.snapshot,
    presentation: state.presentation,
    pointerId: input.pointer.pointerId,
    origin: input.pointer,
    current: input.pointer,
    sourcePane: input.pane,
    gridBox: Object.freeze({ ...input.gridBox }),
    activated: false,
    targetPane: null,
  };
}

function identityPlacements(
  snapshotValue: WorkspaceLayoutSnapshot,
): readonly PanePreviewPlacement[] {
  return snapshotValue.tiles.map((tile) => ({
    pane: tile.pane,
    rect: tile.rect,
    transform: IDENTITY_TRANSFORM,
    opacity: 1,
    elevated: false,
  }));
}

function axisOf(border: LayoutBorder): "cols" | "rows" {
  return border.orientation === "vertical" ? "cols" : "rows";
}

function snappedResize(state: WorkspacePaneResize, sample: WorkspacePointerSample): number {
  const vertical = state.border.orientation === "vertical";
  const totalCells = vertical ? state.snapshot.frame.cols : state.snapshot.frame.rows;
  const pixels = vertical ? state.gridBox.width : state.gridBox.height;
  const delta = vertical ? sample.x - state.origin.x : sample.y - state.origin.y;
  const movedCells = Math.round(delta / (pixels / totalCells));
  return Math.min(Math.max(state.border.cells + movedCells, 1), totalCells);
}

function paneAtPointer(state: WorkspacePaneDrag, sample: WorkspacePointerSample): string | null {
  const x = (sample.x - state.gridBox.left) / state.gridBox.width;
  const y = (sample.y - state.gridBox.top) / state.gridBox.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  const hit = state.snapshot.tiles.find(
    (tile) =>
      x >= tile.rect.left &&
      x < tile.rect.left + tile.rect.width &&
      y >= tile.rect.top &&
      y < tile.rect.top + tile.rect.height,
  );
  return hit?.pane === state.sourcePane ? null : (hit?.pane ?? null);
}

function mapRectTransform(from: TileRect, to: TileRect, box: WorkspaceGridBox): PaneTransform {
  return {
    translateX: (to.left - from.left) * box.width,
    translateY: (to.top - from.top) * box.height,
    scaleX: from.width > 0 ? to.width / from.width : 1,
    scaleY: from.height > 0 ? to.height / from.height : 1,
  };
}

function resizedTileRect(rect: TileRect, state: WorkspacePaneResize, movedCells: number): TileRect {
  const vertical = state.border.orientation === "vertical";
  const total = vertical ? state.snapshot.frame.cols : state.snapshot.frame.rows;
  const delta = movedCells / total;
  const owner = state.snapshot.tiles.find((tile) => tile.pane === state.border.pane);
  const boundary = owner
    ? vertical
      ? owner.rect.left + owner.rect.width
      : owner.rect.top + owner.rect.height
    : vertical
      ? state.border.rect.left
      : state.border.rect.top;
  const epsilon = 1 / Math.max(1, total * 2);
  if (vertical) {
    const right = rect.left + rect.width;
    if (Math.abs(right - boundary) <= epsilon) return { ...rect, width: rect.width + delta };
    if (Math.abs(rect.left - boundary) <= epsilon) {
      return { ...rect, left: rect.left + delta, width: rect.width - delta };
    }
    return rect;
  }
  const bottom = rect.top + rect.height;
  if (Math.abs(bottom - boundary) <= epsilon) return { ...rect, height: rect.height + delta };
  if (Math.abs(rect.top - boundary) <= epsilon) {
    return { ...rect, top: rect.top + delta, height: rect.height - delta };
  }
  return rect;
}

export function previewWorkspacePaneManipulation(
  state: WorkspacePaneManipulation,
): WorkspacePanePreview {
  const placements = identityPlacements(state.snapshot);
  if (state.kind === "idle") return { kind: "idle", placements };
  if (state.kind === "resize") {
    const movedCells = state.previewCells - state.border.cells;
    const vertical = state.border.orientation === "vertical";
    const pixelsPerCell =
      (vertical ? state.gridBox.width : state.gridBox.height) /
      (vertical ? state.snapshot.frame.cols : state.snapshot.frame.rows);
    return {
      kind: "resize",
      pane: state.border.pane,
      axis: axisOf(state.border),
      originalCells: state.border.cells,
      cells: state.previewCells,
      movedCells,
      guideTransform: {
        translateX: vertical ? movedCells * pixelsPerCell : 0,
        translateY: vertical ? 0 : movedCells * pixelsPerCell,
        scaleX: 1,
        scaleY: 1,
      },
      /*
       * Keep the pane's base width/height frozen during the gesture. Scaling
       * the already-composited tile makes pointer feedback one transform per
       * frame; changing its box would synchronously relayout and resize xterm's
       * canvas on every sample.
       */
      placements: placements.map((placement) => ({
        ...placement,
        transform: mapRectTransform(
          placement.rect,
          resizedTileRect(placement.rect, state, movedCells),
          state.gridBox,
        ),
      })),
    };
  }

  const source = state.snapshot.tiles.find((tile) => tile.pane === state.sourcePane);
  const target = state.snapshot.tiles.find((tile) => tile.pane === state.targetPane);
  const deltaX = state.current.x - state.origin.x;
  const deltaY = state.current.y - state.origin.y;
  const swapped = placements.map((placement): PanePreviewPlacement => {
    if (placement.pane === state.sourcePane) {
      return {
        ...placement,
        transform: state.activated
          ? { translateX: deltaX, translateY: deltaY, scaleX: 1, scaleY: 1 }
          : IDENTITY_TRANSFORM,
        opacity: state.activated ? 0.92 : 1,
        elevated: state.activated,
      };
    }
    if (source && target && placement.pane === target.pane) {
      return {
        ...placement,
        transform: mapRectTransform(target.rect, source.rect, state.gridBox),
      };
    }
    return placement;
  });
  return {
    kind: "drag",
    sourcePane: state.sourcePane,
    targetPane: state.targetPane,
    activated: state.activated,
    dropRect: target?.rect ?? null,
    placements: swapped,
  };
}

/**
 * Project a released drag into its durable swap geometry.
 *
 * Live dragging deliberately keeps the source under the pointer. Once the
 * pointer is released, that is no longer the useful visual truth: keeping the
 * source at the release coordinate until tmux confirms makes the authoritative
 * frame look like a second, unrelated jump. This projection puts both stable
 * pane identities in their destination boxes while the daemon round-trip is in
 * flight. When the confirmed frame arrives, removing these transforms is
 * pixel-equivalent to adopting the new base rectangles.
 */
export function commitWorkspacePaneDragPreview(
  state: WorkspacePaneDrag,
): Extract<WorkspacePanePreview, { readonly kind: "drag" }> {
  const placements = identityPlacements(state.snapshot);
  const source = state.snapshot.tiles.find((tile) => tile.pane === state.sourcePane);
  const target = state.snapshot.tiles.find((tile) => tile.pane === state.targetPane);

  if (!state.activated || !source || !target) {
    const preview = previewWorkspacePaneManipulation(state);
    if (preview.kind !== "drag") throw new Error("drag state produced a non-drag preview");
    return preview;
  }

  return {
    kind: "drag",
    sourcePane: state.sourcePane,
    targetPane: target.pane,
    activated: true,
    dropRect: target.rect,
    placements: placements.map((placement): PanePreviewPlacement => {
      if (placement.pane === source.pane) {
        return {
          ...placement,
          transform: mapRectTransform(source.rect, target.rect, state.gridBox),
        };
      }
      if (placement.pane === target.pane) {
        return {
          ...placement,
          transform: mapRectTransform(target.rect, source.rect, state.gridBox),
        };
      }
      return placement;
    }),
  };
}

function resizeCommand(state: WorkspacePaneResize, cells: number): PaneResizeCommand {
  return { pane: state.border.pane, axis: axisOf(state.border), cells };
}

function resizeWirePlan(
  state: WorkspacePaneResize,
  dispatch: PaneResizeWireDispatch | null,
): PaneResizeWirePlan {
  return {
    dispatch,
    trailing: state.pendingWire
      ? {
          dueAtMs: state.pendingWire.dueAtMs,
          delayMs: Math.max(0, state.pendingWire.dueAtMs - state.current.atMs),
          command: resizeCommand(state, state.pendingWire.cells),
        }
      : null,
  };
}

function updateResize(
  state: WorkspacePaneResize,
  sample: WorkspacePointerSample,
  wireResize: boolean,
): WorkspacePaneManipulationUpdate {
  const previewCells = snappedResize(state, sample);
  let next: WorkspacePaneResize = { ...state, current: sample, previewCells };
  let dispatch: PaneResizeWireDispatch | null = null;

  if (!wireResize) {
    next = { ...next, pendingWire: null };
    return {
      state: next,
      preview: previewWorkspacePaneManipulation(next),
      wire: EMPTY_WIRE,
      ignored: false,
    };
  }

  if (
    previewCells === state.lastWiredCells ||
    (previewCells === state.border.cells && state.lastWiredCells === null)
  ) {
    next = { ...next, pendingWire: null };
  } else if (
    state.lastWireAtMs === null ||
    sample.atMs - state.lastWireAtMs >= PANE_RESIZE_WIRE_INTERVAL_MS
  ) {
    dispatch = { command: resizeCommand(next, previewCells), reason: "live" };
    next = {
      ...next,
      lastWireAtMs: sample.atMs,
      lastWiredCells: previewCells,
      pendingWire: null,
    };
  } else {
    next = {
      ...next,
      pendingWire: {
        cells: previewCells,
        dueAtMs: state.lastWireAtMs + PANE_RESIZE_WIRE_INTERVAL_MS,
      },
    };
  }
  return {
    state: next,
    preview: previewWorkspacePaneManipulation(next),
    wire: resizeWirePlan(next, dispatch),
    ignored: false,
  };
}

function updateDrag(
  state: WorkspacePaneDrag,
  sample: WorkspacePointerSample,
): WorkspacePaneManipulationUpdate {
  const distance = Math.hypot(sample.x - state.origin.x, sample.y - state.origin.y);
  const activated = state.activated || distance >= PANE_DRAG_THRESHOLD_PX;
  const next: WorkspacePaneDrag = {
    ...state,
    current: sample,
    activated,
    targetPane: activated ? paneAtPointer(state, sample) : null,
  };
  return {
    state: next,
    preview: previewWorkspacePaneManipulation(next),
    wire: EMPTY_WIRE,
    ignored: false,
  };
}

export function updateWorkspacePaneManipulation(
  state: WorkspacePaneManipulation,
  sample: WorkspacePointerSample,
  options: WorkspacePaneManipulationUpdateOptions = {},
): WorkspacePaneManipulationUpdate {
  if (state.kind === "idle" || state.pointerId !== sample.pointerId || !primary(sample)) {
    return {
      state,
      preview: previewWorkspacePaneManipulation(state),
      wire: state.kind === "resize" ? resizeWirePlan(state, null) : EMPTY_WIRE,
      ignored: state.kind !== "idle",
    };
  }
  return state.kind === "resize"
    ? updateResize(state, sample, options.wireResize ?? true)
    : updateDrag(state, sample);
}

export function flushWorkspacePaneResizeWire(
  state: WorkspacePaneManipulation,
  atMs: number,
): WorkspacePaneManipulationUpdate {
  if (state.kind !== "resize" || !state.pendingWire) {
    return {
      state,
      preview: previewWorkspacePaneManipulation(state),
      wire: state.kind === "resize" ? resizeWirePlan(state, null) : EMPTY_WIRE,
      ignored: true,
    };
  }
  if (atMs < state.pendingWire.dueAtMs) {
    const current = { ...state, current: { ...state.current, atMs } };
    return {
      state: current,
      preview: previewWorkspacePaneManipulation(current),
      wire: resizeWirePlan(current, null),
      ignored: false,
    };
  }
  const cells = state.pendingWire.cells;
  const next: WorkspacePaneResize = {
    ...state,
    current: { ...state.current, atMs },
    lastWireAtMs: atMs,
    lastWiredCells: cells,
    pendingWire: null,
  };
  return {
    state: next,
    preview: previewWorkspacePaneManipulation(next),
    wire: resizeWirePlan(next, {
      command: resizeCommand(next, cells),
      reason: "timer",
    }),
    ignored: false,
  };
}

function completionResult(
  active: WorkspacePaneResize | WorkspacePaneDrag,
  completion: WorkspacePaneCompletion,
  wire: PaneResizeWirePlan = EMPTY_WIRE,
): WorkspacePaneManipulationCompletion {
  const idle = idleFrom(active);
  return {
    state: idle,
    preview: previewWorkspacePaneManipulation(idle),
    wire,
    completion,
    ignored: false,
  };
}

export function finishWorkspacePaneManipulation(
  state: WorkspacePaneManipulation,
  sample: WorkspacePointerSample,
): WorkspacePaneManipulationCompletion {
  if (state.kind === "idle" || state.pointerId !== sample.pointerId || !primary(sample)) {
    return {
      state,
      preview: previewWorkspacePaneManipulation(state),
      wire: state.kind === "resize" ? resizeWirePlan(state, null) : EMPTY_WIRE,
      completion: null,
      ignored: state.kind !== "idle",
    };
  }

  if (state.kind === "drag") {
    const updated = updateDrag(state, sample).state as WorkspacePaneDrag;
    return completionResult(
      updated,
      updated.activated && updated.targetPane
        ? { kind: "swap", sourcePane: updated.sourcePane, targetPane: updated.targetPane }
        : { kind: "noop" },
    );
  }

  const cells = snappedResize(state, sample);
  const changed = cells !== state.border.cells;
  // The release position wins even when it is the ORIGINAL size. A live wire
  // may already have resized tmux away from that size, so `changed` describes
  // the durable outcome while the last wired cell is what decides the flush.
  const effectiveWiredCells = state.lastWiredCells ?? state.border.cells;
  const dispatch =
    cells !== effectiveWiredCells
      ? { command: resizeCommand(state, cells), reason: "final" as const }
      : null;
  return completionResult(
    { ...state, current: sample, previewCells: cells, pendingWire: null },
    {
      kind: "resize",
      pane: state.border.pane,
      axis: axisOf(state.border),
      cells,
      changed,
    },
    { dispatch, trailing: null },
  );
}

export function cancelWorkspacePaneManipulation(
  state: WorkspacePaneManipulation,
  pointer?: { readonly pointerId: number },
): WorkspacePaneManipulationCompletion {
  if (state.kind === "idle" || (pointer && pointer.pointerId !== state.pointerId)) {
    return {
      state,
      preview: previewWorkspacePaneManipulation(state),
      wire: state.kind === "resize" ? resizeWirePlan(state, null) : EMPTY_WIRE,
      completion: null,
      ignored: state.kind !== "idle",
    };
  }
  if (state.kind === "drag") {
    return completionResult(state, { kind: "cancelled", rolledBack: state.activated });
  }
  const rolledBack = state.lastWiredCells !== null && state.lastWiredCells !== state.border.cells;
  return completionResult(
    { ...state, pendingWire: null },
    { kind: "cancelled", rolledBack },
    {
      dispatch: rolledBack
        ? {
            command: resizeCommand(state, state.border.cells),
            reason: "rollback",
          }
        : null,
      trailing: null,
    },
  );
}
