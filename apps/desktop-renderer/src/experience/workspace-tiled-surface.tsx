/**
 * The layout-faithful workspace view (m50): window tabs over tmux's own tiling.
 *
 * The shape of this surface is the whole scope call. There is ONE layout truth —
 * tmux's — and this renders it rather than keeping a second one beside it.
 *
 * How it is faithful by construction, which is the part worth understanding
 * before changing anything here:
 *
 *  - A desktop interactive attachment is a real `tmux attach-session` client
 *    pinned to ONE window, and tmux paints that whole window into it, pane
 *    borders and all. So the tiling on screen is not this view's arithmetic; it
 *    is tmux's, arriving as bytes. Nothing here can put a pane in the wrong
 *    place, because nothing here places a pane.
 *  - Interactive attachment ownership is WINDOW-keyed in the daemon's lease
 *    manager, so a second interactive attachment to another pane of the same
 *    window is refused. That is not a limitation this view works around — it is
 *    the reason the single-attachment shape is the right one.
 *  - What this view does own is the CHROME: which pane a click belongs to, where
 *    a context menu opens, where a border can be dragged. All of it is derived
 *    from the pane-stream layout frame by the pure functions in
 *    `workspace-layout-tiles.ts`, and all of it is positioned over the grid the
 *    terminal actually rendered — measured from the DOM, never assumed.
 *
 * The overlay covers no output. tmux spends exactly one cell on the border
 * between two panes, and the drag handles sit on those cells; a tile's own
 * region is transparent and only carries hit testing and a hover header.
 */
import { Index, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { PaneStreamLayoutEvent } from "../terminal/pane-stream-transport.ts";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import { Icon, type IconArtwork } from "../ui-system/icon.tsx";
import { DOM_ICON_METADATA } from "./dom-icons.ts";
import { gridOverlayBox } from "./grid-overlay.ts";
import { MirrorPaneNode } from "../terminal/mirror-pane-node.tsx";
import type { AppWindowCanvasMirrorProps } from "./app-window-canvas.tsx";
import {
  layoutBorders,
  layoutTiles,
  windowTabKey,
  windowTabs,
  type LayoutBorder,
  type LayoutFrame,
  type TileRect,
  type WindowTab,
} from "./workspace-layout-tiles.ts";
import {
  beginWorkspacePaneDrag,
  beginWorkspacePaneResize,
  cancelWorkspacePaneManipulation,
  createWorkspacePaneIdle,
  finishWorkspacePaneManipulation,
  flushWorkspacePaneResizeWire,
  previewWorkspacePaneManipulation,
  updateWorkspacePaneManipulation,
  type PaneResizeWirePlan,
  type WorkspacePaneDrag,
  type WorkspacePaneManipulation,
  type WorkspacePanePreview,
  type WorkspacePaneResize,
  type WorkspacePointerSample,
} from "./workspace-pane-manipulation.ts";

type PaneManipulationPhase =
  | "idle"
  | "resize-preview"
  | "resize-committing"
  | "dragging"
  | "drop-ready"
  | "swap-committing"
  | "rollback";

type TiledVerbResult = void | Promise<{ readonly status: "ok" | "error" }>;

export interface TiledSurfaceVerbs {
  readonly workspaceConnected: boolean;
  readonly invoke: (
    verbId: "pane.select" | "pane.swap" | "pane.resize" | "pane.kill",
    semanticPaneId: string,
    args?: {
      readonly resize?: { readonly axis: "cols" | "rows"; readonly cells: number };
      readonly swapTargetSemanticPaneId?: string;
    },
  ) => TiledVerbResult;
  /** The existing create flow, reused verbatim as the tab strip's "+". */
  readonly onCreateWindow?: () => void;
}

export interface WorkspaceTiledSurfaceProps {
  readonly layouts: readonly PaneStreamLayoutEvent[];
  readonly workspaceName: string;
  readonly transport?: NativeTerminalTransport | null;
  /** Pane chrome models by semantic pane id, for status glyphs. */
  readonly paneFrames: readonly PaneFrameModel[];
  /**
   * Titles by semantic pane id, from the daemon's terminal inventory.
   *
   * The inventory is where a pane's name lives for every pane; the chrome models
   * cover only the ones that are agents. Reading the title from the inventory
   * first is what stops a plain shell from being labelled "Terminal" while the
   * daemon knows perfectly well what it is called.
   */
  readonly paneTitles?: ReadonlyMap<string, string>;
  /**
   * The panes the daemon currently reports as attachable. A window with none of
   * them left has been closed — the pane-stream wire carries no "window closed"
   * frame, so this is what prunes a dead tab rather than a timeout.
   */
  readonly livePanes?: ReadonlySet<string>;
  /**
   * The pane to show before any layout frame has arrived — the inventory's own
   * active pane.
   *
   * Geometry can be late (the lease is still connecting) or absent (a daemon
   * whose control channel cannot report layouts). Waiting for it would leave a
   * user staring at a placeholder while a perfectly attachable terminal exists,
   * so the view degrades to the one thing it can be sure of: a single pane,
   * full bleed, no borders. It is the same view a single-pane window gets.
   */
  readonly fallbackPane?: string | null;
  /**
   * The session's windows as the daemon's inventory groups them, used until
   * layout frames arrive.
   *
   * The inventory already knows which panes share a tmux window, so the tab
   * strip can exist before any geometry does — which matters because creating a
   * window is one of the first things a user does, and a strip that appears
   * only once a layout frame happens to arrive would leave the new window with
   * nowhere to show up.
   */
  readonly fallbackWindows?: readonly {
    readonly key: string;
    readonly label: string;
    readonly panes: readonly string[];
    readonly active: boolean;
  }[];
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  readonly verbs: TiledSurfaceVerbs;
  readonly onOpenPaneMenu?: (
    semanticPaneId: string,
    pointer: { readonly x: number; readonly y: number },
  ) => void;
  readonly onOpenWindowMenu?: (
    semanticPaneId: string,
    pointer: { readonly x: number; readonly y: number },
  ) => void;
  readonly onFocusPane?: (semanticPaneId: string, source: "keyboard" | "mouse") => void;
  /**
   * The window whose tab is being renamed, named by a pane inside it. The tab
   * is where a rename belongs: it is where the name is READ, so it is where a
   * user looks to change it, and editing in place means the old name is visible
   * until the moment the new one is committed.
   */
  readonly renamingPane?: string | null;
  readonly onRenameCommit?: (semanticPaneId: string, name: string) => void;
  readonly onRenameCancel?: () => void;
  /** Reports whether a terminal attachment is currently open (see the status strip). */
  readonly onAttachmentChanged?: (attached: boolean) => void;
  /**
   * The pane-mirror affordance, carried over from the canvas unchanged in
   * meaning: a read-only peek at every attachable pane of the workspace, on a
   * deck below the tiled area. It answers the question the tiled view cannot —
   * what the panes you are NOT looking at are doing — so it stays a toggle
   * rather than becoming part of the default picture.
   */
  readonly mirror?: AppWindowCanvasMirrorProps;
}

function toFrame(layout: PaneStreamLayoutEvent): LayoutFrame {
  return layout;
}

/*
 * The header's own two glyphs, named from the semantic vocabulary rather than
 * drawn here, so a header control and a titlebar control are the same mark.
 */
const MENU_ICON = DOM_ICON_METADATA.more.artwork;
const CLOSE_ICON = DOM_ICON_METADATA.close.artwork;

/**
 * A pane's type glyph, from the semantic vocabulary.
 *
 * The role a pane frame reports IS the product's word for what the pane is, so
 * the mapping is role to icon and nothing is inferred from a title or a command
 * line. A pane with no frame model is a plain terminal — the common case, since
 * frames are built for agent panes — and terminal is what it gets.
 */
const ROLE_ICON: Readonly<Record<PaneFrameModel["pane"]["kind"], IconArtwork>> = {
  home: DOM_ICON_METADATA.home.artwork,
  terminal: DOM_ICON_METADATA.terminals.artwork,
  files: DOM_ICON_METADATA.files.artwork,
  changes: DOM_ICON_METADATA.changes.artwork,
  missions: DOM_ICON_METADATA.missions.artwork,
  activity: DOM_ICON_METADATA.activity.artwork,
  preview: DOM_ICON_METADATA.preview.artwork,
  native: DOM_ICON_METADATA.native.artwork,
};

/** Percentages, rounded to a precision the DOM will not thrash over. */
function percent(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

function pointerSample(event: PointerEvent): WorkspacePointerSample {
  return {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    atMs: performance.now(),
    isPrimary: event.isPrimary,
  };
}

function samePaneGeometry(
  left: LayoutFrame["panes"][number] | undefined,
  right: LayoutFrame["panes"][number] | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height,
  );
}

function transformedRectForResize(
  rect: TileRect,
  state: WorkspacePaneResize,
  preview: Extract<WorkspacePanePreview, { readonly kind: "resize" }>,
): TileRect {
  const vertical = state.border.orientation === "vertical";
  const total = vertical ? state.snapshot.frame.cols : state.snapshot.frame.rows;
  const delta = preview.movedCells / total;
  const boundary = vertical ? state.border.rect.left : state.border.rect.top;
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

export function WorkspaceTiledSurface(props: WorkspaceTiledSurfaceProps) {
  /**
   * The windows tmux still has.
   *
   * A layout frame is never retracted, so a killed window's last frame would sit
   * in the tab strip forever. A window survives here while any of its panes is
   * still attachable — the daemon's own inventory, which is pruned on kill.
   */
  const frames = createMemo<readonly LayoutFrame[]>(() => {
    const live = props.livePanes;
    return props.layouts.map(toFrame).filter((frame) => {
      if (!live) return true;
      const joined = frame.panes.filter((pane) => pane.pane !== null);
      return joined.length === 0 || joined.some((pane) => live.has(pane.pane!));
    });
  });
  const tabs = createMemo<readonly WindowTab[]>(() => {
    const fromFrames = windowTabs(frames());
    if (fromFrames.length > 0) return fromFrames;
    return (props.fallbackWindows ?? []).map((window) => ({
      semanticWindowId: null,
      label: window.label,
      active: window.active,
      paneCount: window.panes.length,
      zoomed: false,
      addressPane: window.panes[0] ?? null,
    }));
  });
  const currentFrame = createMemo<LayoutFrame | null>(
    () => frames().find((frame) => frame.currentWindow) ?? frames()[0] ?? null,
  );
  const tiles = createMemo(() => {
    const frame = currentFrame();
    if (frame) return layoutTiles(frame);
    const fallback = props.fallbackPane;
    return fallback
      ? [
          {
            pane: fallback,
            active: true,
            // No layout frame has arrived, so there is no separator row this
            // header could be hoisted into — it reveals on hover, like a pane
            // flush with the top of a window.
            headerRows: 0 as const,
            cells: { cols: 0, rows: 0 },
            rect: { left: 0, top: 0, width: 1, height: 1 },
          },
        ]
      : [];
  });
  const borders = createMemo(() => {
    const frame = currentFrame();
    return frame ? layoutBorders(frame) : [];
  });
  const paneCount = createMemo(() => currentFrame()?.panes.length ?? (props.fallbackPane ? 1 : 0));

  /**
   * The pane the attachment is addressed by, chosen for STABILITY rather than
   * for activity.
   *
   * One attach renders the whole window whichever of its panes names it, and
   * re-targeting tears the attachment down — into a window-keyed lease whose
   * grace period has not expired, which is exactly the "previous session is
   * still releasing" conflict. So clicking a tile moves tmux's active pane and
   * this does not move at all; the cursor follows because tmux drew it there.
   */
  let chosenAttachPane: string | null = null;
  const attachPane = createMemo<string | null>(() => {
    const frame = currentFrame();
    const joined = (frame?.panes ?? [])
      .map((pane) => pane.pane)
      .filter((pane): pane is string => pane !== null);
    if (joined.length === 0) {
      chosenAttachPane = props.fallbackPane ?? null;
      return chosenAttachPane;
    }
    // STICKY: keep the pane already attached while it is still in this window.
    // Every change here is a teardown and a re-attach into a window-keyed lease
    // whose grace period has not expired, so churn costs the user their
    // terminal — and geometry arriving a moment after the fallback was chosen
    // must not count as a reason to move.
    if (chosenAttachPane && joined.includes(chosenAttachPane)) return chosenAttachPane;
    const fallback = props.fallbackPane;
    chosenAttachPane =
      fallback && joined.includes(fallback) ? fallback : ([...joined].sort()[0] ?? null);
    return chosenAttachPane;
  });

  const frameFor = (semanticPaneId: string): PaneFrameModel | undefined =>
    props.paneFrames.find((model) => model.pane.id === semanticPaneId);
  const titleFor = (semanticPaneId: string): string =>
    props.paneTitles?.get(semanticPaneId) ?? frameFor(semanticPaneId)?.title ?? "Terminal";
  const iconFor = (semanticPaneId: string): IconArtwork => {
    const kind = frameFor(semanticPaneId)?.pane.kind;
    return kind ? ROLE_ICON[kind] : ROLE_ICON.terminal;
  };

  // ── Aligning the overlay to the grid the terminal actually rendered ────────
  //
  // A multi-pane window attaches size-passive: the surface renders the window's
  // own grid at its natural pixel size and CENTERS it, so the grid box is not
  // the pane area's box. The overlay follows the measured grid through the
  // rule-10 helper in `grid-overlay.ts`, which is where that invariant lives.
  let areaElement: HTMLDivElement | undefined;
  let overlayElement: HTMLDivElement | undefined;
  let overlayStyle: RuntimeStyleBinding | null = null;
  const [gridBox, setGridBox] = createSignal<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const positionOverlay = (): void => {
    if (!overlayElement || !areaElement) return;
    /*
     * Align to the terminal's VIEWPORT element, never to `.xterm-screen`.
     *
     * The screen element lives inside xterm's scroll area, so its rect moves
     * with the scrollback — measured against it the overlay drifted hundreds of
     * pixels below the terminal, which is how a right-click in the pane area
     * hit no pane at all. The viewport element is the grid's own box in both
     * modes: it fills the card when the surface drives tmux, and it shrinks to
     * the window's natural grid and centres when the card is size-passive.
     */
    const viewport = areaElement.querySelector<HTMLElement>(".terminal-surface__viewport");
    const area = areaElement.getBoundingClientRect();
    const natural = viewport?.getBoundingClientRect();
    overlayStyle ??= createRuntimeStyleBinding(overlayElement);
    // Scale 1 on purpose: the interactive surface letterboxes by CENTRING, with
    // no CSS transform (a transform would desync xterm's pointer-to-cell map),
    // so the rule-10 box collapses to the centred rectangle. Degenerate input
    // falls back to the whole area, which is what the helper already promises.
    const box = gridOverlayBox(
      { width: natural?.width ?? 0, height: natural?.height ?? 0 },
      { width: area.width, height: area.height },
      1,
    );
    overlayStyle.update({
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      right: "auto",
      bottom: "auto",
    });
    setGridBox({ width: box.width, height: box.height });
  };

  createEffect(() => {
    // Re-measure whenever the layout the overlay describes changes.
    void tiles();
    queueMicrotask(positionOverlay);
  });

  const observeArea = (element: HTMLDivElement): void => {
    areaElement = element;
    /*
     * The context menu listens in the CAPTURE phase.
     *
     * The terminal underneath is xterm, which handles `contextmenu` itself; a
     * bubbling listener would run after it and, where it stops propagation,
     * never at all. Capturing means the pane menu opens wherever the user
     * right-clicks in the pane area, which is the only rule worth having.
     */
    const onContextMenu = (event: MouseEvent): void => {
      const pane = tileAtPointer(event);
      if (!pane) return;
      event.preventDefault();
      props.onOpenPaneMenu?.(pane, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener("contextmenu", onContextMenu, true);
    onCleanup(() => element.removeEventListener("contextmenu", onContextMenu, true));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionOverlay());
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };
  onCleanup(() => overlayStyle?.dispose());

  /**
   * Which tile a pointer is over, from the overlay's own box and the tile
   * fractions. It is the same arithmetic the tiles are drawn with, so a hit can
   * never disagree with what the user sees.
   */
  const tileAtPointer = (event: PointerEvent | MouseEvent): string | null => {
    if (!overlayElement) return null;
    const box = overlayElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = tiles().find(
      (tile) =>
        x >= tile.rect.left &&
        x < tile.rect.left + tile.rect.width &&
        y >= tile.rect.top &&
        y < tile.rect.top + tile.rect.height,
    );
    return hit?.pane ?? null;
  };

  // ── Pane direct manipulation ──────────────────────────────────────────────
  // A transaction freezes the frame it began on. Pointer feedback is local and
  // compositor-only; tmux mutations are confirmations of that preview, never
  // the source of the preview itself.
  const [manipulation, setManipulation] = createSignal<WorkspacePaneManipulation | null>(null);
  const [localPreview, setLocalPreview] = createSignal<WorkspacePanePreview | null>(null);
  const [committingState, setCommittingState] = createSignal<
    WorkspacePaneResize | WorkspacePaneDrag | null
  >(null);
  const [committingPreview, setCommittingPreview] = createSignal<WorkspacePanePreview | null>(null);
  const [phase, setPhase] = createSignal<PaneManipulationPhase>("idle");
  const [lastConfirmedCells, setLastConfirmedCells] = createSignal<number | null>(null);
  let resizeWireTimer: ReturnType<typeof setTimeout> | null = null;
  let commitTimeout: ReturnType<typeof setTimeout> | null = null;
  let touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTouchDrag: {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
  } | null = null;

  const clearResizeWireTimer = (): void => {
    if (resizeWireTimer !== null) clearTimeout(resizeWireTimer);
    resizeWireTimer = null;
  };
  const clearCommitTimeout = (): void => {
    if (commitTimeout !== null) clearTimeout(commitTimeout);
    commitTimeout = null;
  };
  const clearTouchLongPress = (): void => {
    if (touchLongPressTimer !== null) clearTimeout(touchLongPressTimer);
    touchLongPressTimer = null;
    pendingTouchDrag = null;
  };
  onCleanup(() => {
    clearResizeWireTimer();
    clearCommitTimeout();
    clearTouchLongPress();
  });
  if (typeof window !== "undefined") {
    const onManipulationKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || phase() === "idle") return;
      event.preventDefault();
      cancelManipulation();
    };
    window.addEventListener("keydown", onManipulationKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onManipulationKeyDown));
  }

  const currentGridBox = () => {
    const box = overlayElement?.getBoundingClientRect();
    return {
      left: box?.left ?? 0,
      top: box?.top ?? 0,
      width: box?.width ?? gridBox().width,
      height: box?.height ?? gridBox().height,
    };
  };

  const settle = (rolledBack = false): void => {
    clearResizeWireTimer();
    clearCommitTimeout();
    setCommittingState(null);
    setCommittingPreview(null);
    setLocalPreview(null);
    setPhase(rolledBack ? "rollback" : "idle");
    const frame = currentFrame();
    setManipulation(
      frame ? createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }) : null,
    );
    if (rolledBack) {
      const settleMs = props.reducedMotion ? 0 : 150;
      commitTimeout = setTimeout(() => {
        commitTimeout = null;
        setPhase("idle");
      }, settleMs);
    }
  };

  const mutationFailed = (result: unknown): boolean =>
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "error";

  const dispatchResize = (plan: PaneResizeWirePlan): void => {
    clearResizeWireTimer();
    if (plan.dispatch) {
      const { pane, axis, cells } = plan.dispatch.command;
      Promise.resolve(props.verbs.invoke("pane.resize", pane, { resize: { axis, cells } })).then(
        (result) => {
          if (mutationFailed(result) && phase() === "resize-preview") cancelManipulation();
        },
        () => {
          if (phase() === "resize-preview") cancelManipulation();
        },
      );
    }
    if (plan.trailing) {
      resizeWireTimer = setTimeout(() => {
        resizeWireTimer = null;
        const state = manipulation();
        if (!state) return;
        const flushed = flushWorkspacePaneResizeWire(state, performance.now());
        setManipulation(flushed.state);
        setLocalPreview(flushed.preview);
        dispatchResize(flushed.wire);
      }, plan.trailing.delayMs);
    }
  };

  const beginResize = (borderId: string, event: PointerEvent): void => {
    if (!props.verbs.workspaceConnected || phase() !== "idle") return;
    const frame = currentFrame();
    if (!frame) return;
    const started = beginWorkspacePaneResize(
      createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }),
      { borderId, pointer: pointerSample(event), gridBox: currentGridBox() },
    );
    if (started.kind !== "resize") return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setLastConfirmedCells(started.border.cells);
    setManipulation(started);
    setLocalPreview(previewWorkspacePaneManipulation(started));
    setPhase("resize-preview");
  };

  const beginPaneDrag = (pane: string, event: PointerEvent): void => {
    if (!props.verbs.workspaceConnected || phase() !== "idle" || event.button !== 0) return;
    const frame = currentFrame();
    if (!frame) return;
    const started = beginWorkspacePaneDrag(
      createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }),
      { pane, pointer: pointerSample(event), gridBox: currentGridBox() },
    );
    if (started.kind !== "drag") return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setManipulation(started);
    setLocalPreview(previewWorkspacePaneManipulation(started));
    setPhase("dragging");
    if (event.pointerType === "touch") {
      pendingTouchDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      touchLongPressTimer = setTimeout(() => {
        touchLongPressTimer = null;
        pendingTouchDrag = null;
      }, 400);
    }
  };

  const moveManipulation = (event: PointerEvent): void => {
    const state = manipulation();
    if (!state || state.kind === "idle") return;
    if (state.kind === "drag" && pendingTouchDrag?.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - pendingTouchDrag.x, event.clientY - pendingTouchDrag.y) >= 5) {
        cancelManipulation(event);
      }
      return;
    }
    const updated = updateWorkspacePaneManipulation(state, pointerSample(event));
    if (updated.ignored) return;
    setManipulation(updated.state);
    setLocalPreview(updated.preview);
    if (updated.preview.kind === "drag") {
      setPhase(updated.preview.targetPane ? "drop-ready" : "dragging");
    }
    dispatchResize(updated.wire);
  };

  const beginCommitTimeout = (): void => {
    clearCommitTimeout();
    commitTimeout = setTimeout(() => settle(true), 2_000);
  };

  const finishManipulation = (event: PointerEvent): void => {
    const state = manipulation();
    if (!state || state.kind === "idle") return;
    clearTouchLongPress();
    const releaseSample = pointerSample(event);
    // The release coordinate is authoritative even when no pointermove landed
    // in that frame. Preview it without adopting its wire bookkeeping; finish
    // still compares against commands that were actually dispatched.
    const preview = updateWorkspacePaneManipulation(state, releaseSample).preview;
    const finished = finishWorkspacePaneManipulation(state, releaseSample);
    if (finished.ignored || !finished.completion) return;
    clearResizeWireTimer();
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    setManipulation(finished.state);
    dispatchResize(finished.wire);

    if (
      finished.completion.kind === "resize" &&
      (finished.completion.changed || finished.wire.dispatch !== null)
    ) {
      setCommittingState(state);
      setCommittingPreview(preview);
      setPhase("resize-committing");
      beginCommitTimeout();
      return;
    }
    if (finished.completion.kind === "swap") {
      setCommittingState(state);
      setCommittingPreview(preview);
      setPhase("swap-committing");
      beginCommitTimeout();
      Promise.resolve(
        props.verbs.invoke("pane.swap", finished.completion.sourcePane, {
          swapTargetSemanticPaneId: finished.completion.targetPane,
        }),
      ).then(
        (result) => {
          if (mutationFailed(result)) settle(true);
        },
        () => settle(true),
      );
      return;
    }
    settle(false);
  };

  function cancelManipulation(event?: PointerEvent): void {
    const state = manipulation();
    if (!state || state.kind === "idle") return;
    clearTouchLongPress();
    const cancelled = cancelWorkspacePaneManipulation(
      state,
      event ? { pointerId: event.pointerId } : undefined,
    );
    if (cancelled.ignored) return;
    clearResizeWireTimer();
    if (event) (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    setManipulation(cancelled.state);
    dispatchResize(cancelled.wire);
    settle(cancelled.completion?.kind === "cancelled" ? cancelled.completion.rolledBack : false);
  }

  createEffect(() => {
    const frame = currentFrame();
    if (!frame) return;
    const pending = committingState();
    const preview = committingPreview();
    if (pending?.kind === "resize" && preview?.kind === "resize") {
      const pane = frame.panes.find((candidate) => candidate.pane === preview.pane);
      const confirmed = preview.axis === "cols" ? pane?.width : pane?.height;
      if (confirmed === preview.cells) {
        setLastConfirmedCells(confirmed);
        settle(false);
      }
      return;
    }
    if (pending?.kind === "drag" && preview?.kind === "drag" && preview.targetPane) {
      const beforeSource = pending.snapshot.frame.panes.find(
        (pane) => pane.pane === preview.sourcePane,
      );
      const beforeTarget = pending.snapshot.frame.panes.find(
        (pane) => pane.pane === preview.targetPane,
      );
      const afterSource = frame.panes.find((pane) => pane.pane === preview.sourcePane);
      const afterTarget = frame.panes.find((pane) => pane.pane === preview.targetPane);
      if (
        samePaneGeometry(beforeSource, afterTarget) &&
        samePaneGeometry(beforeTarget, afterSource)
      ) {
        settle(false);
      }
      return;
    }
  });

  const displayPreview = createMemo(() => committingPreview() ?? localPreview());
  const resizePreview = createMemo(() => {
    const preview = displayPreview();
    return preview?.kind === "resize" ? preview : null;
  });
  const dragPreview = createMemo(() => {
    const preview = displayPreview();
    return preview?.kind === "drag" ? preview : null;
  });
  const displayState = createMemo(() => committingState() ?? manipulation());
  const displayTiles = createMemo(() => {
    const state = displayState();
    return state && state.kind !== "idle" ? state.snapshot.tiles : tiles();
  });
  const displayBorders = createMemo(() => {
    const state = displayState();
    return state && state.kind !== "idle" ? state.snapshot.borders : borders();
  });
  const rectForTile = (tile: ReturnType<typeof layoutTiles>[number]): TileRect => {
    const state = displayState();
    const preview = displayPreview();
    return state?.kind === "resize" && preview?.kind === "resize"
      ? transformedRectForResize(tile.rect, state, preview)
      : tile.rect;
  };
  const placementFor = (pane: string) =>
    displayPreview()?.placements.find((placement) => placement.pane === pane);

  const keyboardSwap = (sourcePane: string, key: string): void => {
    if (!props.verbs.workspaceConnected || phase() !== "idle") return;
    const frame = currentFrame();
    const box = currentGridBox();
    const source = tiles().find((tile) => tile.pane === sourcePane);
    if (!frame || !source || box.width <= 0 || box.height <= 0) return;
    const center = (rect: TileRect) => ({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const from = center(source.rect);
    const candidates = tiles()
      .filter((tile) => tile.pane !== sourcePane)
      .map((tile) => ({ tile, point: center(tile.rect) }))
      .filter(({ point }) => {
        if (key === "ArrowLeft") return point.x < from.x;
        if (key === "ArrowRight") return point.x > from.x;
        if (key === "ArrowUp") return point.y < from.y;
        if (key === "ArrowDown") return point.y > from.y;
        return true;
      })
      .sort((left, right) => {
        const leftDistance = Math.hypot(left.point.x - from.x, left.point.y - from.y);
        const rightDistance = Math.hypot(right.point.x - from.x, right.point.y - from.y);
        return leftDistance - rightDistance;
      });
    const target = candidates[0];
    if (!target) return;
    const atMs = performance.now();
    const started = beginWorkspacePaneDrag(
      createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }),
      {
        pane: sourcePane,
        pointer: {
          pointerId: -1,
          x: box.left + from.x * box.width,
          y: box.top + from.y * box.height,
          atMs,
        },
        gridBox: box,
      },
    );
    if (started.kind !== "drag") return;
    const moved = updateWorkspacePaneManipulation(started, {
      pointerId: -1,
      x: box.left + target.point.x * box.width,
      y: box.top + target.point.y * box.height,
      atMs: atMs + 1,
    });
    if (moved.state.kind !== "drag" || moved.preview.kind !== "drag") return;
    setManipulation(createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }));
    setCommittingState(moved.state);
    setCommittingPreview(moved.preview);
    setPhase("swap-committing");
    beginCommitTimeout();
    Promise.resolve(
      props.verbs.invoke("pane.swap", sourcePane, {
        swapTargetSemanticPaneId: target.tile.pane,
      }),
    ).then(
      (result) => {
        if (mutationFailed(result)) settle(true);
      },
      () => settle(true),
    );
  };

  const keyboardResize = (border: LayoutBorder, delta: number): void => {
    if (!props.verbs.workspaceConnected || phase() !== "idle") return;
    const frame = currentFrame();
    const box = currentGridBox();
    if (!frame || box.width <= 0 || box.height <= 0) return;
    const started = beginWorkspacePaneResize(
      createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }),
      {
        borderId: border.id,
        pointer: { pointerId: -2, x: box.left, y: box.top, atMs: performance.now() },
        gridBox: box,
      },
    );
    if (started.kind !== "resize") return;
    const cellPixels =
      border.orientation === "vertical" ? box.width / frame.cols : box.height / frame.rows;
    const moved = updateWorkspacePaneManipulation(started, {
      pointerId: -2,
      x: box.left + (border.orientation === "vertical" ? delta * cellPixels : 0),
      y: box.top + (border.orientation === "horizontal" ? delta * cellPixels : 0),
      atMs: performance.now(),
    });
    if (moved.state.kind !== "resize" || moved.preview.kind !== "resize") return;
    setLastConfirmedCells(border.cells);
    setManipulation(createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }));
    setCommittingState(moved.state);
    setCommittingPreview(moved.preview);
    setPhase("resize-committing");
    beginCommitTimeout();
    Promise.resolve(
      props.verbs.invoke("pane.resize", border.pane, {
        resize: {
          axis: border.orientation === "vertical" ? "cols" : "rows",
          cells: moved.preview.cells,
        },
      }),
    ).then(
      (result) => {
        if (mutationFailed(result)) settle(true);
      },
      () => settle(true),
    );
  };

  return (
    <div class="tiled-workspace" data-window-count={tabs().length}>
      <nav
        class="window-tabs"
        aria-label="tmux windows"
        role="tablist"
        data-focus-zone="window-tabs"
      >
        <Index each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              class="window-tabs__tab"
              data-window-tab={tab().semanticWindowId ?? ""}
              data-active={tab().active}
              aria-selected={tab().active}
              // A window whose panes carry no verified identity cannot be
              // addressed, so its tab refuses rather than dispatching into
              // nothing and reading as a broken control.
              disabled={tab().addressPane === null}
              title={
                tab().addressPane === null
                  ? "This window is not addressable yet"
                  : `${tab().label} — ${tab().paneCount} pane${tab().paneCount === 1 ? "" : "s"}`
              }
              onClick={() => {
                const pane = tab().addressPane;
                if (pane && !tab().active) props.verbs.invoke("pane.select", pane);
              }}
              onContextMenu={(event) => {
                const pane = tab().addressPane;
                if (!pane) return;
                event.preventDefault();
                props.onOpenWindowMenu?.(pane, { x: event.clientX, y: event.clientY });
              }}
            >
              <Show
                when={props.renamingPane !== null && props.renamingPane === tab().addressPane}
                fallback={<span class="window-tabs__label">{tab().label}</span>}
              >
                <input
                  class="window-tabs__rename-field"
                  aria-label="Window name"
                  value={tab().label}
                  ref={(element) => queueMicrotask(() => element.select())}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      props.onRenameCancel?.();
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const pane = tab().addressPane;
                    const typed = event.currentTarget.value.trim();
                    if (pane && typed) props.onRenameCommit?.(pane, typed);
                    else props.onRenameCancel?.();
                  }}
                  onBlur={() => props.onRenameCancel?.()}
                />
              </Show>
              <Show when={tab().paneCount > 1}>
                <span class="window-tabs__count" aria-hidden="true">
                  {tab().paneCount}
                </span>
              </Show>
              <Show when={tab().zoomed}>
                <span class="window-tabs__zoom" title="This window is zoomed">
                  ⛶
                </span>
              </Show>
            </button>
          )}
        </Index>
        <Show when={props.verbs.onCreateWindow}>
          {(create) => (
            <button
              type="button"
              class="window-tabs__create"
              aria-label="New terminal or agent"
              title="New terminal or agent"
              onClick={() => create()()}
            >
              +
            </button>
          )}
        </Show>
      </nav>

      <div
        class="tiled-pane-area"
        ref={observeArea}
        data-pane-count={paneCount()}
        data-zoomed={currentFrame()?.zoomed ?? false}
        data-focus-zone="canvas"
        data-manipulation-phase={phase()}
        data-manipulation-preview-cells={resizePreview()?.cells}
        data-last-confirmed-cells={lastConfirmedCells() ?? undefined}
        /*
         * Pane hit testing lives on the AREA, not on the tiles.
         *
         * The tiles are `pointer-events: none` so a left click reaches the
         * terminal underneath — which is a real tmux client, so tmux selects the
         * pane itself, exactly as it would for an ssh client. Listening here
         * lets the view follow along (and cover a tmux with mouse mode off)
         * without ever swallowing the click that types.
         */
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const pane = tileAtPointer(event);
          const active = tiles().find((tile) => tile.active)?.pane;
          if (pane && pane !== active) props.verbs.invoke("pane.select", pane);
        }}
      >
        <Show
          when={attachPane()}
          fallback={
            <div class="tiled-pane-area__empty" role="status">
              <strong>No addressable window</strong>
              <span>
                {tabs().length === 0
                  ? "Waiting for tmux to report this session's windows."
                  : "This window's panes have no verified identity yet."}
              </span>
            </div>
          }
        >
          {(semanticPaneId) => (
            <TerminalSurface
              target={{ workspaceName: props.workspaceName, semanticPaneId: semanticPaneId() }}
              title={titleFor(semanticPaneId())}
              transport={props.transport}
              focused
              /*
               * THE GEOMETRY OWNER (m50.2, gap 1).
               *
               * The visible window's interactive attachment is the one client
               * whose size tmux should follow, so it asks for ownership and the
               * daemon attaches it without `-f ignore-size`. The surface then
               * measures this card, floors it into whole cells, and drives tmux
               * to match; tmux re-tiles, the layout frame comes back, and the
               * view re-renders from it. tmux is still the only layout truth —
               * this closes a loop through it rather than computing beside it.
               *
               * What this replaces: a size-passive card rendered the window's
               * own grid centred, so a window sized for someone else's terminal
               * sat in the middle of the app under a sea of letterbox. The
               * faithfulness argument for that was real but backwards — the
               * proportions were tmux's because nothing had told tmux the size
               * of the surface it was being shown in.
               *
               * Ownership is exclusive per window because the interactive lease
               * already is, and it is released when this attachment is. Every
               * mirror on the deck below stays passive.
               */
              geometryOwnership="owner"
              reducedMotion={props.reducedMotion}
              themeKey={props.terminalThemeKey}
              onFocus={(source) => {
                const active = tiles().find((tile) => tile.active);
                if (active) props.onFocusPane?.(active.pane, source);
              }}
            />
          )}
        </Show>

        <div class="tiled-pane-area__overlay" ref={(element) => (overlayElement = element)}>
          <Index each={displayTiles()}>
            {(tile) => {
              const rect = createMemo(() => rectForTile(tile()));
              const placement = createMemo(() => placementFor(tile().pane));
              return (
                <div
                  class="pane-tile"
                  data-pane={tile().pane}
                  data-active={tile().active}
                  data-drop-target={dragPreview()?.targetPane === tile().pane ? "true" : undefined}
                  data-elevated={placement()?.elevated ?? false}
                  style={{
                    left: percent(rect().left),
                    top: percent(rect().top),
                    width: percent(rect().width),
                    height: percent(rect().height),
                    transform: placement()
                      ? `translate3d(${placement()!.transform.translateX}px, ${placement()!.transform.translateY}px, 0) scale(${placement()!.transform.scaleX}, ${placement()!.transform.scaleY})`
                      : undefined,
                    opacity: placement()?.opacity,
                  }}
                >
                  <PaneHeader
                    pane={tile().pane}
                    title={titleFor(tile().pane)}
                    icon={iconFor(tile().pane)}
                    status={frameFor(tile().pane)?.status ?? null}
                    active={tile().active}
                    /*
                     * The header's share of its own tile.
                     *
                     * The tile is `pane.height + headerRows` cells tall and the
                     * header is the one separator row of it, so the header is that
                     * fraction of the box — which keeps it exactly one terminal row
                     * tall at every window size without the component ever knowing
                     * a pixel. A tile with no separator row above it reports 0 and
                     * the header falls back to a hover overlay on the pane's own
                     * first row (styles.css), because there is no free row to take.
                     */
                    heightFraction={tile().headerRows / (tile().cells.rows + tile().headerRows)}
                    hoisted={tile().headerRows === 1}
                    onOpenMenu={(pointer) => props.onOpenPaneMenu?.(tile().pane, pointer)}
                    onClose={() => props.verbs.invoke("pane.kill", tile().pane)}
                    dragging={dragPreview()?.sourcePane === tile().pane}
                    onPointerDown={(event) => beginPaneDrag(tile().pane, event)}
                    onPointerMove={moveManipulation}
                    onPointerUp={finishManipulation}
                    onPointerCancel={(event) => cancelManipulation(event)}
                    onKeyboardSwap={(key) => keyboardSwap(tile().pane, key)}
                  />
                  <span class="sr-only">
                    {titleFor(tile().pane)}
                    {tile().active ? ", active pane" : ""}
                  </span>
                </div>
              );
            }}
          </Index>
          <Index each={displayBorders()}>
            {(border) => (
              <div
                class="pane-border"
                data-pane-border={border().id}
                data-orientation={border().orientation}
                data-dragging={
                  displayState()?.kind === "resize" &&
                  (displayState() as WorkspacePaneResize).border.id === border().id
                }
                role="separator"
                tabIndex={0}
                aria-orientation={border().orientation}
                aria-label={`Resize pane ${border().orientation === "vertical" ? "width" : "height"}`}
                aria-valuemin={1}
                aria-valuemax={
                  border().orientation === "vertical"
                    ? (displayState()?.snapshot.frame.cols ?? currentFrame()?.cols ?? 1)
                    : (displayState()?.snapshot.frame.rows ?? currentFrame()?.rows ?? 1)
                }
                aria-valuenow={resizePreview()?.cells ?? border().cells}
                aria-valuetext={`${resizePreview()?.cells ?? border().cells} ${border().orientation === "vertical" ? "columns" : "rows"}`}
                style={{
                  left: percent(border().rect.left),
                  top: percent(border().rect.top),
                  width: percent(border().rect.width),
                  height: percent(border().rect.height),
                  transform:
                    displayState()?.kind === "resize" &&
                    (displayState() as WorkspacePaneResize).border.id === border().id &&
                    resizePreview()
                      ? `translate3d(${resizePreview()!.guideTransform.translateX}px, ${resizePreview()!.guideTransform.translateY}px, 0)`
                      : undefined,
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  beginResize(border().id, event);
                }}
                onPointerMove={moveManipulation}
                onPointerUp={finishManipulation}
                onPointerCancel={(event) => cancelManipulation(event)}
                onKeyDown={(event) => {
                  const vertical = border().orientation === "vertical";
                  const decrease =
                    (vertical && event.key === "ArrowLeft") ||
                    (!vertical && event.key === "ArrowUp");
                  const increase =
                    (vertical && event.key === "ArrowRight") ||
                    (!vertical && event.key === "ArrowDown");
                  if (!decrease && !increase) return;
                  event.preventDefault();
                  keyboardResize(border(), increase ? 1 : -1);
                }}
              />
            )}
          </Index>
          <Show when={dragPreview()?.dropRect}>
            <div
              class="pane-drop-ghost"
              aria-hidden="true"
              style={{
                left: percent(dragPreview()!.dropRect!.left),
                top: percent(dragPreview()!.dropRect!.top),
                width: percent(dragPreview()!.dropRect!.width),
                height: percent(dragPreview()!.dropRect!.height),
              }}
            />
          </Show>
          <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {dragPreview()?.targetPane
              ? `${titleFor(dragPreview()!.sourcePane)} will swap with ${titleFor(dragPreview()!.targetPane!)}`
              : phase() === "rollback"
                ? "Pane manipulation cancelled"
                : phase() === "swap-committing"
                  ? "Swapping panes"
                  : ""}
          </span>
        </div>
      </div>
      <Show when={props.mirror}>
        {(mirror) => (
          <div class="mirror-deck" data-enabled={mirror().enabled}>
            <div class="mirror-deck__controls">
              <button
                type="button"
                class="mirror-deck__toggle"
                aria-pressed={mirror().enabled}
                data-mirror-toggle="true"
                onClick={() => mirror().onToggle(!mirror().enabled)}
              >
                Mirror
              </button>
            </div>
            <Show when={mirror().enabled}>
              {/*
               * `Index`, never `For`.
               *
               * The node list is rebuilt on every stream tick, so `For` — which
               * keys by reference — would throw away each node's DOM and
               * re-initialize its xterm several times a second. That is the
               * re-mount defect the mirror was fixed for once already; the
               * element identity is what the suite asserts across ticks.
               */}
              <div class="mirror-deck__nodes">
                <Index each={mirror().nodes}>
                  {(node) => (
                    <div
                      class="mirror-deck__node"
                      data-mirror-node-id={`mirror:${node().pane}`}
                      data-pane={node().pane}
                      data-state={node().state.kind}
                    >
                      <span class="mirror-deck__title">{node().title}</span>
                      <MirrorPaneNode
                        pane={node().pane}
                        title={node().title}
                        state={node().state}
                        connection={mirror().connection}
                        faultLabel={mirror().faultLabel}
                        registerSink={node().registerSink}
                        onRetry={mirror().onRetry}
                        reducedMotion={props.reducedMotion}
                        themeKey={props.terminalThemeKey}
                      />
                    </div>
                  )}
                </Index>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <AttachmentReporter area={() => areaElement} onChange={props.onAttachmentChanged} />
    </div>
  );
}

/**
 * How long an armed close stays armed.
 *
 * The confirm exists so a stray click cannot kill a pane; an arm that never
 * expires turns the NEXT visit to the same button — minutes later, in a
 * different task — into the confirming click. Disarming on a timer, on pointer
 * exit and on blur means the second click has to be a deliberate follow-up to
 * the first.
 */
const CLOSE_CONFIRM_MS = 4_000;

/**
 * One pane's header (m50.2, gap 3).
 *
 * It occupies the separator row tmux already draws above the pane, so it costs
 * no output — see the mosaic invariant in `workspace-layout-tiles.ts`. The
 * header carries the pane's type, its live title, its status glyph, and the two
 * verbs a header is the natural home for: the full menu, and close.
 *
 * Close ARMS rather than firing, matching the destructive discipline the verb
 * menu already holds itself to. A close button beside a menu button, both one
 * row tall, is exactly the geometry in which a mis-aimed click happens; making
 * the first click reversible is what keeps the affordance worth having.
 */
function PaneHeader(props: {
  readonly pane: string;
  readonly title: string;
  readonly icon: IconArtwork;
  readonly status: PaneFrameModel["status"] | null;
  readonly active: boolean;
  readonly heightFraction: number;
  readonly hoisted: boolean;
  readonly dragging: boolean;
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onPointerCancel: (event: PointerEvent) => void;
  readonly onKeyboardSwap: (key: string) => void;
  readonly onOpenMenu: (pointer: { readonly x: number; readonly y: number }) => void;
  readonly onClose: () => void;
}) {
  const [armed, setArmed] = createSignal(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
    disarmTimer = null;
    setArmed(false);
  };
  const arm = (): void => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
    setArmed(true);
    disarmTimer = setTimeout(disarm, CLOSE_CONFIRM_MS);
  };
  onCleanup(disarm);

  return (
    <div
      class="pane-tile__header"
      data-hoisted={props.hoisted}
      data-active={props.active}
      style={props.hoisted ? { height: percent(props.heightFraction) } : undefined}
      onPointerLeave={disarm}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
    >
      <Icon class="pane-tile__icon" icon={props.icon} size="control" />
      <span
        class="pane-tile__title"
        data-pane-drag-handle={props.pane}
        data-dragging={props.dragging}
        role="button"
        tabIndex={0}
        aria-label={`Drag ${props.title} to swap panes; use Alt plus an arrow key with the keyboard`}
        aria-pressed={props.dragging}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        title={`Drag to swap ${props.title}; keyboard: Alt+Arrow`}
        onKeyDown={(event) => {
          const directional = event.altKey && event.key.startsWith("Arrow");
          const nearest = event.key === "Enter" || event.key === " ";
          if (!directional && !nearest) return;
          event.preventDefault();
          props.onKeyboardSwap(directional ? event.key : "nearest");
        }}
      >
        {props.title}
      </span>
      <Show when={props.status}>
        {(status) => (
          <i class="pane-tile__status" data-tone={status().tone} title={status().label} />
        )}
      </Show>
      <button
        type="button"
        class="pane-tile__action"
        data-pane-menu={props.pane}
        aria-label={`Actions for ${props.title}`}
        title={`Actions for ${props.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          disarm();
          // Opened at the button's own bottom-left, not at the pointer: a menu
          // summoned from a control belongs under that control, wherever the
          // click happened to land inside it.
          const box = event.currentTarget.getBoundingClientRect();
          props.onOpenMenu({ x: box.left, y: box.bottom });
        }}
      >
        <Icon icon={MENU_ICON} size="control" />
      </button>
      <button
        type="button"
        class="pane-tile__action"
        data-pane-close={props.pane}
        data-confirm-pending={armed()}
        aria-label={
          armed() ? `Close ${props.title} — this cannot be undone` : `Close ${props.title}`
        }
        title={armed() ? "Click again to close — this cannot be undone" : `Close ${props.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={disarm}
        onKeyDown={(event) => {
          if (event.key === "Escape") disarm();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (!armed()) {
            arm();
            return;
          }
          disarm();
          props.onClose();
        }}
      >
        <Icon icon={CLOSE_ICON} size="control" />
      </button>
    </div>
  );
}

/**
 * Watches whether a terminal attachment is actually open.
 *
 * It exists for one honesty bug: the status strip printed "No desktop terminal
 * attachment is open" over a connected terminal, because that line comes from a
 * daemon projection which cannot know what the renderer attached. The DOM does
 * know — `data-phase` on the surface is the attachment's own report — so the
 * fact travels from where it is true to where it is printed.
 */
function AttachmentReporter(props: {
  readonly area: () => HTMLElement | undefined;
  readonly onChange?: (attached: boolean) => void;
}) {
  createEffect(() => {
    const element = props.area();
    if (!element || !props.onChange || typeof MutationObserver === "undefined") return;
    const report = (): void =>
      props.onChange!(element.querySelector('.terminal-surface[data-phase="connected"]') !== null);
    report();
    const observer = new MutationObserver(report);
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-phase"] });
    onCleanup(() => {
      observer.disconnect();
      props.onChange?.(false);
    });
  });
  return null;
}

export { windowTabKey };
