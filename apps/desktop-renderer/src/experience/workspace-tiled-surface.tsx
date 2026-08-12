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
 * between two panes, and the drag handles plus persistent panel header sit on
 * those reserved cells; a tile's output region stays transparent.
 */
import {
  For,
  Index,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { SemanticIconId, WorkspaceMultiplexerMutationResult } from "@tmux-ide/contracts";
import {
  INTERACTION_PRESENCE_MS,
  interactionPresenceIsFresh,
  paneInteractionPresence,
  paneInteractionRelationshipLabel,
  type PaneInteractionProjection,
} from "@tmux-ide/core";

import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { PaneStreamLayoutEvent } from "../terminal/pane-stream-transport.ts";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import { Icon, type IconArtwork } from "../ui-system/icon.tsx";
import { DOM_ICON_METADATA } from "./dom-icons.ts";
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
  planPaneLayoutTransition,
  type PaneLayoutSnapshot,
} from "./workspace-layout-transition.ts";
import {
  beginWorkspacePaneDrag,
  beginWorkspacePaneResize,
  cancelWorkspacePaneManipulation,
  commitWorkspacePaneDragPreview,
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
import {
  commitWebTiledFocus,
  createWebTiledOptimisticState,
  deriveWebTiledProjection,
  enqueueWebTiledIntent,
  settleWebTiledIntent,
  supersedeWebTiledManipulation,
} from "./workspace-tiled-optimistic.ts";

type PaneManipulationPhase =
  | "idle"
  | "resize-preview"
  | "resize-committing"
  | "dragging"
  | "drop-ready"
  | "swap-committing"
  | "rollback";
type PaneTransactionState = "idle" | "previewing" | "committing" | "settled" | "rejected";

/**
 * A mutation can be accepted by tmux before its authoritative layout frame
 * reaches the browser. Two seconds proved too short once pane streams, layout
 * events, and multiple clients shared a busy daemon: the resize succeeded but
 * the GUI announced a rollback just before the confirming frame arrived.
 */
const MANIPULATION_CONFIRM_TIMEOUT_MS = 5_000;
/** A communication stays legible without turning rapid agent traffic into noise. */
export const PANE_COMMUNICATION_HIGHLIGHT_MS = INTERACTION_PRESENCE_MS;

export function paneCommunicationCopy(
  interaction: PaneInteractionProjection,
  paneLabel: (semanticPaneId: string) => string = (semanticPaneId) => semanticPaneId,
): {
  readonly headline: string;
  readonly detail: string;
} {
  const presence = paneInteractionPresence(interaction);
  const relationship = paneInteractionRelationshipLabel(interaction, paneLabel);
  return { headline: presence.badge, detail: relationship };
}

/**
 * Return the stable pixels occupied by xterm's grid, excluding viewport
 * padding. The rows inside xterm can move with scrollback; the outer `.xterm`
 * box cannot. Before the renderer mounts, the viewport is the safe fallback.
 */
export function renderedTerminalGridRect(area: HTMLElement): DOMRect | null {
  const viewport = area.querySelector<HTMLElement>(".terminal-surface__viewport");
  const grid = viewport?.querySelector<HTMLElement>(":scope > .xterm");
  return (grid ?? viewport)?.getBoundingClientRect() ?? null;
}

/** Convert the measured grid rect into the pane area's local padding box. */
export function terminalGridOverlayBox(area: HTMLElement): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const areaRect = area.getBoundingClientRect();
  const gridRect = renderedTerminalGridRect(area);
  if (!gridRect || gridRect.width <= 0 || gridRect.height <= 0) {
    return { left: 0, top: 0, width: area.clientWidth, height: area.clientHeight };
  }
  return {
    // Absolutely positioned children use the padding box as their origin.
    left: gridRect.left - areaRect.left - area.clientLeft,
    top: gridRect.top - areaRect.top - area.clientTop,
    width: gridRect.width,
    height: gridRect.height,
  };
}

/** The row xterm actually painted, rather than the possibly stale tmux frame ratio. */
export function renderedTerminalRowHeight(area: HTMLElement): number | null {
  const row = area.querySelector<HTMLElement>(
    ".terminal-surface__viewport > .xterm .xterm-rows > div",
  );
  const height = row?.getBoundingClientRect().height ?? 0;
  return Number.isFinite(height) && height > 0 ? height : null;
}

type TiledVerbResult = void | Promise<
  | { readonly status: "ok"; readonly result?: WorkspaceMultiplexerMutationResult }
  | { readonly status: "error"; readonly error?: unknown }
>;

export interface TiledSurfaceVerbs {
  readonly workspaceConnected: boolean;
  readonly invoke: (
    verbId: "pane.select" | "pane.swap" | "pane.resize" | "pane.kill" | "window.zoom.toggle",
    semanticPaneId: string,
    args?: {
      readonly resize?: { readonly axis: "cols" | "rows"; readonly cells: number };
      readonly swapTargetSemanticPaneId?: string;
      readonly desiredZoom?: "toggle" | "zoomed" | "unzoomed";
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
  readonly paneInteractions?: Readonly<Record<string, PaneInteractionProjection>>;
  /** Latest shared receipt sequence; drives one transient destination highlight. */
  readonly interactionSequence?: number;
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
  /** This browser view's pane selection; never interpreted as shared tmux focus. */
  readonly viewPane?: string | null;
  readonly onSelectViewPane?: (semanticPaneId: string, source: "keyboard" | "mouse") => void;
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
const ROLE_ICON_ID: Readonly<Record<PaneFrameModel["pane"]["kind"], SemanticIconId>> = {
  home: "home",
  terminal: "terminals",
  files: "files",
  changes: "changes",
  missions: "missions",
  activity: "activity",
  preview: "preview",
  native: "native",
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

export function WorkspaceTiledSurface(props: WorkspaceTiledSurfaceProps) {
  const [terminalFocusRequest, setTerminalFocusRequest] = createSignal(0);
  const [highlightedInteractionSequence, setHighlightedInteractionSequence] = createSignal(0);
  const mirrorSelections = new Map<string, string>();
  let selectedMirrorPane: string | null = null;
  let communicationTimer: ReturnType<typeof setTimeout> | null = null;
  let observedInteractionSequence = 0;

  createEffect(() => {
    // Pane presence has its own revision lane. A newer unrelated receipt (for
    // example resize) must not erase a still-fresh read/send relationship.
    const sequence = Math.max(
      0,
      ...Object.values(props.paneInteractions ?? {}).map((interaction) => interaction.sequence),
    );
    if (sequence <= observedInteractionSequence) return;
    observedInteractionSequence = sequence;
    const latest = Object.values(props.paneInteractions ?? {}).find(
      (interaction) => interaction.sequence === sequence,
    );
    if (!latest || !interactionPresenceIsFresh(latest)) {
      if (communicationTimer !== null) clearTimeout(communicationTimer);
      communicationTimer = null;
      setHighlightedInteractionSequence(0);
      return;
    }
    setHighlightedInteractionSequence(sequence);
    if (communicationTimer !== null) clearTimeout(communicationTimer);
    const occurredAt = Date.parse(latest.at);
    const remainingMs = Math.max(0, PANE_COMMUNICATION_HIGHLIGHT_MS - (Date.now() - occurredAt));
    communicationTimer = setTimeout(() => {
      communicationTimer = null;
      setHighlightedInteractionSequence(0);
    }, remainingMs);
  });
  onCleanup(() => {
    if (communicationTimer !== null) clearTimeout(communicationTimer);
  });

  const updateMirrorSelection = (pane: string, selection: string): void => {
    if (selection.length === 0) mirrorSelections.delete(pane);
    else {
      mirrorSelections.set(pane, selection);
      selectedMirrorPane = pane;
    }
  };

  const copyMirrorSelection = (event: ClipboardEvent): void => {
    if (!selectedMirrorPane) return;
    const selection = mirrorSelections.get(selectedMirrorPane);
    if (!selection || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", selection);
    event.preventDefault();
  };
  let projectionRevision = 0;
  let focusTimeout: ReturnType<typeof setTimeout> | null = null;
  const [optimisticState, setOptimisticState] = createSignal(
    createWebTiledOptimisticState(props.workspaceName, props.viewPane ?? null),
  );
  const optimisticProjection = createMemo(() => deriveWebTiledProjection(optimisticState()));
  createEffect(() => {
    const generation = props.workspaceName;
    const focusPane = props.viewPane ?? null;
    if (focusTimeout !== null) clearTimeout(focusTimeout);
    focusTimeout = null;
    setOptimisticState((state) =>
      commitWebTiledFocus(state, {
        generation,
        revision: ++projectionRevision,
        focusPane,
        nowMs: performance.now(),
      }),
    );
  });
  onCleanup(() => {
    if (focusTimeout !== null) clearTimeout(focusTimeout);
  });
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
    if (fromFrames.length > 0) {
      const selectedFrame = frames().find((frame) =>
        frame.panes.some((pane) => pane.pane === optimisticProjection().focusPane),
      );
      if (!selectedFrame) return fromFrames;
      const selectedKey = windowTabKey(selectedFrame);
      return fromFrames.map((tab, index) => ({
        ...tab,
        active: frames()[index] ? windowTabKey(frames()[index]!) === selectedKey : false,
      }));
    }
    return (props.fallbackWindows ?? []).map((window) => ({
      semanticWindowId: null,
      label: window.label,
      active: optimisticProjection().focusPane
        ? window.panes.includes(optimisticProjection().focusPane!)
        : window.active,
      paneCount: window.panes.length,
      zoomed: false,
      addressPane: window.panes[0] ?? null,
    }));
  });
  const currentFrame = createMemo<LayoutFrame | null>(() => {
    const selected = optimisticProjection().focusPane;
    return (
      (selected
        ? frames().find((frame) => frame.panes.some((pane) => pane.pane === selected))
        : null) ??
      frames().find((frame) => frame.currentWindow) ??
      frames()[0] ??
      null
    );
  });
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
            // header could be hoisted into. Keep it hidden until authoritative
            // geometry confirms a real chrome row.
            headerRows: 0 as const,
            cells: { cols: 0, rows: 0 },
            rect: { left: 0, top: 0, width: 1, height: 1 },
          },
        ]
      : [];
  });
  const compositorNodes = createMemo(() => {
    const mirror = props.mirror;
    return new Map(
      mirror?.enabled && tiles().length > 1
        ? mirror.nodes.map((node) => [node.pane, node] as const)
        : [],
    );
  });
  const paneCompositorEnabled = createMemo(() => {
    const visible = tiles();
    const nodes = compositorNodes();
    // One pane already has one authoritative interactive renderer. Pane
    // streams exist here only to compose a multi-pane tmux window; using one
    // for a single pane creates two overlapping xterms with split pixel/input
    // ownership and lets the mirror intercept the live terminal's hit tests.
    return visible.length > 1 && visible.every((tile) => nodes.has(tile.pane));
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
  const iconIdFor = (semanticPaneId: string): SemanticIconId => {
    const pane = frameFor(semanticPaneId)?.pane;
    return pane?.icon ?? (pane ? ROLE_ICON_ID[pane.kind] : "terminals");
  };
  const iconFor = (semanticPaneId: string): IconArtwork =>
    DOM_ICON_METADATA[iconIdFor(semanticPaneId)].artwork;

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
  const [paintedRowHeight, setPaintedRowHeight] = createSignal<number | null>(null);

  const positionOverlay = (): void => {
    if (!overlayElement || !areaElement) return;
    /*
     * Align to xterm's stable outer GRID element, never to `.xterm-screen`.
     *
     * The screen element lives inside xterm's scroll area, so its rect can move
     * with scrollback. The outer `.xterm` box does not move, and—unlike the
     * terminal viewport—excludes the protective padding around the grid. That
     * keeps one-row pane headers exactly on tmux's separator row instead of
     * clipping the adjacent output row.
     */
    overlayStyle ??= createRuntimeStyleBinding(overlayElement);
    // Use the measured offset as well as the measured size. This preserves the
    // grid's true padding inset for an owner and its clipping/letterbox offset
    // for a passive viewer; re-centring only the dimensions loses both.
    const box = terminalGridOverlayBox(areaElement);
    setPaintedRowHeight(renderedTerminalRowHeight(areaElement));
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
    const onTerminalGridResize = (): void => positionOverlay();
    element.addEventListener("tmux-ide-terminal-grid-resized", onTerminalGridResize);
    onCleanup(() => {
      element.removeEventListener("contextmenu", onContextMenu, true);
      element.removeEventListener("tmux-ide-terminal-grid-resized", onTerminalGridResize);
    });
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionOverlay());
    observer.observe(element);
    const viewport = element.querySelector<HTMLElement>(".terminal-surface__viewport");
    if (viewport) observer.observe(viewport);

    let observedGrid: HTMLElement | null = null;
    const observeRenderedGrid = (): void => {
      const nextGrid = element.querySelector<HTMLElement>(".terminal-surface__viewport > .xterm");
      if (nextGrid !== observedGrid) {
        if (observedGrid) observer.unobserve(observedGrid);
        observedGrid = nextGrid;
        if (observedGrid) observer.observe(observedGrid);
      }
      positionOverlay();
    };
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(observeRenderedGrid);
    mutationObserver?.observe(element, { childList: true, subtree: true });
    queueMicrotask(observeRenderedGrid);
    onCleanup(() => {
      mutationObserver?.disconnect();
      observer.disconnect();
    });
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
  interface PaneTransactionSnapshot {
    readonly manipulation: WorkspacePaneManipulation | null;
    readonly localPreview: WorkspacePanePreview | null;
    readonly committingState: WorkspacePaneResize | WorkspacePaneDrag | null;
    readonly phase: PaneManipulationPhase;
    readonly state: PaneTransactionState;
  }
  const [paneTransaction, setPaneTransaction] = createSignal<PaneTransactionSnapshot>({
    manipulation: null,
    localPreview: null,
    committingState: null,
    phase: "idle",
    state: "idle",
  });
  const manipulation = () => paneTransaction().manipulation;
  const localPreview = () => paneTransaction().localPreview;
  const committingState = () => paneTransaction().committingState;
  const phase = () => paneTransaction().phase;
  const transactionState = () => paneTransaction().state;
  const setManipulation = (value: WorkspacePaneManipulation | null): void => {
    setPaneTransaction((current) => ({ ...current, manipulation: value }));
  };
  const setLocalPreview = (value: WorkspacePanePreview | null): void => {
    setPaneTransaction((current) => ({ ...current, localPreview: value }));
  };
  const setCommittingState = (value: WorkspacePaneResize | WorkspacePaneDrag | null): void => {
    setPaneTransaction((current) => ({ ...current, committingState: value }));
  };
  const setPhase = (value: PaneManipulationPhase): void => {
    setPaneTransaction((current) => ({ ...current, phase: value }));
  };
  const setTransactionState = (value: PaneTransactionState): void => {
    setPaneTransaction((current) => ({ ...current, state: value }));
  };
  const [lastConfirmedCells, setLastConfirmedCells] = createSignal<number | null>(null);
  const [endingPanes, setEndingPanes] = createSignal<ReadonlySet<string>>(new Set());
  const [lastLayoutTransition, setLastLayoutTransition] = createSignal<
    "none" | "move" | "enter" | "exit" | "mixed"
  >("none");
  const [layoutTransitionRevision, setLayoutTransitionRevision] = createSignal(0);
  let resizeWireTimer: ReturnType<typeof setTimeout> | null = null;
  let commitTimeout: ReturnType<typeof setTimeout> | null = null;
  let touchLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTouchDrag: {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
  } | null = null;
  let transactionId = 0;
  let optimisticOperationSequence = 0;
  let activeManipulationOperationId: string | null = null;

  const selectViewPane = (pane: string, source: "keyboard" | "mouse"): void => {
    if (optimisticProjection().focusPane === pane) return;
    const operationId = `web-focus-${++optimisticOperationSequence}`;
    const nowMs = performance.now();
    setOptimisticState((state) =>
      enqueueWebTiledIntent(
        state,
        operationId,
        { kind: "focus", pane },
        nowMs,
        MANIPULATION_CONFIRM_TIMEOUT_MS,
      ),
    );
    if (focusTimeout !== null) clearTimeout(focusTimeout);
    focusTimeout = setTimeout(() => {
      focusTimeout = null;
      setOptimisticState((state) => settleWebTiledIntent(state, operationId, "timed-out"));
    }, MANIPULATION_CONFIRM_TIMEOUT_MS);
    props.onSelectViewPane?.(pane, source);
  };

  const beginOptimisticManipulation = (preview: WorkspacePanePreview): void => {
    const operationId = `web-manipulation-${++optimisticOperationSequence}`;
    activeManipulationOperationId = operationId;
    const nowMs = performance.now();
    setOptimisticState((state) =>
      enqueueWebTiledIntent(
        state,
        operationId,
        { kind: "manipulation", preview },
        nowMs,
        MANIPULATION_CONFIRM_TIMEOUT_MS,
      ),
    );
  };
  const adoptAuthoritativeManipulation = (
    operationId: string,
    preview: WorkspacePanePreview,
  ): void => {
    if (!activeManipulationOperationId) return;
    const previous = activeManipulationOperationId;
    activeManipulationOperationId = operationId;
    setOptimisticState((state) =>
      supersedeWebTiledManipulation(
        state,
        previous,
        operationId,
        preview,
        performance.now(),
        MANIPULATION_CONFIRM_TIMEOUT_MS,
      ),
    );
  };
  let pendingPointerSample: WorkspacePointerSample | null = null;
  let previewAnimationFrame: number | null = null;

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
    if (previewAnimationFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(previewAnimationFrame);
    }
  });
  if (typeof window !== "undefined") {
    const onManipulationKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || phase() === "idle") return;
      event.preventDefault();
      cancelManipulation();
    };
    // xterm consumes Escape while it owns keyboard focus. Pane manipulation is
    // shell chrome, so its cancellation contract must run in capture before
    // terminal key handling can stop propagation.
    window.addEventListener("keydown", onManipulationKeyDown, { capture: true });
    const cancelInterruptedPointerGesture = (): void => {
      const currentPhase = phase();
      if (
        currentPhase === "dragging" ||
        currentPhase === "drop-ready" ||
        currentPhase === "resize-preview"
      ) {
        cancelManipulation();
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") cancelInterruptedPointerGesture();
    };
    window.addEventListener("blur", cancelInterruptedPointerGesture);
    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => {
      window.removeEventListener("keydown", onManipulationKeyDown, { capture: true });
      window.removeEventListener("blur", cancelInterruptedPointerGesture);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
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

  const settle = (rolledBack = false, expectedTransactionId = transactionId): void => {
    if (expectedTransactionId !== transactionId) return;
    clearResizeWireTimer();
    clearCommitTimeout();
    const frame = currentFrame();
    if (activeManipulationOperationId) {
      const operationId = activeManipulationOperationId;
      activeManipulationOperationId = null;
      setOptimisticState((state) =>
        settleWebTiledIntent(state, operationId, rolledBack ? "rejected" : "observed"),
      );
    }
    // One reactive publication: consumers can never observe authoritative new
    // geometry with the old preview transform still attached.
    setPaneTransaction({
      manipulation: frame
        ? createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion })
        : null,
      localPreview: null,
      committingState: null,
      phase: rolledBack ? "rollback" : "idle",
      state: rolledBack ? "rejected" : "settled",
    });
    const id = transactionId;
    if (rolledBack) {
      const settleMs = props.reducedMotion ? 0 : 150;
      commitTimeout = setTimeout(() => {
        if (id !== transactionId) return;
        commitTimeout = null;
        setPaneTransaction((current) => ({ ...current, phase: "idle", state: "idle" }));
      }, settleMs);
    } else {
      queueMicrotask(() => {
        if (id === transactionId && transactionState() === "settled") {
          setTransactionState("idle");
        }
      });
    }
  };

  const mutationFailed = (result: unknown): boolean =>
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "error";

  const closePane = (pane: string): void => {
    if (endingPanes().has(pane)) return;
    setEndingPanes((current) => new Set([...current, pane]));
    Promise.resolve(props.verbs.invoke("pane.kill", pane)).then(
      (result) => {
        if (!mutationFailed(result)) return;
        setEndingPanes((current) => {
          const next = new Set(current);
          next.delete(pane);
          return next;
        });
      },
      () => {
        setEndingPanes((current) => {
          const next = new Set(current);
          next.delete(pane);
          return next;
        });
      },
    );
  };

  const dispatchResize = (plan: PaneResizeWirePlan): void => {
    clearResizeWireTimer();
    if (plan.dispatch) {
      const { pane, axis, cells } = plan.dispatch.command;
      const issuedFor = transactionId;
      Promise.resolve(props.verbs.invoke("pane.resize", pane, { resize: { axis, cells } })).then(
        (result) => {
          if (issuedFor !== transactionId) return;
          if (mutationFailed(result)) {
            if (phase() === "resize-preview") cancelManipulation();
            else if (phase() === "resize-committing") settle(true, issuedFor);
            return;
          }
          if (
            result &&
            result.status === "ok" &&
            result.result?.verb === "workspace.pane.resize" &&
            phase() === "resize-committing"
          ) {
            const mutation = result.result;
            const pending = committingState();
            if (pending?.kind !== "resize") return;
            const actual = mutation.cells;
            const adjusted: WorkspacePaneResize = { ...pending, previewCells: actual };
            batch(() => {
              setCommittingState(adjusted);
              const preview = previewWorkspacePaneManipulation(adjusted);
              if (activeManipulationOperationId) {
                adoptAuthoritativeManipulation(mutation.operationId, preview);
              }
            });
          }
        },
        () => {
          if (issuedFor !== transactionId) return;
          if (phase() === "resize-preview") cancelManipulation();
          else if (phase() === "resize-committing") settle(true, issuedFor);
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
    transactionId += 1;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setLastConfirmedCells(started.border.cells);
    setPaneTransaction({
      manipulation: started,
      localPreview: previewWorkspacePaneManipulation(started),
      committingState: null,
      phase: "resize-preview",
      state: "previewing",
    });
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
    transactionId += 1;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setPaneTransaction({
      manipulation: started,
      localPreview: previewWorkspacePaneManipulation(started),
      committingState: null,
      phase: "dragging",
      state: "previewing",
    });
    if (event.pointerType === "touch") {
      pendingTouchDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      touchLongPressTimer = setTimeout(() => {
        touchLongPressTimer = null;
        pendingTouchDrag = null;
      }, 400);
    }
  };

  const applyPointerPreview = (sample: WorkspacePointerSample): void => {
    const state = manipulation();
    if (!state || state.kind === "idle") return;
    /*
     * Pointer feedback is renderer-local. A verified daemon mutation per sample
     * made the browser trail the TUI and caused layout/xterm work to queue behind
     * the pointer. Release emits the one durable resize command below.
     */
    const updated = updateWorkspacePaneManipulation(state, sample, {
      wireResize: false,
    });
    if (updated.ignored) return;
    setPaneTransaction((current) => ({
      ...current,
      manipulation: updated.state,
      localPreview: updated.preview,
      phase:
        updated.preview.kind === "drag"
          ? updated.preview.targetPane
            ? "drop-ready"
            : "dragging"
          : current.phase,
    }));
    dispatchResize(updated.wire);
  };

  const flushPointerPreview = (): void => {
    previewAnimationFrame = null;
    const sample = pendingPointerSample;
    pendingPointerSample = null;
    if (sample) applyPointerPreview(sample);
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
    pendingPointerSample = pointerSample(event);
    if (previewAnimationFrame !== null) return;
    if (typeof requestAnimationFrame === "function") {
      previewAnimationFrame = requestAnimationFrame(flushPointerPreview);
    } else {
      // Deterministic non-browser/test fallback.
      flushPointerPreview();
    }
  };

  const beginCommitTimeout = (id = transactionId): void => {
    clearCommitTimeout();
    commitTimeout = setTimeout(() => settle(true, id), MANIPULATION_CONFIRM_TIMEOUT_MS);
  };

  const finishManipulation = (event: PointerEvent): void => {
    const state = manipulation();
    if (!state || state.kind === "idle") return;
    clearTouchLongPress();
    if (previewAnimationFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(previewAnimationFrame);
      previewAnimationFrame = null;
    }
    pendingPointerSample = null;
    const releaseSample = pointerSample(event);
    // The release coordinate is authoritative even when no pointermove landed
    // in that frame. Preview it without adopting its wire bookkeeping; finish
    // still compares against commands that were actually dispatched.
    const released = updateWorkspacePaneManipulation(state, releaseSample, {
      wireResize: false,
    });
    const preview = released.preview;
    const finished = finishWorkspacePaneManipulation(state, releaseSample);
    if (finished.ignored || !finished.completion) return;
    clearResizeWireTimer();

    if (
      finished.completion.kind === "resize" &&
      (finished.completion.changed || finished.wire.dispatch !== null)
    ) {
      setPaneTransaction({
        manipulation: finished.state,
        localPreview: null,
        committingState: state,
        phase: "resize-committing",
        state: "committing",
      });
      // Some engines dispatch lostpointercapture synchronously. Publish the
      // committing state first so that cleanup cannot cancel/roll back a valid
      // release or race a second settlement.
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      dispatchResize(finished.wire);
      beginOptimisticManipulation(preview);
      beginCommitTimeout();
      return;
    }
    if (finished.completion.kind === "swap") {
      const releasedDrag = released.state as WorkspacePaneDrag;
      const issuedFor = transactionId;
      setPaneTransaction({
        manipulation: finished.state,
        localPreview: null,
        committingState: releasedDrag,
        phase: "swap-committing",
        state: "committing",
      });
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
      dispatchResize(finished.wire);
      beginOptimisticManipulation(commitWorkspacePaneDragPreview(releasedDrag));
      beginCommitTimeout();
      Promise.resolve(
        props.verbs.invoke("pane.swap", finished.completion.sourcePane, {
          swapTargetSemanticPaneId: finished.completion.targetPane,
        }),
      ).then(
        (result) => {
          if (mutationFailed(result)) settle(true, issuedFor);
          else if (result?.status === "ok" && result.result?.verb === "workspace.pane.swap") {
            adoptAuthoritativeManipulation(
              result.result.operationId,
              commitWorkspacePaneDragPreview(releasedDrag),
            );
          }
        },
        () => settle(true, issuedFor),
      );
      return;
    }
    settle(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    dispatchResize(finished.wire);
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
    const cancelledId = transactionId;
    setManipulation(cancelled.state);
    if (event) (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    dispatchResize(cancelled.wire);
    settle(
      cancelled.completion?.kind === "cancelled" ? cancelled.completion.rolledBack : false,
      cancelledId,
    );
  }

  createEffect(() => {
    const frame = currentFrame();
    if (!frame) return;
    const pending = committingState();
    const preview = optimisticProjection().manipulationPreview;
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

  const displayPreview = createMemo(
    () => optimisticProjection().manipulationPreview ?? localPreview(),
  );
  const resizePreview = createMemo(() => {
    const preview = displayPreview();
    return preview?.kind === "resize" ? preview : null;
  });
  const dragPreview = createMemo(() => {
    const preview = displayPreview();
    return preview?.kind === "drag" ? preview : null;
  });
  const pointerDragActive = createMemo(() => phase() === "dragging" || phase() === "drop-ready");
  const pointerResizeActive = createMemo(() => phase() === "resize-preview");
  const displayState = createMemo(() => committingState() ?? manipulation());
  const displayTiles = createMemo(() => {
    const state = displayState();
    const visible = state && state.kind !== "idle" ? state.snapshot.tiles : tiles();
    /*
     * <Index> preserves DOM nodes by position, so its input must have an
     * identity-stable order. tmux is free to restate panes in geometry order
     * after a swap; feeding that order through would make an existing tile DOM
     * node suddenly represent another pane, including its terminal renderer.
     * Canonical pane order keeps a resize/swap as a style update on the same
     * node — the same invariant tmuxy's PaneLayout enforces with stable keys.
     */
    return [...visible].sort((left, right) => left.pane.localeCompare(right.pane));
  });
  // Key the retained DOM/xterm owner by semantic pane id. Layout objects are
  // replaced on every canonical frame; using them (or array position) as the
  // keyed value can retarget an existing renderer to another pane on insert.
  const displayPaneIds = createMemo(() => displayTiles().map(({ pane }) => pane));
  const displayBorders = createMemo(() => {
    const state = displayState();
    const visible = state && state.kind !== "idle" ? state.snapshot.borders : borders();
    return [...visible].sort((left, right) => left.id.localeCompare(right.id));
  });
  const placementFor = (pane: string) =>
    displayPreview()?.placements.find((placement) => placement.pane === pane);
  const activeResize = createMemo<WorkspacePaneResize | null>(() => {
    const state = displayState();
    return state?.kind === "resize" ? state : null;
  });

  // ── Confirmed-layout FLIP transitions ───────────────────────────────────
  // Direct manipulation already owns its own frame-by-frame transforms. This
  // path runs only for idle, daemon-confirmed structural changes: split, kill
  // and tmux zoom. The previous DOM box is inverted onto the new box, then the
  // compositor removes that transform; tmux remains the only geometry owner.
  let previousLayout: readonly PaneLayoutSnapshot[] = [];
  let previousWindowKey: string | null = null;
  let layoutWasPainted = false;
  let manipulationInterruptedLayout = false;
  let layoutAnimationGeneration = 0;
  const runningLayoutAnimations = new Set<Animation>();

  const stopLayoutAnimations = (): void => {
    for (const animation of runningLayoutAnimations) animation.cancel();
    runningLayoutAnimations.clear();
  };
  onCleanup(stopLayoutAnimations);

  const paneLayoutSnapshot = (): readonly PaneLayoutSnapshot[] => {
    const overlayRect = overlayElement?.getBoundingClientRect();
    if (!overlayRect) return [];

    /*
     * Snapshot authoritative layout coordinates, never painted DOM boxes.
     *
     * `getBoundingClientRect()` includes an in-flight CSS/WAAPI transform. A
     * layout event that landed while the prior FLIP was settling therefore
     * mistook an interpolated visual box for a new tmux position and started a
     * second FLIP. This is the source of the visible swap -> revert -> swap
     * sequence. Tile fractions are the untransformed tmux geometry, so repeated
     * equivalent frames remain equivalent regardless of what the compositor is
     * currently painting.
     */
    return tiles().map((tile) => ({
      pane: tile.pane,
      title: titleFor(tile.pane),
      rect: {
        left: overlayRect.left + tile.rect.left * overlayRect.width,
        top: overlayRect.top + tile.rect.top * overlayRect.height,
        width: tile.rect.width * overlayRect.width,
        height: tile.rect.height * overlayRect.height,
      },
    }));
  };

  const paneTileElement = (pane: string): HTMLElement | undefined =>
    [...(overlayElement?.querySelectorAll<HTMLElement>(".pane-tile[data-pane]") ?? [])].find(
      (element) => element.dataset.pane === pane,
    );

  const trackAnimation = (animation: Animation): void => {
    runningLayoutAnimations.add(animation);
    animation.finished.then(
      () => runningLayoutAnimations.delete(animation),
      () => runningLayoutAnimations.delete(animation),
    );
  };

  const createExitGhost = (entry: PaneLayoutSnapshot): HTMLElement | null => {
    if (!overlayElement) return null;
    const overlayRect = overlayElement.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "pane-layout-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.left = `${entry.rect.left - overlayRect.left}px`;
    ghost.style.top = `${entry.rect.top - overlayRect.top}px`;
    ghost.style.width = `${entry.rect.width}px`;
    ghost.style.height = `${entry.rect.height}px`;
    const header = document.createElement("span");
    header.className = "pane-layout-ghost__header";
    header.textContent = entry.title;
    ghost.append(header);
    overlayElement.append(ghost);
    return ghost;
  };

  createEffect(() => {
    const signature = displayTiles()
      .map(
        (tile) =>
          `${tile.pane}:${tile.rect.left}:${tile.rect.top}:${tile.rect.width}:${tile.rect.height}`,
      )
      .join("|");
    const windowKey = currentFrame() ? windowTabKey(currentFrame()!) : null;
    const currentPhase = phase();
    void signature;
    if (currentPhase !== "idle") {
      manipulationInterruptedLayout = true;
      return;
    }
    const generation = ++layoutAnimationGeneration;
    queueMicrotask(() => {
      if (generation !== layoutAnimationGeneration) return;
      const current = paneLayoutSnapshot();
      if (!layoutWasPainted || previousWindowKey !== windowKey || manipulationInterruptedLayout) {
        previousLayout = current;
        previousWindowKey = windowKey;
        layoutWasPainted = true;
        manipulationInterruptedLayout = false;
        return;
      }
      if (props.reducedMotion) {
        previousLayout = current;
        return;
      }
      const plan = planPaneLayoutTransition(previousLayout, current);
      const transitionKinds = [
        plan.moves.length > 0 ? "move" : null,
        plan.enters.length > 0 ? "enter" : null,
        plan.exits.length > 0 ? "exit" : null,
      ].filter((kind): kind is "move" | "enter" | "exit" => kind !== null);
      if (transitionKinds.length > 0) {
        setLastLayoutTransition(transitionKinds.length === 1 ? transitionKinds[0]! : "mixed");
        setLayoutTransitionRevision((value) => value + 1);
      }
      stopLayoutAnimations();
      for (const move of plan.moves) {
        const element = paneTileElement(move.pane);
        if (!element?.animate) continue;
        trackAnimation(
          element.animate(
            [
              {
                transform: `translate3d(${move.translateX}px, ${move.translateY}px, 0) scale(${move.scaleX}, ${move.scaleY})`,
              },
              { transform: "translate3d(0, 0, 0) scale(1, 1)" },
            ],
            { duration: 200, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
          ),
        );
      }
      for (const entry of plan.enters) {
        const element = paneTileElement(entry.pane);
        if (!element?.animate) continue;
        trackAnimation(
          element.animate(
            [
              { opacity: 0, transform: "scale(0.98)" },
              { opacity: 1, transform: "scale(1)" },
            ],
            { duration: 150, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
          ),
        );
      }
      for (const entry of plan.exits) {
        const ghost = createExitGhost(entry);
        if (!ghost?.animate) {
          ghost?.remove();
          continue;
        }
        const animation = ghost.animate(
          [
            { opacity: 1, transform: "scale(1)" },
            { opacity: 0, transform: "scale(0.98)" },
          ],
          { duration: 100, easing: "cubic-bezier(0.895, 0.03, 0.685, 0.22)" },
        );
        trackAnimation(animation);
        animation.finished.then(
          () => ghost.remove(),
          () => ghost.remove(),
        );
      }
      previousLayout = current;
      previousWindowKey = windowKey;
    });
  });

  createEffect(() => {
    const live = new Set(tiles().map(({ pane }) => pane));
    if ([...endingPanes()].every((pane) => live.has(pane))) return;
    setEndingPanes((current) => new Set([...current].filter((pane) => live.has(pane))));
  });

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
    const movedDrag = moved.state;
    transactionId += 1;
    const issuedFor = transactionId;
    batch(() => {
      setManipulation(createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }));
      setCommittingState(movedDrag);
      setPhase("swap-committing");
      setTransactionState("committing");
    });
    beginOptimisticManipulation(commitWorkspacePaneDragPreview(movedDrag));
    beginCommitTimeout();
    Promise.resolve(
      props.verbs.invoke("pane.swap", sourcePane, {
        swapTargetSemanticPaneId: target.tile.pane,
      }),
    ).then(
      (result) => {
        if (mutationFailed(result)) settle(true, issuedFor);
        else if (result?.status === "ok" && result.result?.verb === "workspace.pane.swap") {
          adoptAuthoritativeManipulation(
            result.result.operationId,
            commitWorkspacePaneDragPreview(movedDrag),
          );
        }
      },
      () => settle(true, issuedFor),
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
    const movedResize = moved.state;
    const movedResizePreview = moved.preview;
    transactionId += 1;
    const issuedFor = transactionId;
    batch(() => {
      setLastConfirmedCells(border.cells);
      setManipulation(createWorkspacePaneIdle(frame, { reducedMotion: props.reducedMotion }));
      setCommittingState(movedResize);
      setPhase("resize-committing");
      setTransactionState("committing");
    });
    beginOptimisticManipulation(movedResizePreview);
    beginCommitTimeout();
    Promise.resolve(
      props.verbs.invoke("pane.resize", border.pane, {
        resize: {
          axis: border.orientation === "vertical" ? "cols" : "rows",
          cells: movedResizePreview.cells,
        },
      }),
    ).then(
      (result) => {
        if (issuedFor !== transactionId) return;
        if (mutationFailed(result)) {
          settle(true, issuedFor);
          return;
        }
        if (result && result.status === "ok" && result.result?.verb === "workspace.pane.resize") {
          const mutation = result.result;
          const pending = committingState();
          if (pending?.kind !== "resize") return;
          const adjusted: WorkspacePaneResize = {
            ...pending,
            previewCells: mutation.cells,
          };
          batch(() => {
            setCommittingState(adjusted);
            const preview = previewWorkspacePaneManipulation(adjusted);
            if (activeManipulationOperationId) {
              adoptAuthoritativeManipulation(mutation.operationId, preview);
            }
          });
        }
      },
      () => settle(true, issuedFor),
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
              data-identity-icon={tab().addressPane ? iconIdFor(tab().addressPane!) : "terminals"}
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
                if (pane && !tab().active) selectViewPane(pane, "mouse");
              }}
              onContextMenu={(event) => {
                const pane = tab().addressPane;
                if (!pane) return;
                event.preventDefault();
                props.onOpenWindowMenu?.(pane, { x: event.clientX, y: event.clientY });
              }}
            >
              <span
                class="window-tabs__icon"
                data-identity-icon={tab().addressPane ? iconIdFor(tab().addressPane!) : "terminals"}
                aria-hidden="true"
              >
                <Icon
                  icon={
                    DOM_ICON_METADATA[
                      tab().addressPane ? iconIdFor(tab().addressPane!) : "terminals"
                    ].artwork
                  }
                  size="dense"
                />
              </span>
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
        data-pane-compositor={paneCompositorEnabled()}
        data-zoomed={currentFrame()?.zoomed ?? false}
        data-focus-zone="canvas"
        data-manipulation-phase={phase()}
        data-transaction-state={transactionState()}
        data-manipulation-preview-cells={resizePreview()?.cells}
        data-last-confirmed-cells={lastConfirmedCells() ?? undefined}
        data-last-layout-transition={lastLayoutTransition()}
        data-layout-transition-revision={layoutTransitionRevision()}
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
          if (pane) selectViewPane(pane, "mouse");
        }}
        onCopy={copyMirrorSelection}
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
              focusRequest={terminalFocusRequest()}
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
          <For each={displayPaneIds()}>
            {(paneId) => {
              const tile = createMemo(() => displayTiles().find(({ pane }) => pane === paneId)!);
              const rect = createMemo(() => tile().rect);
              const placement = createMemo(() => placementFor(paneId));
              const compositorNode = createMemo(() => compositorNodes().get(paneId));
              const interaction = createMemo(() => props.paneInteractions?.[paneId] ?? null);
              const interactionPresence = createMemo(() => {
                const value = interaction();
                return value ? paneInteractionPresence(value) : null;
              });
              const communicationActive = createMemo(
                () =>
                  interaction()?.sequence === highlightedInteractionSequence() &&
                  highlightedInteractionSequence() > 0,
              );

              return (
                <div
                  class="pane-tile"
                  data-pane={paneId}
                  data-active={
                    (optimisticProjection().focusPane ??
                      tiles().find((entry) => entry.active)?.pane) === paneId
                  }
                  data-tmux-active={tile().active}
                  data-drop-target={
                    pointerDragActive() && dragPreview()?.targetPane === paneId ? "true" : undefined
                  }
                  data-elevated={placement()?.elevated ?? false}
                  data-ending={endingPanes().has(paneId) ? "true" : undefined}
                  data-identity-icon={iconIdFor(paneId)}
                  data-composed={Boolean(compositorNode())}
                  data-interaction-phase={interaction()?.phase}
                  data-interaction-sequence={interaction()?.sequence}
                  data-communication-active={communicationActive() ? "true" : undefined}
                  data-communication-direction={
                    communicationActive() ? interaction()?.direction : undefined
                  }
                  data-communication-role={
                    communicationActive() ? interactionPresence()?.role : undefined
                  }
                  data-communication-treatment={
                    communicationActive() ? interactionPresence()?.treatment : undefined
                  }
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
                    pane={paneId}
                    title={titleFor(paneId)}
                    icon={iconFor(paneId)}
                    iconId={iconIdFor(paneId)}
                    status={frameFor(paneId)?.status ?? null}
                    interaction={interaction()}
                    interactionActive={communicationActive()}
                    active={
                      (optimisticProjection().focusPane ??
                        tiles().find((entry) => entry.active)?.pane) === paneId
                    }
                    composed={Boolean(compositorNode())}
                    /*
                     * The header's share of its own tile.
                     *
                     * The tile is `pane.height + headerRows` cells tall and the
                     * header is the one separator row of it, so the header is that
                     * fraction of the box — which keeps it exactly one terminal row
                     * tall at every window size without the component ever knowing
                     * a pixel. A tile with no separator row above it reports 0 and
                     * hides the header, because borrowing a real output row would
                     * make chrome obscure terminal content.
                     */
                    heightFraction={tile().headerRows / (tile().cells.rows + tile().headerRows)}
                    paintedRowHeight={paintedRowHeight()}
                    hoisted={tile().headerRows === 1}
                    onOpenMenu={(pointer) => props.onOpenPaneMenu?.(paneId, pointer)}
                    onClose={() => closePane(paneId)}
                    onToggleZoom={() =>
                      props.verbs.invoke("window.zoom.toggle", paneId, {
                        desiredZoom: currentFrame()?.zoomed ? "unzoomed" : "zoomed",
                      })
                    }
                    dragging={pointerDragActive() && dragPreview()?.sourcePane === paneId}
                    onPointerDown={(event) => beginPaneDrag(paneId, event)}
                    onPointerMove={moveManipulation}
                    onPointerUp={finishManipulation}
                    onPointerCancel={(event) => cancelManipulation(event)}
                    onKeyboardSwap={(key) => keyboardSwap(paneId, key)}
                  />
                  <Show when={communicationActive() && interaction()}>
                    {(activeInteraction) => {
                      const copy = createMemo(() =>
                        paneCommunicationCopy(activeInteraction(), titleFor),
                      );
                      return (
                        <span
                          class="pane-tile__communication"
                          data-phase={activeInteraction().phase}
                          data-direction={activeInteraction().direction}
                          data-role={interactionPresence()?.role}
                          data-treatment={interactionPresence()?.treatment}
                          role={activeInteraction().direction === "incoming" ? "status" : undefined}
                          aria-live={
                            activeInteraction().direction === "incoming" ? "polite" : undefined
                          }
                          aria-hidden={
                            activeInteraction().direction === "outgoing" ? "true" : undefined
                          }
                        >
                          <i aria-hidden="true">
                            {interactionPresence()?.kind === "read"
                              ? "R"
                              : activeInteraction().direction === "outgoing"
                                ? "↗"
                                : "↘"}
                          </i>
                          <span>
                            <strong>{copy().headline}</strong>
                            <small>{copy().detail}</small>
                          </span>
                        </span>
                      );
                    }}
                  </Show>
                  <Show when={compositorNode()}>
                    {(node) => (
                      <div
                        class="pane-tile__body"
                        aria-label={`${titleFor(paneId)} terminal output`}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          // Selection/copy owns the pointer in terminal output.
                          // Never let it bubble into layout drag or tmux focus.
                          event.stopPropagation();
                          selectedMirrorPane = paneId;
                          selectViewPane(paneId, "mouse");
                          props.onFocusPane?.(paneId, "mouse");
                        }}
                        onPointerUp={(event) => {
                          if (event.button !== 0) return;
                          // Let xterm finish its selection transaction first,
                          // then restore input only for a click. A selection
                          // keeps visible xterm ownership through Copy.
                          queueMicrotask(() => {
                            if ((mirrorSelections.get(paneId) ?? "").length === 0) {
                              setTerminalFocusRequest((value) => value + 1);
                            }
                          });
                        }}
                      >
                        <MirrorPaneNode
                          pane={node().pane}
                          title={node().title}
                          state={node().state}
                          connection={props.mirror!.connection}
                          faultLabel={props.mirror!.faultLabel}
                          registerSink={node().registerSink}
                          onRetry={props.mirror!.onRetry}
                          reducedMotion={props.reducedMotion}
                          themeKey={props.terminalThemeKey}
                          rendererFactory={props.mirror!.rendererFactory}
                          onSelectionChange={(selection) =>
                            updateMirrorSelection(paneId, selection)
                          }
                        />
                      </div>
                    )}
                  </Show>
                  <span class="sr-only">
                    {titleFor(paneId)}
                    {(optimisticProjection().focusPane ??
                      tiles().find((entry) => entry.active)?.pane) === paneId
                      ? ", selected in this view"
                      : ""}
                    {tile().active ? ", tmux input owner" : ""}
                  </span>
                </div>
              );
            }}
          </For>
          <Index each={displayBorders()}>
            {(border) => {
              const vertical = createMemo(() => border().orientation === "vertical");
              return (
                <div
                  class="pane-border"
                  data-pane-border={border().id}
                  data-orientation={border().orientation}
                  data-dragging={
                    pointerResizeActive() &&
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
                    /*
                     * Match tmuxy's edge geometry: a fixed 8px grab band, not
                     * the whole separator cell. A horizontal separator cell is
                     * also the lower pane's header row; consuming all of it made
                     * that header resize instead of drag. The band straddles the
                     * real edge and leaves the rest of the chrome available.
                     */
                    left: vertical()
                      ? `calc(${percent(border().rect.left + border().rect.width / 2)} - 4px)`
                      : percent(border().rect.left),
                    top: vertical()
                      ? percent(border().rect.top)
                      : `calc(${percent(border().rect.top)} - 4px)`,
                    width: vertical() ? "8px" : percent(border().rect.width),
                    height: vertical() ? percent(border().rect.height) : "8px",
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
                    const isVertical = vertical();
                    const decrease =
                      (isVertical && event.key === "ArrowLeft") ||
                      (!isVertical && event.key === "ArrowUp");
                    const increase =
                      (isVertical && event.key === "ArrowRight") ||
                      (!isVertical && event.key === "ArrowDown");
                    if (!decrease && !increase) return;
                    event.preventDefault();
                    keyboardResize(border(), increase ? 1 : -1);
                  }}
                />
              );
            }}
          </Index>
          <Show when={pointerDragActive() && dragPreview()?.dropRect}>
            <div
              class="pane-drop-ghost"
              aria-hidden="true"
              style={{
                left: percent(dragPreview()!.dropRect!.left),
                top: percent(dragPreview()!.dropRect!.top),
                width: percent(dragPreview()!.dropRect!.width),
                height: percent(dragPreview()!.dropRect!.height),
              }}
            >
              <span class="pane-drop-ghost__label">
                Swap with {titleFor(dragPreview()!.targetPane!)}
              </span>
            </div>
          </Show>
          <Show when={pointerResizeActive() && activeResize() && resizePreview()}>
            <div
              class="pane-resize-hud-anchor"
              data-orientation={activeResize()!.border.orientation}
              aria-hidden="true"
              style={{
                left: percent(
                  activeResize()!.border.orientation === "vertical"
                    ? activeResize()!.border.rect.left
                    : activeResize()!.border.rect.left + activeResize()!.border.rect.width / 2,
                ),
                top: percent(
                  activeResize()!.border.orientation === "horizontal"
                    ? activeResize()!.border.rect.top
                    : activeResize()!.border.rect.top + activeResize()!.border.rect.height / 2,
                ),
                transform: `translate3d(${resizePreview()!.guideTransform.translateX}px, ${resizePreview()!.guideTransform.translateY}px, 0)`,
              }}
            >
              <output class="pane-resize-hud">
                {resizePreview()!.cells} {resizePreview()!.axis === "cols" ? "cols" : "rows"}
                <span>
                  {resizePreview()!.movedCells >= 0 ? "+" : ""}
                  {resizePreview()!.movedCells}
                </span>
              </output>
            </div>
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
  readonly iconId: SemanticIconId;
  readonly status: PaneFrameModel["status"] | null;
  readonly interaction: PaneInteractionProjection | null;
  readonly interactionActive: boolean;
  readonly active: boolean;
  /** Header owns a flex row; false means it still overlays tmux's separator. */
  readonly composed: boolean;
  readonly heightFraction: number;
  /** Measured xterm cell height; frame-derived fraction is bootstrap fallback only. */
  readonly paintedRowHeight: number | null;
  readonly hoisted: boolean;
  readonly dragging: boolean;
  readonly onPointerDown: (event: PointerEvent) => void;
  readonly onPointerMove: (event: PointerEvent) => void;
  readonly onPointerUp: (event: PointerEvent) => void;
  readonly onPointerCancel: (event: PointerEvent) => void;
  readonly onKeyboardSwap: (key: string) => void;
  readonly onToggleZoom: () => void;
  readonly onOpenMenu: (pointer: { readonly x: number; readonly y: number }) => void;
  readonly onClose: () => void;
}) {
  const [armed, setArmed] = createSignal(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPrimaryPointerDownAt = Number.NEGATIVE_INFINITY;

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
      data-interaction-phase={props.interactionActive ? props.interaction?.phase : undefined}
      aria-hidden={!props.hoisted}
      style={
        props.hoisted
          ? props.composed
            ? {
                top: "0",
                height: percent(props.heightFraction),
              }
            : {
                // Keep the composited chrome one CSS pixel inside tmux's
                // separator row. Glyph antialiasing can extend to the final
                // device pixel of the preceding content row; painting from the
                // exact boundary made that last pixel look clipped at HiDPI.
                top: "1px",
                height:
                  props.paintedRowHeight === null
                    ? `calc(${percent(props.heightFraction)} - 1px)`
                    : `calc(${props.paintedRowHeight}px - 1px)`,
              }
          : undefined
      }
      onPointerLeave={disarm}
      onPointerDown={(event) => {
        const now = event.timeStamp || performance.now();
        const doubleClick =
          event.pointerType !== "touch" &&
          event.button === 0 &&
          now - lastPrimaryPointerDownAt <= 320;
        lastPrimaryPointerDownAt = doubleClick ? Number.NEGATIVE_INFINITY : now;
        if (!doubleClick) {
          props.onPointerDown(event);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        props.onToggleZoom();
      }}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onLostPointerCapture={props.onPointerCancel}
    >
      <span class="pane-tile__icon-badge" data-identity-icon={props.iconId} aria-hidden="true">
        <Icon class="pane-tile__icon" icon={props.icon} size="dense" />
      </span>
      <span
        class="pane-tile__title"
        data-pane-drag-handle={props.pane}
        data-dragging={props.dragging}
        role="button"
        tabIndex={props.hoisted ? 0 : -1}
        aria-label={`Drag ${props.title} to swap panes; double-click to zoom; use Alt plus an arrow key with the keyboard`}
        aria-pressed={props.dragging}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
        title={`Drag to swap ${props.title}; double-click to zoom; keyboard: Alt+Arrow`}
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
      <Show
        when={props.interactionActive ? props.interaction : null}
        fallback={
          <Show when={props.status}>
            {(status) => (
              <span
                class="pane-tile__status"
                data-tone={status().tone}
                title={status().description ?? status().label}
              >
                <i aria-hidden="true" />
                <span>{status().label}</span>
              </span>
            )}
          </Show>
        }
      >
        {(interaction) => (
          <span
            class="pane-tile__interaction"
            data-phase={interaction().phase}
            data-role={paneInteractionPresence(interaction()).role}
            data-treatment={paneInteractionPresence(interaction()).treatment}
            title={interaction().label}
            aria-label={interaction().label}
          >
            <i aria-hidden="true" />
            <span>{paneInteractionPresence(interaction()).badge}</span>
          </span>
        )}
      </Show>
      <button
        type="button"
        disabled={!props.hoisted}
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
        disabled={!props.hoisted}
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
