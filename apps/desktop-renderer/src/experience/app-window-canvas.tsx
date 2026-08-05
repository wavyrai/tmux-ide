import {
  resolvePaneAppearance,
  type AgentGraphOverlay,
  type AppWindowDocumentV1,
  type ApplicationShellTerminalInventory,
  multiplexerVerb,
  type MultiplexerVerbFacts,
  type MultiplexerVerbId,
  type PaneAppearance,
  type WorkspaceMultiplexerHostResult,
} from "@tmux-ide/contracts";
import {
  For,
  Show,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
} from "solid-js";

// Pane chrome CSS is already imported by the renderer's external stylesheet.
// Importing the styled entry would make Vite inject a CSP-blocked <style> tag.
import {
  ArrowExpandIcon,
  MinusSignIcon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";

import { Icon, type IconArtwork } from "../ui-system/icon.tsx";
import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host-unstyled.tsx";
import type {
  PaneFrameAction,
  PaneFrameModel,
} from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { stableAppWindowInstanceId } from "../../../../packages/daemon/src/lib/app-window-state.ts";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { TerminalRendererFactory } from "../terminal/xterm-renderer.ts";
import { MirrorPaneNode } from "../terminal/mirror-pane-node.tsx";
import type { MirrorPaneNodeState, MirrorPaneSink } from "../terminal/pane-mirror-controller.ts";
import type { MirrorTerminalRendererFactory } from "../terminal/mirror-xterm-renderer.ts";
import {
  statusStripFromConnectionHealth,
  type DesktopConnectionHealth,
} from "../runtime/connection-health.ts";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import {
  beginCanvasMove,
  beginCanvasResize,
  cancelCanvasPointerTransaction,
  commitCanvasPointerTransaction,
  updateCanvasPointerTransaction,
  type CanvasPointerTransaction,
} from "./canvas-pointer-transaction.ts";
import {
  fitCanvasViewport,
  panCanvasViewport,
  screenToCanvas,
  zoomCanvasViewportAt,
  type CanvasViewportTransform,
  type CanvasResizeEdge,
} from "./canvas-interaction-geometry.ts";
import {
  canvasOwnsWheel,
  routeCanvasPointer,
  type CanvasPointerRegion,
} from "./canvas-input-routing.ts";
import {
  canvasViewportKeyboardCommand,
  canvasWheelTransform,
  keyboardCanvasViewportTransform,
} from "./canvas-viewport-input.ts";
import { DomIcon } from "./dom-icon.tsx";
import {
  appWindowFocusInvocation,
  projectAppWindowCanvas,
  type AppWindowCanvasCommandInvocation,
  type AppWindowCanvasItem,
  type AppWindowCanvasViewport,
} from "./app-window-canvas-presenter.ts";
import {
  dockAppWindowIntent,
  floatAppWindowIntent,
  toggleAppWindowMaximizeIntent,
} from "./canvas-interaction-intents.ts";
import {
  agentGraphMinimapPanTransform,
  projectAgentGraphMinimap,
  projectAgentGraphScene,
  type AgentGraphMinimap,
  type AgentGraphScene,
  type AgentGraphSceneRect,
} from "./agent-graph-canvas-geometry.ts";
import {
  APP_LAYOUT_MENU_IDS,
  canvasMenuSections,
  stackIdFromDockIntoMenuId,
  verbMenuItem,
  windowCardMenuSections,
  type DockStackTarget,
} from "./multiplexer-verb-menu.ts";
import { ContextMenu, type ContextMenuSection } from "../ui-system/index.ts";
import type { MultiplexerVerbArguments, MultiplexerVerbTarget } from "./multiplexer-verb-access.ts";

/** One read-only mirror pane node placed on the canvas (m43 card 3). */
export interface AppWindowMirrorNodeModel {
  /** Semantic pane identity; equals the terminal source id of its resource. */
  readonly pane: string;
  readonly title: string;
  /** The pane's source chrome (agent-status glyph) when its resource is known. */
  readonly frame: PaneFrameModel | null;
  readonly state: MirrorPaneNodeState;
  readonly registerSink: (sink: MirrorPaneSink) => () => void;
}

export interface AppWindowCanvasMirrorProps {
  readonly enabled: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly nodes: readonly AppWindowMirrorNodeModel[];
  /** Stream-level derived connection health (the m42 vocabulary, reused). */
  readonly connection: DesktopConnectionHealth;
  /**
   * What the stream fault was, in words, when the issue vocabulary named a
   * cause the connection health cannot carry (a conflicting interactive viewer,
   * a degraded engine). Null when there is no fault or none this build knows.
   */
  readonly faultLabel?: string | null;
  readonly onRetry: () => void;
  readonly rendererFactory?: MirrorTerminalRendererFactory;
}

/**
 * What the canvas needs to offer multiplexer verbs on its cards and its ground.
 *
 * The canvas does not own the accessor, the workspace name, or the create
 * flows — the shell does. It owns the pointer, which is the only reason any of
 * this arrives here. Absent = the canvas renders exactly as it did before m49.2:
 * no context menus, an inert Close button, and a header double-tap that frames
 * the window instead of zooming it.
 */
export interface AppWindowCanvasVerbSurface {
  readonly workspaceConnected: boolean;
  /** Windows in this tmux session, as the terminal inventory reports them. */
  readonly sessionWindowCount: number;
  readonly invoke: (
    verbId: MultiplexerVerbId,
    target: MultiplexerVerbTarget,
    args?: MultiplexerVerbArguments,
  ) => Promise<WorkspaceMultiplexerHostResult>;
  /** Open the app's create-window flow. Absent = the verb is offered, refused. */
  readonly onCreateWindow?: () => void;
  readonly onCreateSession?: () => void;
  readonly onDetachSession?: () => void;
}

export interface AppWindowCanvasProps {
  readonly document: AppWindowDocumentV1;
  readonly paneFrames: readonly PaneFrameModel[];
  readonly terminalInventory?: ApplicationShellTerminalInventory;
  readonly workspaceName: string;
  readonly transport?: NativeTerminalTransport | null;
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  readonly rendererFactory?: TerminalRendererFactory;
  readonly viewport?: AppWindowCanvasViewport;
  /** True only when the host can durably execute AppWindow commands. */
  readonly mutationsAvailable?: boolean;
  readonly mutationUnavailableReason?: string;
  readonly onCommand?: (invocation: AppWindowCanvasCommandInvocation) => void | Promise<void>;
  /**
   * The runtime agent-graph overlay. This is a NON-DURABLE projection of the
   * live fleet — directed spawn/mission edges, labeled mission groups, and a
   * ground-truth status glyph per window — keyed by the same durable window ids
   * as {@link document}. It is an OPTIONAL seam: when absent the canvas renders
   * exactly as it does without any graph awareness (no edge/group layer, no
   * minimap, no attention chrome). The live integration feeds it later; nothing
   * here reads or writes daemon state. Overlay entries whose windowId has no
   * projected rect degrade silently (they are skipped, never thrown).
   */
  readonly overlay?: AgentGraphOverlay;
  /**
   * True when the fleet context could not be fully composed into {@link overlay}
   * — an over-cap fleet is dropped wholesale rather than half-rendered (see
   * `fleet-graph-merge.ts`). The canvas surfaces a quiet indicator so the picture
   * reads as intentionally partial, never silently wrong.
   */
  readonly overlayTruncated?: boolean;
  /**
   * Dev-facing mirror-panes affordance (m43 card 3): read-only pane nodes
   * driven by one pane-stream lease, rendered inside the same pan/zoom scene
   * as the window cards. Absent = the canvas renders exactly as before.
   * Mirror nodes are presentation-only this card: they never join the durable
   * document, never vote on size, and never dispatch AppWindow commands.
   */
  readonly mirror?: AppWindowCanvasMirrorProps;
  /** Multiplexer verbs on the cards and on bare canvas (m49.2). */
  readonly verbs?: AppWindowCanvasVerbSurface;
}

/** One placed mirror node: its model, its durable node identity, its rect. */
interface MirrorSceneEntry {
  readonly node: AppWindowMirrorNodeModel;
  readonly nodeId: string;
  readonly rect: AppWindowCanvasItem["rect"];
}

const MIRROR_NODE_SIZE = { width: 480, height: 320 } as const;
const MIRROR_NODE_GAP = 24;
const MIRROR_NODE_COLUMNS = 3;

/**
 * Bottom band of the canvas the mirror deck must stay out of: the controls pill
 * (38px tall, 16px above the edge) plus the mirror status chip above it. Nodes
 * that end above this line can never be obscured by either.
 */
const MIRROR_SAFE_INSET_BOTTOM = 96;
/** The deck shrinks to fit the visible canvas, but never past legibility. */
const MIRROR_NODE_MIN_SCALE = 0.5;
/**
 * Mirror cards sit ABOVE the window cards and below the canvas chrome (the
 * controls pill is 200). Keeping the deck on screen means it can land over a
 * durable card, and a mirror the user explicitly toggled on has to be the thing
 * they can read while it is on — it is a temporary inspection layer, gone the
 * moment the toggle flips back.
 */
const MIRROR_CARD_Z_INDEX = 150;

/**
 * PURE — deterministic grid rects for mirror nodes.
 *
 * The deck is placed below every durable window so the dev affordance never
 * covers real cards, and then pulled back INTO the visible canvas: a node the
 * user cannot see is not a mirror. Given a viewport the layout also shrinks the
 * node size (uniformly, so the letterboxed body keeps its aspect) until a row
 * fits between the top of the canvas and the controls pill. A deck too tall to
 * fit entirely starts at the top and extends below — its first row is always on
 * screen, the rest is one pan away.
 *
 * Rects are scene coordinates measured against the UNTRANSFORMED viewport, so
 * they are stable under pan/zoom (mirror cards move with the scene like every
 * other card) and correct at the default 1:1 view.
 *
 * Exported for tests.
 */
export function mirrorNodeRects(
  count: number,
  existing: readonly AppWindowCanvasItem["rect"][],
  viewport?: AppWindowCanvasViewport,
): AppWindowCanvasItem["rect"][] {
  let belowWindowsY = 0;
  for (const rect of existing) {
    belowWindowsY = Math.max(belowWindowsY, rect.y + rect.height);
  }
  belowWindowsY += existing.length > 0 ? 2 * MIRROR_NODE_GAP : 0;

  const visible = viewport
    ? {
        width: Math.max(0, viewport.width),
        height: Math.max(0, viewport.height - MIRROR_SAFE_INSET_BOTTOM),
      }
    : null;

  const deckAt = (
    scale: number,
  ): { width: number; height: number; columns: number; deckHeight: number } => {
    const width = Math.round(MIRROR_NODE_SIZE.width * scale);
    const height = Math.round(MIRROR_NODE_SIZE.height * scale);
    const columns = visible
      ? Math.min(
          MIRROR_NODE_COLUMNS,
          Math.max(1, Math.floor((visible.width + MIRROR_NODE_GAP) / (width + MIRROR_NODE_GAP))),
        )
      : MIRROR_NODE_COLUMNS;
    const rows = Math.max(1, Math.ceil(count / columns));
    return { width, height, columns, deckHeight: rows * height + (rows - 1) * MIRROR_NODE_GAP };
  };

  // Largest scale at which the WHOLE deck fits the visible canvas, searched in
  // fixed 5% steps so the layout stays deterministic and easy to reason about.
  // Below the legibility floor the deck stops shrinking and simply extends past
  // the fold — its first row is still placed on screen.
  let deck = deckAt(1);
  if (visible && visible.width > 0 && visible.height > 0) {
    for (let scale = 1; scale >= MIRROR_NODE_MIN_SCALE - 1e-9; scale -= 0.05) {
      deck = deckAt(Math.max(MIRROR_NODE_MIN_SCALE, scale));
      if (deck.deckHeight <= visible.height && deck.width <= visible.width) break;
    }
  }
  const { width, height, columns, deckHeight } = deck;
  const originY = visible
    ? Math.max(0, Math.min(belowWindowsY, visible.height - deckHeight))
    : belowWindowsY;

  const rects: AppWindowCanvasItem["rect"][] = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    rects.push({
      x: column * (width + MIRROR_NODE_GAP),
      y: originY + row * (height + MIRROR_NODE_GAP),
      width,
      height,
    });
  }
  return rects;
}

const CANVAS_SCALE_RANGE = { min: 0.35, max: 2.4 } as const;
const DEFAULT_CANVAS_TRANSFORM: CanvasViewportTransform = { x: 0, y: 0, scale: 1 };
/** Duration of the zoom-to-node framing transition (skipped under reduced motion). */
const VIEWPORT_ANIMATION_MS = 260;
/** How close two header taps must fall to count as a zoom-to-node double-tap. */
const HEADER_DOUBLE_TAP_MS = 400;
const MINIMAP_SIZE = { width: 168, height: 108 } as const;
const MINIMAP_PADDING = 6;

export const APP_WINDOW_CANVAS_ACTION_IDS = Object.freeze({
  placement: "app-window-placement",
  maximize: "app-window-maximize",
  close: "app-window-close",
} as const);

/** Which surface a pointer-anchored menu was opened on. */
type CanvasContextMenu =
  | {
      readonly kind: "window";
      readonly windowId: string;
      readonly pointer: { readonly x: number; readonly y: number };
    }
  | { readonly kind: "canvas"; readonly pointer: { readonly x: number; readonly y: number } };

/**
 * A card that has just been killed.
 *
 * Cheap on purpose: it is the last known title and rect, held for a beat so a
 * destroyed window is seen to END rather than to vanish between frames. It is
 * not a persistent record — nothing survives a reload, and the daemon's own
 * refresh is still what removes the real card.
 */
interface CanvasTombstone {
  readonly title: string;
  readonly rect: AppWindowCanvasItem["rect"];
}

/** How long a killed card's "ended" marker stays on the canvas. */
const TOMBSTONE_MS = 2_400;
/** How long a refused verb's message stays on screen. */
const VERB_ERROR_MS = 8_000;

interface LocalMaximizedWindow {
  readonly restoreRect: AppWindowCanvasItem["rect"];
  readonly maximizedRect: AppWindowCanvasItem["rect"];
  readonly observedRevision: number;
}

function unavailableReason(commandsAvailable: boolean, reason?: string): string | null {
  return commandsAvailable ? null : (reason ?? "Window mutations are unavailable in this host");
}

/**
 * The card's chrome buttons.
 *
 * Two of the three arrange the app's canvas and never reach tmux, so they say
 * so — "Float (app layout)" is the m48 gap-1 divergence stated on the control
 * that causes it, rather than left for the user to discover over ssh. The third
 * closes the tmux window and is the one that had been permanently disabled.
 */
export function appWindowCanvasActions(input: {
  readonly placement: AppWindowCanvasItem["placement"];
  readonly maximized: boolean;
  readonly commandsAvailable: boolean;
  readonly unavailableReason?: string;
  /** Null when the window can be killed; the refusal sentence otherwise. */
  readonly closeDisabledReason?: string | null;
  /** True while the Close button is holding a pending confirm. */
  readonly closeConfirming?: boolean;
}): readonly PaneFrameAction[] {
  const mutationUnavailable = unavailableReason(input.commandsAvailable, input.unavailableReason);
  const docked = input.placement === "docked";
  const closeReason = input.closeDisabledReason ?? null;
  const confirming = input.closeConfirming === true;
  return [
    {
      id: APP_WINDOW_CANVAS_ACTION_IDS.placement,
      commandId: docked ? "workspace.window.float" : "workspace.window.dock",
      behavior: "action",
      icon: docked ? "float" : "dock",
      label: docked ? "Float (app layout)" : "Dock (app layout)",
      description: docked
        ? "Float this window on the canvas. App layout only — the tmux layout is unchanged."
        : "Dock this window. App layout only — the tmux layout is unchanged.",
      available: mutationUnavailable === null,
      disabledReason: mutationUnavailable,
      pressed: false,
      busy: false,
    },
    {
      id: APP_WINDOW_CANVAS_ACTION_IDS.maximize,
      commandId: "workspace.window.maximize.toggle",
      behavior: "toggle",
      icon: input.maximized ? "restore" : "maximize",
      label: input.maximized ? "Restore card (app layout)" : "Maximize card (app layout)",
      description: input.maximized
        ? "Restore the floating card. This is the card's size, not tmux's pane zoom."
        : "Maximize the floating card. This is the card's size, not tmux's pane zoom.",
      available: mutationUnavailable === null && !docked,
      disabledReason:
        mutationUnavailable ?? (docked ? "Float this window before maximizing" : null),
      pressed: input.maximized,
      busy: false,
    },
    {
      id: APP_WINDOW_CANVAS_ACTION_IDS.close,
      commandId: "workspace.window.close",
      behavior: "action",
      icon: "close",
      label: confirming ? "Confirm close" : "Close",
      description: confirming
        ? "Click again to kill this tmux window and every process in it. This cannot be undone."
        : "Kill this tmux window and every process in it",
      available: closeReason === null,
      disabledReason: closeReason,
      pressed: false,
      busy: false,
      attention: confirming,
    },
  ];
}

type CanvasControlIconId = "zoom-in" | "zoom-out" | "fit" | "reset";

/** The canvas pill's verbs, drawn from the same library as every other glyph. */
const CANVAS_CONTROL_ARTWORK: Readonly<Record<CanvasControlIconId, IconArtwork>> = {
  "zoom-in": PlusSignIcon,
  "zoom-out": MinusSignIcon,
  fit: ArrowExpandIcon,
  reset: RefreshIcon,
};

function CanvasControlIcon(props: { readonly id: CanvasControlIconId }): JSX.Element {
  return (
    <Icon
      icon={CANVAS_CONTROL_ARTWORK[props.id]}
      class="canvas-controls__icon"
      data-icon={props.id}
    />
  );
}

function sceneAppearance(
  base: PaneAppearance,
  window: AppWindowCanvasItem,
  maximized: boolean,
): PaneAppearance {
  return resolvePaneAppearance({
    structure: maximized ? "maximized" : window.placement,
    applicationFocus: {
      pane: window.selected,
      terminalInput: window.selected,
      windowActive: base.header.windowActive,
    },
    agentActivity: base.header.agentActivity,
    domainStatus: base.status.domainStatus,
    attention: base.status.attention,
    layoutInteraction: {
      editable: true,
      selected: window.selected,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: base.action.disabled,
      loading: base.action.loading,
    },
  });
}

function windowFrameModel(
  window: AppWindowCanvasItem,
  source: PaneFrameModel,
  options: {
    readonly maximized: boolean;
    readonly commandsAvailable: boolean;
    readonly unavailableReason?: string;
    readonly closeDisabledReason?: string | null;
    readonly closeConfirming?: boolean;
  },
): PaneFrameModel {
  const paneId = window.windowId;
  return {
    ...source,
    pane: { ...source.pane, id: paneId },
    title: window.title ?? source.title,
    appearance: sceneAppearance(source.appearance, window, options.maximized),
    status: source.status ? { ...source.status, id: `${paneId}.status` } : null,
    chips: source.chips.map((chip, index) => ({
      ...chip,
      id: `${paneId}.chip.${index}`,
    })),
    actions: appWindowCanvasActions({
      placement: window.placement,
      maximized: options.maximized,
      commandsAvailable: options.commandsAvailable,
      unavailableReason: options.unavailableReason,
      closeDisabledReason: options.closeDisabledReason,
      closeConfirming: options.closeConfirming,
    }),
  };
}

/**
 * Chrome for a mirror node: the pane's own frame (agent-status glyph intact)
 * with node-scoped identity, a read-only mode chip, and NO actions — mirror
 * nodes issue no window mutations this card.
 */
function mirrorNodeFrameModel(node: AppWindowMirrorNodeModel, nodeId: string): PaneFrameModel {
  const base: PaneFrameModel =
    node.frame ??
    ({
      pane: { id: nodeId, kind: "terminal" },
      appearance: resolvePaneAppearance({
        structure: "floating",
        applicationFocus: { pane: false, terminalInput: false, windowActive: true },
        agentActivity: "waiting",
        domainStatus: "idle",
        attention: "none",
        layoutInteraction: {
          editable: false,
          selected: false,
          dragging: false,
          resizing: false,
          previewing: false,
        },
        controlInteraction: {
          hover: false,
          focusVisible: false,
          pressed: false,
          disabled: false,
          loading: false,
        },
      }),
      title: node.title,
      subtitle: null,
      status: null,
      chips: [],
      actions: [],
    } satisfies PaneFrameModel);
  return {
    ...base,
    pane: { ...base.pane, id: nodeId },
    title: node.title,
    status: base.status ? { ...base.status, id: `${nodeId}.status` } : null,
    chips: [
      ...base.chips.map((chip, index) => ({ ...chip, id: `${nodeId}.chip.${index}` })),
      {
        id: `${nodeId}.chip.read-only`,
        kind: "mode" as const,
        label: "read-only",
        description: "Mirror nodes observe the pane; input arrives in a later card.",
        tone: null,
      },
    ],
    actions: [],
  };
}

function measuredViewport(element: HTMLElement): AppWindowCanvasViewport {
  const bounds = element.getBoundingClientRect();
  return {
    // App-window coordinates are relative to the canvas content box. Using the
    // border-box bounds makes the far maximize inset smaller by the border width.
    width: Math.max(0, Math.round(element.clientWidth || bounds.width)),
    height: Math.max(0, Math.round(element.clientHeight || bounds.height)),
  };
}

interface AppWindowCanvasRecord {
  readonly windowId: string;
  readonly value: Accessor<AppWindowCanvasItem>;
  readonly update: (next: AppWindowCanvasItem) => void;
}

/** Preserve mounted terminal components while their projected geometry changes. */
function createAppWindowRecords(
  source: Accessor<readonly AppWindowCanvasItem[]>,
): Accessor<readonly AppWindowCanvasRecord[]> {
  const [records, setRecords] = createSignal<readonly AppWindowCanvasRecord[]>([]);
  let available = new Map<string, AppWindowCanvasRecord>();
  createComputed(() => {
    const next = source().map((window) => {
      const current = available.get(window.windowId);
      if (current) {
        current.update(window);
        return current;
      }
      const [value, setValue] = createSignal(window, { equals: false });
      return {
        windowId: window.windowId,
        value,
        update: (item: AppWindowCanvasItem) => setValue(() => item),
      };
    });
    available = new Map(next.map((record) => [record.windowId, record]));
    setRecords(next);
  });
  onCleanup(() => available.clear());
  return records;
}

/**
 * App-owned scene host. tmux supplies bytes; it never owns this geometry.
 *
 * When {@link AppWindowCanvasProps.overlay} is present the scene also paints, in
 * layers UNDER the window cards and inside the same pan/zoom transform, an SVG
 * edge layer (directed spawn/mission connectors) and a group-frame layer
 * (labeled mission boxes). A minimap corner overlay and a blocked-attention
 * treatment on window chrome complete the graph presentation. All of it derives
 * from the same reactive window rects the cards use, so it tracks live drags and
 * zoom, and it is skipped entirely when no overlay is supplied.
 */
export function AppWindowCanvas(props: AppWindowCanvasProps) {
  const [measured, setMeasured] = createSignal<AppWindowCanvasViewport>(
    props.viewport ?? { width: 1_000, height: 640 },
  );
  let canvas: HTMLDivElement | undefined;
  let sceneRuntimeStyle: RuntimeStyleBinding | null = null;
  let canvasRuntimeStyle: RuntimeStyleBinding | null = null;
  let pointerTransaction: CanvasPointerTransaction | null = null;
  let nextMutationToken = 0;
  let panTransaction: {
    readonly pointerId: number;
    readonly origin: { readonly x: number; readonly y: number };
    readonly transform: CanvasViewportTransform;
  } | null = null;
  const [spaceKey, setSpaceKey] = createSignal(false);
  const [transform, setTransform] = createSignal<CanvasViewportTransform>(DEFAULT_CANVAS_TRANSFORM);
  const [viewportAnimating, setViewportAnimating] = createSignal(false);
  let viewportAnimationTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHeaderTap: { readonly windowId: string; readonly time: number } | null = null;
  const [rectOverrides, setRectOverrides] = createSignal(
    new Map<
      string,
      {
        readonly rect: AppWindowCanvasItem["rect"];
        readonly revision: number | null;
        readonly mutationToken?: number;
      }
    >(),
    { equals: false },
  );
  const [maximizeStates, setMaximizeStates] = createSignal(
    new Map<string, LocalMaximizedWindow>(),
    { equals: false },
  );
  const [contextMenu, setContextMenu] = createSignal<CanvasContextMenu | null>(null);
  /**
   * The open inline rename.
   *
   * It carries the TARGET it was opened against, not just a window id to look
   * up later. The AppWindow document is rebuilt as panes come and go, so a
   * commit that re-resolved the id could find nothing and abandon the user's
   * typing without a word — which is what a rename must never do.
   */
  const [renaming, setRenaming] = createSignal<{
    readonly windowId: string;
    readonly initial: string;
    /**
     * What has been typed so far, held HERE rather than only in the field.
     *
     * The canvas rebuilds a card when its terminal resource churns, which
     * replaces the editor's input element mid-edit. With the text in the DOM
     * alone that silently discards what the user typed and commits the old name
     * instead; held in state, the remounted field comes back with the edit
     * intact and Enter commits what is on screen.
     */
    readonly value: string;
    readonly target: MultiplexerVerbTarget;
  } | null>(null);
  const [closeConfirmId, setCloseConfirmId] = createSignal<string | null>(null);
  const [verbError, setVerbError] = createSignal<string | null>(null);
  let verbErrorTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => {
    if (verbErrorTimer !== null) clearTimeout(verbErrorTimer);
  });
  const [tombstones, setTombstones] = createSignal(new Map<string, CanvasTombstone>(), {
    equals: false,
  });
  const tombstoneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const timer of tombstoneTimers.values()) clearTimeout(timer);
    tombstoneTimers.clear();
  });
  onCleanup(() => {
    sceneRuntimeStyle?.dispose();
    canvasRuntimeStyle?.dispose();
    if (viewportAnimationTimer !== null) clearTimeout(viewportAnimationTimer);
  });

  const eventTargetsTerminalInput = (event: Event): boolean => {
    const target = event.target;
    return (
      target instanceof Element &&
      Boolean(target.closest(".terminal-surface, input, textarea, select, [contenteditable=true]"))
    );
  };

  onMount(() => {
    if (!canvas || props.viewport) return;
    const update = () => canvas && setMeasured(measuredViewport(canvas));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (pointerTransaction || panTransaction)) {
        event.preventDefault();
        cancelActivePointer();
        return;
      }
      if (event.code !== "Space" || event.repeat || eventTargetsTerminalInput(event)) return;
      setSpaceKey(true);
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceKey(false);
    };
    const blur = () => setSpaceKey(false);
    document.addEventListener("keydown", keydown);
    document.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
    });
  });

  const viewport = createMemo(() => props.viewport ?? measured());
  // Panes of one durable tmux window share a `windowResourceId` (m41 attach-5).
  // Feeding that grouping to the presenter coalesces them into ONE card.
  const windowGroupBySourceId = createMemo(() => {
    const map = new Map<string, string>();
    for (const resource of props.terminalInventory?.resources ?? []) {
      if (resource.windowResourceId) map.set(resource.id, resource.windowResourceId);
    }
    return map;
  });
  const projection = createMemo(() =>
    projectAppWindowCanvas(props.document, viewport(), {
      windowGroupBySourceId: windowGroupBySourceId(),
    }),
  );
  const windowRecords = createAppWindowRecords(() => projection().windows);
  const framesByTerminalSource = createMemo(
    () => new Map(props.paneFrames.map((frame) => [frame.pane.id, frame])),
  );
  const resourcesById = createMemo(
    () => new Map(props.terminalInventory?.resources.map((resource) => [resource.id, resource])),
  );

  createEffect(() => {
    const revision = projection().revision;
    const windows = new Map(projection().windows.map((window) => [window.windowId, window]));
    const current = rectOverrides();
    let changed = false;
    const next = new Map(current);
    for (const [windowId, override] of current) {
      if (override.revision !== null && revision > override.revision) {
        next.delete(windowId);
        changed = true;
      } else if (!windows.has(windowId)) {
        next.delete(windowId);
        changed = true;
      }
    }
    if (changed) setRectOverrides(next);
  });

  createEffect(() => {
    const revision = projection().revision;
    const windows = new Map(projection().windows.map((window) => [window.windowId, window]));
    const current = maximizeStates();
    const next = new Map(current);
    let changed = false;
    for (const [windowId, state] of current) {
      const window = windows.get(windowId);
      if (!window || window.placement !== "floating") {
        next.delete(windowId);
        changed = true;
      } else if (revision > state.observedRevision) {
        const rect = window.rect;
        if (
          rect.x !== state.maximizedRect.x ||
          rect.y !== state.maximizedRect.y ||
          rect.width !== state.maximizedRect.width ||
          rect.height !== state.maximizedRect.height
        ) {
          next.delete(windowId);
        } else {
          next.set(windowId, { ...state, observedRevision: revision });
        }
        changed = true;
      }
    }
    if (changed) setMaximizeStates(next);
  });

  createEffect(() => {
    const value = transform();
    sceneRuntimeStyle?.update({
      transform: `translate(${value.x}px, ${value.y}px) scale(${value.scale})`,
      "transform-origin": "0 0",
      // Only the zoom-to-node framing animates; drags/pans stay one-to-one. A
      // reduced-motion media rule in styles.css hard-disables this regardless.
      transition: viewportAnimating()
        ? `transform ${VIEWPORT_ANIMATION_MS}ms var(--desktop-ease-smooth)`
        : "none",
    });
    const grid = 28 * value.scale;
    canvasRuntimeStyle?.update({
      "background-position": `center, ${value.x}px ${value.y}px, ${value.x}px ${value.y}px, 0 0`,
      "background-size": `auto, ${grid}px ${grid}px, ${grid}px ${grid}px, auto`,
    });
  });

  const displayedWindow = (window: AppWindowCanvasItem): AppWindowCanvasItem => {
    const override = rectOverrides().get(window.windowId);
    return override ? { ...window, rect: override.rect } : window;
  };

  // Window rects for the graph overlay, read through `displayedWindow` so edges,
  // group frames, and the minimap track live drag/resize transactions.
  const overlayRects = createMemo<readonly AgentGraphSceneRect[]>(() =>
    projection().windows.map((window) => ({
      windowId: window.windowId,
      rect: displayedWindow(window).rect,
    })),
  );
  const overlayScene = createMemo<AgentGraphScene | null>(() => {
    const overlay = props.overlay;
    return overlay ? projectAgentGraphScene(overlay, overlayRects()) : null;
  });
  const minimap = createMemo<AgentGraphMinimap | null>(() => {
    const overlay = props.overlay;
    if (!overlay) return null;
    const statusById = new Map(
      Object.values(overlay.nodes).map((node) => [node.windowId, node.status] as const),
    );
    const attentionById = new Map(
      Object.values(overlay.nodes).map((node) => [node.windowId, node.attention] as const),
    );
    return projectAgentGraphMinimap({
      windows: overlayRects(),
      statusById,
      attentionById,
      viewport: viewport(),
      transform: transform(),
      size: MINIMAP_SIZE,
      scaleRange: CANVAS_SCALE_RANGE,
      padding: MINIMAP_PADDING,
    });
  });
  const overlayNode = (windowId: string) => props.overlay?.nodes[windowId] ?? null;

  const pointInCanvas = (event: { readonly clientX: number; readonly clientY: number }) => {
    const bounds = canvas?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  };

  const pointerRegion = (target: EventTarget | null): CanvasPointerRegion | null => {
    if (
      !(target instanceof Element) ||
      target.closest(".canvas-controls, .canvas-minimap, .mirror-pane-card")
    ) {
      return null;
    }
    const card = target.closest<HTMLElement>(".app-window-card");
    if (!card) return { kind: "canvas" };
    const windowId = card.dataset.windowId;
    if (!windowId) return null;
    const edge = target.closest<HTMLElement>("[data-canvas-resize-edge]")?.dataset.canvasResizeEdge;
    if (edge) {
      return { kind: "resize-handle", windowId, edge: edge as CanvasResizeEdge };
    }
    if (target.closest(".terminal-surface")) return { kind: "terminal", windowId };
    if (target.closest(".web-pane-frame__header")) {
      return {
        kind: "window-header",
        windowId,
        interactiveControl: Boolean(
          target.closest("button:not(.web-pane-frame__grip), a, input, select, textarea"),
        ),
      };
    }
    return { kind: "window-content", windowId };
  };

  const focusWindow = (windowId: string, source: "keyboard" | "mouse") => {
    if (projection().focusedWindowId !== windowId) {
      props.onCommand?.(appWindowFocusInvocation(windowId, source));
    }
  };

  const updateOverride = (
    windowId: string,
    rect: AppWindowCanvasItem["rect"],
    revision: number | null,
    mutationToken?: number,
  ) => {
    const next = new Map(rectOverrides());
    next.set(windowId, { rect, revision, mutationToken });
    setRectOverrides(next);
  };

  const resetViewport = () => setTransform(DEFAULT_CANVAS_TRANSFORM);
  const fitViewport = () =>
    setTransform(
      fitCanvasViewport(
        projection().windows.map((window) => displayedWindow(window).rect),
        viewport(),
        { padding: 56, scaleRange: CANVAS_SCALE_RANGE },
      ),
    );
  const zoomViewport = (factor: number) => {
    const current = transform();
    setTransform(
      zoomCanvasViewportAt(
        current,
        current.scale * factor,
        { x: viewport().width / 2, y: viewport().height / 2 },
        CANVAS_SCALE_RANGE,
      ),
    );
  };

  const animateViewport = (next: CanvasViewportTransform) => {
    if (props.reducedMotion) {
      setViewportAnimating(false);
      setTransform(next);
      return;
    }
    setViewportAnimating(true);
    setTransform(next);
    if (viewportAnimationTimer !== null) clearTimeout(viewportAnimationTimer);
    viewportAnimationTimer = setTimeout(() => {
      viewportAnimationTimer = null;
      setViewportAnimating(false);
    }, VIEWPORT_ANIMATION_MS);
  };

  /** Frame a single window: fit-to-rect, clamped, with a reduced-motion-aware ease. */
  const zoomToWindow = (rect: AppWindowCanvasItem["rect"]) => {
    animateViewport(
      fitCanvasViewport([rect], viewport(), { padding: 96, scaleRange: CANVAS_SCALE_RANGE }),
    );
  };

  const panToMinimapPoint = (point: { readonly x: number; readonly y: number }) => {
    const current = minimap();
    if (!current) return;
    setTransform(
      agentGraphMinimapPanTransform(current, point, transform(), viewport(), MINIMAP_PADDING),
    );
  };

  const clearMaximizeState = (windowId: string) => {
    const next = new Map(maximizeStates());
    next.delete(windowId);
    setMaximizeStates(next);
  };

  const dispatchDurableCommand = (
    invocation: AppWindowCanvasCommandInvocation | undefined,
    rollback?: () => void,
    committed?: () => void,
    synchronouslyCommitted?: () => void,
  ): void => {
    if (!invocation || !props.onCommand) return;
    try {
      const result = props.onCommand(invocation);
      if (result && typeof result.then === "function") {
        void result.then(
          () => committed?.(),
          () => rollback?.(),
        );
      } else synchronouslyCommitted?.();
    } catch {
      rollback?.();
    }
  };

  /**
   * Bring a docked stack member to the front.
   *
   * `stack.activate` has been implemented and tested in the daemon kernel since
   * the stack model shipped; the renderer simply never sent it, so the app's
   * closest analogue to tmux's window list had no way to switch windows. This
   * is the whole dispatch: the command was always there.
   */
  const activateStackMember = (stackId: string, windowId: string, source: "keyboard" | "mouse") => {
    if (!(props.mutationsAvailable ?? props.onCommand !== undefined)) return;
    dispatchDurableCommand({ command: { type: "stack.activate", stackId, windowId }, source });
  };

  const handleWindowAction = (
    window: AppWindowCanvasItem,
    actionId: string,
    source: "keyboard" | "mouse",
  ) => {
    // Close destroys a tmux window; it is not an AppWindow command and is not
    // gated by the canvas's layout-mutation availability. Its consent is the
    // same inline two-step the context menu uses: the first activation arms the
    // button, the second performs it, and moving on disarms it.
    if (actionId === APP_WINDOW_CANVAS_ACTION_IDS.close) {
      if (!props.verbs) return;
      if (closeConfirmId() !== window.windowId) {
        setCloseConfirmId(window.windowId);
        return;
      }
      setCloseConfirmId(null);
      runVerb("window.kill", window);
      return;
    }
    setCloseConfirmId(null);
    if (!(props.mutationsAvailable ?? props.onCommand !== undefined)) return;
    if (actionId === APP_WINDOW_CANVAS_ACTION_IDS.placement) {
      const previousMaximizeStates = maximizeStates();
      clearMaximizeState(window.windowId);
      dispatchDurableCommand(
        window.placement === "floating"
          ? dockAppWindowIntent(window.windowId, source)
          : floatAppWindowIntent(window.windowId, source),
        () => setMaximizeStates(previousMaximizeStates),
      );
      return;
    }
    if (actionId !== APP_WINDOW_CANVAS_ACTION_IDS.maximize || window.placement !== "floating") {
      return;
    }
    const localMaximized = maximizeStates().get(window.windowId);
    const state = localMaximized
      ? { mode: "maximized" as const, restoreRect: localMaximized.restoreRect }
      : { mode: "restored" as const };
    const topLeft = screenToCanvas({ x: 12, y: 12 }, transform(), CANVAS_SCALE_RANGE);
    const bottomRight = screenToCanvas(
      { x: Math.max(12, viewport().width - 12), y: Math.max(12, viewport().height - 12) },
      transform(),
      CANVAS_SCALE_RANGE,
    );
    const next = toggleAppWindowMaximizeIntent({
      windowId: window.windowId,
      currentRect: displayedWindow(window).rect,
      availableRect: {
        x: topLeft.x,
        y: topLeft.y,
        width: Math.max(1, bottomRight.x - topLeft.x),
        height: Math.max(1, bottomRight.y - topLeft.y),
      },
      state,
      source,
    });
    if (next.state.mode === "maximized") {
      const states = new Map(maximizeStates());
      states.set(window.windowId, {
        restoreRect: next.state.restoreRect,
        maximizedRect: next.rect,
        observedRevision: projection().revision,
      });
      setMaximizeStates(states);
    } else {
      clearMaximizeState(window.windowId);
    }
    const mutationToken = ++nextMutationToken;
    updateOverride(window.windowId, next.rect, null, mutationToken);
    const clearOwnedOverride = () => {
      const overrides = new Map(rectOverrides());
      if (overrides.get(window.windowId)?.mutationToken === mutationToken) {
        overrides.delete(window.windowId);
      }
      setRectOverrides(overrides);
    };
    const markOwnedCommitted = () => {
      const overrides = new Map(rectOverrides());
      if (overrides.get(window.windowId)?.mutationToken === mutationToken) {
        overrides.set(window.windowId, {
          rect: next.rect,
          revision: projection().revision,
        });
      }
      setRectOverrides(overrides);
    };
    dispatchDurableCommand(
      next.commands[0],
      () => {
        clearMaximizeState(window.windowId);
        clearOwnedOverride();
      },
      clearOwnedOverride,
      markOwnedCommitted,
    );
  };

  // ── Multiplexer verbs on the canvas (m49.2) ───────────────────────────────

  const windowById = (windowId: string): AppWindowCanvasItem | null =>
    projection().windows.find((window) => window.windowId === windowId) ?? null;

  const semanticPaneIdOf = (window: AppWindowCanvasItem): string | null => {
    const source = window.source;
    return source.kind === "terminal" ? terminalTarget(source.terminalSourceId) : null;
  };

  /**
   * The identity a verb is dispatched against.
   *
   * Only a pane id: a card's tmux window has no wire-safe window id here (the
   * inventory's grouping key is a digest, not a semantic stamp), which is
   * exactly why the intent contract accepts a pane as the way to name its
   * window. Null when the card has no attachable pane — a verb built against
   * nothing would act on something the user did not point at.
   */
  const verbTarget = (window: AppWindowCanvasItem): MultiplexerVerbTarget | null => {
    const semanticPaneId = semanticPaneIdOf(window);
    return semanticPaneId ? { workspaceName: props.workspaceName, semanticPaneId } : null;
  };

  const sessionFacts = (): MultiplexerVerbFacts => {
    const verbs = props.verbs;
    if (!verbs) return {};
    return {
      workspaceConnected: verbs.workspaceConnected,
      sessionWindowCount: verbs.sessionWindowCount,
    };
  };

  /**
   * The facts a window card can state about itself.
   *
   * `windowZoomed` is seeded false rather than left unknown. The renderer is not
   * told tmux's zoom flag, but the only answer this changes is for a single-pane
   * window — which tmux cannot zoom anyway — so a false here refuses exactly the
   * verb that would have been refused, and a multi-pane window stays offered.
   * The dispatch itself sends `toggle`, so the daemon reads the real flag.
   */
  const windowFacts = (window: AppWindowCanvasItem): MultiplexerVerbFacts => ({
    ...sessionFacts(),
    windowPaneCount: window.windowGroupPaneCount ?? 1,
    windowZoomed: false,
    targetIsActivePane: window.active,
    targetIsDockedStackMember: window.stackId !== null && window.placement === "docked",
  });

  /**
   * Why this card's Close button is refused, or null when it will work.
   *
   * The button had shipped permanently disabled, honestly stating a contract
   * limit. The limit is gone; what remains is tmux's own rule — a session must
   * keep a window — which the verb table already answers, so the button and the
   * menu item refuse for the same reason in the same words.
   */
  const closeRefusal = (window: AppWindowCanvasItem): string | null => {
    if (!props.verbs) return "Closing windows is unavailable in this host";
    if (!verbTarget(window)) return "This window has no attachable pane to address";
    return verbMenuItem("window.kill", windowFacts(window)).disabledReason;
  };

  /** Docked stacks other than this window's own, named by their visible member. */
  const dockTargets = (window: AppWindowCanvasItem): readonly DockStackTarget[] =>
    projection()
      .windows.flatMap((candidate) =>
        candidate.placement === "docked" &&
        candidate.stackId !== null &&
        candidate.stackId !== window.stackId
          ? [{ stackId: candidate.stackId, label: candidate.title ?? "Terminal" }]
          : [],
      )
      .slice(0, 8);

  /**
   * Refusals the verb table cannot compute: flows this canvas has no route to.
   *
   * Stated rather than hidden, and rather than left enabled-but-inert. A menu
   * item that does nothing on click is the one outcome that teaches a user the
   * app is broken instead of teaching them the rule.
   */
  const surfaceRefusals = createMemo<ReadonlyMap<string, string>>(() => {
    const verbs = props.verbs;
    const refusals = new Map<string, string>();
    if (!verbs?.onCreateWindow) {
      refusals.set("window.new", "Creating terminals is unavailable in this host");
    }
    if (!verbs?.onCreateSession) {
      refusals.set("session.new", "Opening a project directory is unavailable in this host");
    }
    if (!verbs?.onDetachSession) {
      refusals.set("session.detach", "Detaching from the app is not available yet");
    }
    refusals.set("session.rename", "Rename a session from the fleet sidebar");
    return refusals;
  });

  const menuSections = createMemo<readonly ContextMenuSection[]>(() => {
    const menu = contextMenu();
    if (!menu) return [];
    if (menu.kind === "canvas") {
      return canvasMenuSections({ facts: sessionFacts(), refusals: surfaceRefusals() });
    }
    const window = windowById(menu.windowId);
    if (!window) return [];
    return windowCardMenuSections({
      refusals: surfaceRefusals(),
      facts: windowFacts(window),
      placement: window.placement,
      maximized: maximizeStates().has(window.windowId),
      appLayoutAvailable: props.mutationsAvailable ?? props.onCommand !== undefined,
      appLayoutUnavailableReason: props.mutationUnavailableReason,
      dockTargets: dockTargets(window),
    });
  });

  const closeMenu = () => setContextMenu(null);

  /** Killed windows the projection has already dropped — the tombstones to draw. */
  const endedWindowIds = createMemo<readonly string[]>(() => {
    const live = new Set(projection().windows.map((window) => window.windowId));
    return [...tombstones().keys()].filter((windowId) => !live.has(windowId));
  });

  const handleContextMenu: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    if (!props.verbs) return;
    const region = pointerRegion(event.target);
    if (!region) return;
    event.preventDefault();
    const pointer = { x: event.clientX, y: event.clientY };
    if (region.kind === "canvas") {
      setContextMenu({ kind: "canvas", pointer });
      return;
    }
    focusWindow(region.windowId, "mouse");
    setContextMenu({ kind: "window", windowId: region.windowId, pointer });
  };

  /**
   * Mark a card as ended and hold the marker briefly.
   *
   * The daemon refresh that removes the card can land in the same frame as the
   * kill's acknowledgement, so without this the window the user just destroyed
   * simply is not there any more — which reads as a glitch rather than as an
   * outcome. Held for one beat, then gone.
   */
  const recordTombstone = (window: AppWindowCanvasItem) => {
    const next = new Map(tombstones());
    next.set(window.windowId, {
      title: window.title ?? "Terminal",
      rect: displayedWindow(window).rect,
    });
    setTombstones(next);
    clearTimeout(tombstoneTimers.get(window.windowId));
    tombstoneTimers.set(
      window.windowId,
      setTimeout(() => {
        tombstoneTimers.delete(window.windowId);
        const remaining = new Map(tombstones());
        remaining.delete(window.windowId);
        setTombstones(remaining);
      }, TOMBSTONE_MS),
    );
  };

  /**
   * Report a refused verb where the user asked for it.
   *
   * A verb that fails silently is the worst of the three outcomes: the user has
   * no way to tell "it worked" from "the daemon said no" from "the click missed",
   * and will try again on an object that may already have changed. The line is
   * transient rather than a dialog — the failure is informational, and there is
   * nothing to confirm.
   */
  const reportVerbFailure = (message: string): void => {
    setVerbError(message);
    if (verbErrorTimer !== null) clearTimeout(verbErrorTimer);
    verbErrorTimer = setTimeout(() => {
      verbErrorTimer = null;
      setVerbError(null);
    }, VERB_ERROR_MS);
  };

  const invokeVerb = (
    verbId: MultiplexerVerbId,
    target: MultiplexerVerbTarget,
    args?: MultiplexerVerbArguments,
    onApplied?: () => void,
  ): void => {
    const verbs = props.verbs;
    if (!verbs) return;
    const label = multiplexerVerb(verbId).label;
    void verbs.invoke(verbId, target, args).then(
      (result) => {
        if (result.status === "ok") {
          onApplied?.();
          return;
        }
        reportVerbFailure(`${label} failed: ${result.error.reason}`);
      },
      (error: unknown) => {
        reportVerbFailure(
          `${label} failed: ${error instanceof Error ? error.message : "the request did not complete"}`,
        );
      },
    );
  };

  const runVerb = (
    verbId: MultiplexerVerbId,
    window: AppWindowCanvasItem,
    args?: MultiplexerVerbArguments,
  ): void => {
    const target = verbTarget(window);
    if (!props.verbs) return;
    if (!target) {
      reportVerbFailure(
        `${multiplexerVerb(verbId).label} needs an attachable pane, and this window has none.`,
      );
      return;
    }
    const destroys = verbId === "pane.kill" || verbId === "window.kill";
    invokeVerb(verbId, target, args, destroys ? () => recordTombstone(window) : undefined);
  };

  const beginRename = (window: AppWindowCanvasItem): void => {
    const target = verbTarget(window);
    if (!props.verbs) return;
    if (!target) {
      reportVerbFailure("This window has no attachable pane, so it cannot be renamed.");
      return;
    }
    const initial = window.title ?? "";
    setRenaming({ windowId: window.windowId, initial, value: initial, target });
  };

  const commitRename = (): void => {
    const pending = renaming();
    setRenaming(null);
    if (!pending) return;
    const trimmed = pending.value.trim();
    if (trimmed.length === 0 || trimmed === pending.initial) return;
    invokeVerb("window.rename", pending.target, { name: trimmed });
  };

  const activateMenuItem = (itemId: string): void => {
    const menu = contextMenu();
    const verbs = props.verbs;
    if (!menu || !verbs) return;
    if (menu.kind === "canvas") {
      if (itemId === "window.new") verbs.onCreateWindow?.();
      else if (itemId === "session.new") verbs.onCreateSession?.();
      else if (itemId === "session.detach") verbs.onDetachSession?.();
      else if (itemId === "session.kill") {
        void verbs.invoke("session.kill", { workspaceName: props.workspaceName });
      }
      return;
    }
    const window = windowById(menu.windowId);
    if (!window) return;
    if (itemId === APP_LAYOUT_MENU_IDS.placement || itemId === APP_LAYOUT_MENU_IDS.maximize) {
      handleWindowAction(
        window,
        itemId === APP_LAYOUT_MENU_IDS.placement
          ? APP_WINDOW_CANVAS_ACTION_IDS.placement
          : APP_WINDOW_CANVAS_ACTION_IDS.maximize,
        "mouse",
      );
      return;
    }
    const dockStackId = stackIdFromDockIntoMenuId(itemId);
    if (dockStackId !== null) {
      if (!(props.mutationsAvailable ?? props.onCommand !== undefined)) return;
      dispatchDurableCommand({
        command: { type: "window.dock", windowId: window.windowId, stackId: dockStackId },
        source: "mouse",
      });
      return;
    }
    if (itemId === "stack.activate") {
      if (window.stackId) activateStackMember(window.stackId, window.windowId, "mouse");
      return;
    }
    if (itemId === "window.rename") {
      beginRename(window);
      return;
    }
    if (itemId === "window.new") {
      verbs.onCreateWindow?.();
      return;
    }
    runVerb(itemId as MultiplexerVerbId, window);
  };

  /**
   * Double-click on a card header.
   *
   * On the title it opens the inline rename; anywhere else on the header it
   * runs tmux's own pane zoom, which the m48 audit found unreachable while a
   * control one pixel away said "Maximize" and meant the card. Without a verb
   * surface the older behaviour stands: frame the window in the viewport.
   */
  const handleDoubleClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    const region = pointerRegion(event.target);
    if (!region || region.kind !== "window-header") return;
    const window = windowById(region.windowId);
    if (!window) return;
    if (!props.verbs) {
      event.preventDefault();
      zoomToWindow(displayedWindow(window).rect);
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest(".web-pane-frame__title-group, .web-pane-frame__title")
    ) {
      event.preventDefault();
      beginRename(window);
      return;
    }
    if (region.interactiveControl) return;
    event.preventDefault();
    runVerb("window.zoom.toggle", window);
  };

  const handlePointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    const region = pointerRegion(event.target);
    if (!region) return;
    const route = routeCanvasPointer({ region, button: event.button, spaceKey: spaceKey() });
    // TerminalSurface owns terminal focus. Dispatching here as well would emit
    // duplicate focus commands from the same bubbling pointer event.
    if (route.focusWindowId && route.action !== "terminal-input") {
      focusWindow(route.focusWindowId, "mouse");
    }
    if (route.action === "clear-focus") {
      canvas?.focus({ preventScroll: true });
      if (projection().focusedWindowId !== null) {
        props.onCommand?.(appWindowFocusInvocation(null, "mouse"));
      }
      return;
    }
    if (!route.claimPointer) return;
    // Zoom-to-node: a double header tap frames that window. This is resolved
    // BEFORE the move transaction starts (a single tap still begins/ends a
    // no-op move), so it never fights pointer capture, and it does not rely on
    // the native dblclick event — a header move preventDefaults the pointer,
    // which suppresses the compatibility click/dblclick pair.
    if (
      props.overlay &&
      !props.verbs &&
      route.action === "move" &&
      region.kind === "window-header" &&
      !region.interactiveControl
    ) {
      const now = event.timeStamp || Date.now();
      const isDoubleTap =
        lastHeaderTap !== null &&
        lastHeaderTap.windowId === region.windowId &&
        now - lastHeaderTap.time <= HEADER_DOUBLE_TAP_MS;
      if (isDoubleTap) {
        lastHeaderTap = null;
        const target = projection().windows.find(({ windowId }) => windowId === region.windowId);
        if (target) {
          event.preventDefault();
          zoomToWindow(displayedWindow(target).rect);
          return;
        }
      }
      lastHeaderTap = { windowId: region.windowId, time: now };
    }
    const pointer = pointInCanvas(event);
    if (route.action === "pan") {
      event.preventDefault();
      panTransaction = { pointerId: event.pointerId, origin: pointer, transform: transform() };
      canvas?.setPointerCapture(event.pointerId);
      canvas?.setAttribute("data-gesture", "pan");
      return;
    }
    if (route.action !== "move" && route.action !== "resize") return;
    const window = projection().windows.find(({ windowId }) => windowId === route.focusWindowId);
    if (!window || window.placement !== "floating" || maximizeStates().has(window.windowId)) {
      return;
    }
    event.preventDefault();
    const transactionInput = {
      pointer: { ...pointer, pointerId: event.pointerId },
      windowId: window.windowId,
      rect: displayedWindow(window).rect,
      transform: transform(),
      scaleRange: CANVAS_SCALE_RANGE,
      constraints: { minWidth: 320, minHeight: 180 },
      presentation: { reducedMotion: props.reducedMotion ?? false },
    };
    pointerTransaction =
      route.action === "resize"
        ? beginCanvasResize({ ...transactionInput, edge: route.edge })
        : beginCanvasMove(transactionInput);
    canvas?.setPointerCapture(event.pointerId);
    canvas?.setAttribute("data-gesture", route.action);
  };

  const handlePointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    const pointer = pointInCanvas(event);
    if (panTransaction?.pointerId === event.pointerId) {
      event.preventDefault();
      setTransform(
        panCanvasViewport(
          panTransaction.transform,
          { x: pointer.x - panTransaction.origin.x, y: pointer.y - panTransaction.origin.y },
          CANVAS_SCALE_RANGE,
        ),
      );
      return;
    }
    if (pointerTransaction?.pointerId !== event.pointerId) return;
    event.preventDefault();
    const update = updateCanvasPointerTransaction(pointerTransaction, {
      ...pointer,
      pointerId: event.pointerId,
    });
    pointerTransaction = update.transaction;
    updateOverride(pointerTransaction.windowId, update.frame.rect, null);
  };

  const completePointer = (event: PointerEvent, cancelled: boolean) => {
    if (panTransaction?.pointerId === event.pointerId) panTransaction = null;
    if (pointerTransaction?.pointerId === event.pointerId) {
      const transaction = pointerTransaction;
      const completion = cancelled
        ? cancelCanvasPointerTransaction(transaction)
        : commitCanvasPointerTransaction(transaction);
      pointerTransaction = null;
      if (completion.persist) {
        const mutationToken = ++nextMutationToken;
        // Keep this optimistic frame independent from base revisions while the
        // serialized host command is pending. An earlier mutation refresh must
        // not erase a later drag on the same window.
        updateOverride(transaction.windowId, completion.rect, null, mutationToken);
        const [intent] = completion.commands;
        const clearOwnedOverride = () => {
          const overrides = new Map(rectOverrides());
          if (overrides.get(transaction.windowId)?.mutationToken === mutationToken) {
            overrides.delete(transaction.windowId);
          }
          setRectOverrides(overrides);
        };
        const markOwnedCommitted = () => {
          const overrides = new Map(rectOverrides());
          if (overrides.get(transaction.windowId)?.mutationToken === mutationToken) {
            overrides.set(transaction.windowId, {
              rect: completion.rect,
              revision: projection().revision,
            });
          }
          setRectOverrides(overrides);
        };
        dispatchDurableCommand(intent, clearOwnedOverride, clearOwnedOverride, markOwnedCommitted);
      } else {
        const next = new Map(rectOverrides());
        next.delete(transaction.windowId);
        setRectOverrides(next);
      }
    }
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas?.removeAttribute("data-gesture");
  };

  const cancelActivePointer = () => {
    const pointerId = pointerTransaction?.pointerId ?? panTransaction?.pointerId ?? null;
    if (pointerTransaction) {
      const transaction = pointerTransaction;
      const completion = cancelCanvasPointerTransaction(transaction);
      pointerTransaction = null;
      updateOverride(transaction.windowId, completion.rect, null);
      const next = new Map(rectOverrides());
      next.delete(transaction.windowId);
      setRectOverrides(next);
    }
    panTransaction = null;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) {
      canvas.releasePointerCapture(pointerId);
    }
    canvas?.removeAttribute("data-gesture");
  };

  const handleWheel: JSX.EventHandler<HTMLDivElement, WheelEvent> = (event) => {
    const region = pointerRegion(event.target);
    if (!region || !canvasOwnsWheel(region)) return;
    event.preventDefault();
    setTransform(
      canvasWheelTransform({
        transform: transform(),
        anchor: pointInCanvas(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        scaleRange: CANVAS_SCALE_RANGE,
      }),
    );
  };

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.target !== canvas || eventTargetsTerminalInput(event)) return;
    if (event.key === "Escape" && pointerTransaction) {
      event.preventDefault();
      cancelActivePointer();
      return;
    }
    const command = canvasViewportKeyboardCommand(event);
    if (!command) return;
    event.preventDefault();
    if (command === "fit") fitViewport();
    else if (command === "reset") resetViewport();
    else {
      setTransform(
        keyboardCanvasViewportTransform({
          transform: transform(),
          command,
          center: { x: viewport().width / 2, y: viewport().height / 2 },
          scaleRange: CANVAS_SCALE_RANGE,
        }),
      );
    }
  };

  onMount(() => {
    window.addEventListener("blur", cancelActivePointer);
    onCleanup(() => window.removeEventListener("blur", cancelActivePointer));
  });

  // Mirror nodes live inside the same pan/zoom scene, in a deterministic grid
  // below every durable card. Their identity is the SAME stable instance id
  // the daemon mints for a terminal source — card 5 unifies the two worlds.
  const mirrorScene = createMemo(() => {
    const mirror = props.mirror;
    if (!mirror?.enabled || mirror.nodes.length === 0) return null;
    const rects = mirrorNodeRects(
      mirror.nodes.length,
      projection().windows.map((window) => displayedWindow(window).rect),
      viewport(),
    );
    return {
      connection: mirror.connection,
      faultLabel: mirror.faultLabel ?? null,
      onRetry: mirror.onRetry,
      rendererFactory: mirror.rendererFactory,
      nodes: mirror.nodes.map((node, index) => ({
        node,
        nodeId: stableAppWindowInstanceId({ kind: "terminal", terminalSourceId: node.pane }),
        rect: rects[index]!,
      })),
    };
  });
  // The scene memo re-runs on EVERY stream tick and mints fresh entry objects.
  // Rendering it through `<For>` directly keyed each row by object identity, so
  // a tick disposed and rebuilt every mirror row — remounting xterm per update.
  // These two derivations split the list into a value-stable key order (pane
  // ids compare by value, so `For` reuses the row) and a lookup the row reads
  // through an accessor. Nothing in the row is keyed on per-tick identity.
  const mirrorPaneOrder = createMemo<readonly string[]>(
    () => mirrorScene()?.nodes.map((entry) => entry.node.pane) ?? [],
  );
  const mirrorEntries = createMemo<ReadonlyMap<string, MirrorSceneEntry>>(() => {
    const entries = new Map<string, MirrorSceneEntry>();
    for (const entry of mirrorScene()?.nodes ?? []) entries.set(entry.node.pane, entry);
    return entries;
  });
  const mirrorStatus = createMemo(() => {
    const mirror = props.mirror;
    if (!mirror?.enabled) return null;
    return statusStripFromConnectionHealth(mirror.connection);
  });

  const terminalTarget = (terminalSourceId: string): string | null => {
    const resource = resourcesById().get(terminalSourceId);
    if (props.terminalInventory !== undefined) {
      return resource?.attachability.status === "available"
        ? resource.attachability.semanticPaneId
        : null;
    }
    return terminalSourceId;
  };

  return (
    <div
      ref={(element) => {
        canvas = element;
        canvasRuntimeStyle = createRuntimeStyleBinding(element);
        const value = transform();
        const grid = 28 * value.scale;
        canvasRuntimeStyle.update({
          "background-position": `center, ${value.x}px ${value.y}px, ${value.x}px ${value.y}px, 0 0`,
          "background-size": `auto, ${grid}px ${grid}px, ${grid}px ${grid}px, auto`,
        });
      }}
      class="app-window-canvas"
      role="region"
      aria-label="Terminal canvas"
      aria-keyshortcuts="+ - 0 F ArrowLeft ArrowRight ArrowUp ArrowDown"
      tabIndex={0}
      data-window-revision={projection().revision}
      data-window-count={projection().windows.length}
      data-focused-window-id={projection().focusedWindowId ?? ""}
      data-viewport-persistence="runtime-only"
      data-viewport-x={Math.round(transform().x)}
      data-viewport-y={Math.round(transform().y)}
      data-viewport-scale={transform().scale.toFixed(3)}
      data-space-key={spaceKey()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => completePointer(event, false)}
      onPointerCancel={(event) => completePointer(event, true)}
      onLostPointerCapture={(event) => {
        if (
          pointerTransaction?.pointerId === event.pointerId ||
          panTransaction?.pointerId === event.pointerId
        ) {
          cancelActivePointer();
        }
      }}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onDblClick={handleDoubleClick}
    >
      <div
        ref={(element) => {
          sceneRuntimeStyle = createRuntimeStyleBinding(element);
          const value = transform();
          sceneRuntimeStyle.update({
            transform: `translate(${value.x}px, ${value.y}px) scale(${value.scale})`,
            "transform-origin": "0 0",
          });
        }}
        class="app-window-canvas__scene"
      >
        <Show when={overlayScene()}>
          {(scene) => (
            <svg class="agent-graph" aria-hidden="true">
              <For each={scene().groups}>
                {(group) => {
                  const pillWidth = Math.min(
                    Math.max(24, group.rect.width - 12),
                    Math.max(48, group.label.length * 7 + 22),
                  );
                  return (
                    <g class="agent-graph__group" data-group-id={group.id}>
                      <rect
                        class="agent-graph__group-frame"
                        x={group.rect.x}
                        y={group.rect.y}
                        width={group.rect.width}
                        height={group.rect.height}
                        rx="14"
                      />
                      <rect
                        class="agent-graph__group-pill"
                        x={group.rect.x + 12}
                        y={group.rect.y - 11}
                        width={pillWidth}
                        height="22"
                        rx="11"
                      />
                      <text class="agent-graph__group-label" x={group.rect.x + 22} y={group.rect.y}>
                        {group.label}
                      </text>
                    </g>
                  );
                }}
              </For>
              <For each={scene().edges}>
                {(edge) => (
                  <g
                    class="agent-graph__edge-group"
                    data-kind={edge.kind}
                    data-attention={edge.attention ? "true" : "false"}
                    data-from={edge.from}
                    data-to={edge.to}
                  >
                    <path
                      class="agent-graph__edge"
                      data-kind={edge.kind}
                      data-attention={edge.attention ? "true" : "false"}
                      d={edge.path}
                    />
                    <path
                      class="agent-graph__arrow"
                      data-kind={edge.kind}
                      data-attention={edge.attention ? "true" : "false"}
                      d={edge.arrow}
                    />
                  </g>
                )}
              </For>
            </svg>
          )}
        </Show>
        <For each={windowRecords()}>
          {(record) => {
            const window = createMemo(() => displayedWindow(record.value()));
            let runtimeStyle: RuntimeStyleBinding | null = null;
            createComputed(() => {
              const value = window();
              runtimeStyle?.update({
                left: `${value.rect.x}px`,
                top: `${value.rect.y}px`,
                width: `${value.rect.width}px`,
                height: `${value.rect.height}px`,
                "z-index": value.zIndex,
              });
            });
            onCleanup(() => runtimeStyle?.dispose());
            const terminalSourceId = () => {
              const source = window().source;
              return source.kind === "terminal" ? source.terminalSourceId : null;
            };
            const sourceFrame = createMemo(() => {
              const sourceId = terminalSourceId();
              return sourceId ? (framesByTerminalSource().get(sourceId) ?? null) : null;
            });
            const frame = createMemo(() => {
              const source = sourceFrame();
              return source
                ? windowFrameModel(window(), source, {
                    maximized: maximizeStates().has(window().windowId),
                    commandsAvailable: props.mutationsAvailable ?? props.onCommand !== undefined,
                    unavailableReason: props.mutationUnavailableReason,
                    closeDisabledReason: closeRefusal(window()),
                    closeConfirming: closeConfirmId() === window().windowId,
                  })
                : null;
            });
            const target = createMemo(() => {
              const sourceId = terminalSourceId();
              return sourceId ? terminalTarget(sourceId) : null;
            });
            return (
              <article
                ref={(element) => {
                  runtimeStyle = createRuntimeStyleBinding(element);
                  const value = window();
                  runtimeStyle.update({
                    left: `${value.rect.x}px`,
                    top: `${value.rect.y}px`,
                    width: `${value.rect.width}px`,
                    height: `${value.rect.height}px`,
                    "z-index": value.zIndex,
                  });
                }}
                class="app-window-card"
                data-window-id={window().windowId}
                data-terminal-source-id={terminalSourceId() ?? ""}
                data-window-pane-count={window().windowGroupPaneCount ?? 1}
                data-placement={window().placement}
                data-selected={window().selected}
                data-active={window().active}
                data-agent-status={
                  props.overlay ? (overlayNode(window().windowId)?.status ?? "") : undefined
                }
                data-agent-attention={
                  props.overlay
                    ? overlayNode(window().windowId)?.attention
                      ? "true"
                      : "false"
                    : undefined
                }
                data-maximized={maximizeStates().has(window().windowId)}
                data-ending={tombstones().has(window().windowId)}
                data-transient-geometry={rectOverrides().get(window().windowId)?.revision === null}
              >
                <Show when={window().stackMembers}>
                  {(members) => (
                    <div
                      class="app-window-card__stack-tabs"
                      role="tablist"
                      aria-label="Windows in this stack"
                      data-stack-id={window().stackId ?? ""}
                    >
                      <For each={members()}>
                        {(member) => (
                          <button
                            type="button"
                            class="app-window-card__stack-tab"
                            role="tab"
                            aria-selected={member.active}
                            data-window-id={member.windowId}
                            data-active={member.active}
                            disabled={member.active}
                            onClick={() => {
                              const stackId = window().stackId;
                              if (stackId) activateStackMember(stackId, member.windowId, "mouse");
                            }}
                          >
                            {member.title ?? "Terminal"}
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </Show>
                <Show when={renaming()?.windowId === window().windowId}>
                  <form
                    class="app-window-card__rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename();
                    }}
                  >
                    <input
                      name="name"
                      class="app-window-card__rename-field"
                      aria-label={`Rename ${window().title ?? "this window"}`}
                      value={renaming()?.value ?? ""}
                      autocomplete="off"
                      spellcheck={false}
                      data-focus-ring="field"
                      ref={(element) => queueMicrotask(() => element.select())}
                      onKeyDown={(event) => {
                        // Enter is committed HERE rather than left to the form's
                        // implicit submission: that mechanism depends on the
                        // field count and on the browser, and a rename that
                        // silently does nothing on Enter is indistinguishable
                        // from one the daemon refused.
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setRenaming(null);
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename();
                        }
                      }}
                      onInput={(event) => {
                        const typed = event.currentTarget.value;
                        setRenaming((current) => (current ? { ...current, value: typed } : null));
                      }}
                      onBlur={commitRename}
                    />
                  </form>
                </Show>
                <Show
                  when={frame()}
                  fallback={
                    <section class="app-window-card__unavailable" role="status">
                      <strong>{window().title ?? "Terminal unavailable"}</strong>
                      <span>This saved window no longer has a matching terminal resource.</span>
                    </section>
                  }
                >
                  {(model) => (
                    <WebPaneFrame
                      model={model()}
                      onActionActivate={(intent, source) =>
                        handleWindowAction(window(), intent.actionId, source)
                      }
                      onGripActivate={(_intent, source) => {
                        if (source === "keyboard") focusWindow(window().windowId, "keyboard");
                      }}
                      renderPaneIcon={(_pane, icon) => <DomIcon id={icon} usage="pane" />}
                      renderActionIcon={(action) => <DomIcon id={action.icon} usage="action" />}
                      renderGripIcon={(icon) => <DomIcon id={icon} usage="action" />}
                    >
                      <div class="agent-pane__body" data-focus-zone="terminal">
                        <Show
                          when={target()}
                          fallback={
                            <div
                              class="terminal-surface terminal-surface--unavailable"
                              role="status"
                            >
                              <strong>Terminal unavailable</strong>
                              <span>
                                {model().status?.description ??
                                  "This terminal cannot be attached safely."}
                              </span>
                            </div>
                          }
                        >
                          {(semanticPaneId) => (
                            <TerminalSurface
                              target={{
                                workspaceName: props.workspaceName,
                                semanticPaneId: semanticPaneId(),
                              }}
                              title={model().title}
                              transport={props.transport}
                              focused={model().appearance.accessibility.terminalInputOwner}
                              sizePassive={(window().windowGroupPaneCount ?? 1) > 1}
                              reducedMotion={props.reducedMotion}
                              themeKey={props.terminalThemeKey}
                              rendererFactory={props.rendererFactory}
                              onFocus={(source) => {
                                const sourceId = terminalSourceId();
                                if (sourceId) focusWindow(window().windowId, source);
                              }}
                            />
                          )}
                        </Show>
                      </div>
                    </WebPaneFrame>
                  )}
                </Show>
                <Show
                  when={
                    window().placement === "floating" && !maximizeStates().has(window().windowId)
                  }
                >
                  <For
                    each={
                      [
                        "north-west",
                        "north",
                        "north-east",
                        "east",
                        "south-east",
                        "south",
                        "south-west",
                        "west",
                      ] as const
                    }
                  >
                    {(edge) => (
                      <span
                        class="app-window-card__resize-handle"
                        data-canvas-resize-edge={edge}
                        aria-hidden="true"
                      />
                    )}
                  </For>
                </Show>
              </article>
            );
          }}
        </For>
        {/*
         * Tombstones: cards the user killed, held for one beat after the daemon
         * refresh removed them. A window that simply disappears reads as a
         * glitch; one that is seen to end reads as the thing that was asked for.
         */}
        <For each={endedWindowIds()}>
          {(windowId) => {
            let tombstoneStyle: RuntimeStyleBinding | null = null;
            onCleanup(() => tombstoneStyle?.dispose());
            const entry = createMemo(() => tombstones().get(windowId) ?? null);
            const applyRect = () => {
              const rect = entry()?.rect;
              if (!rect) return;
              tombstoneStyle?.update({
                left: `${rect.x}px`,
                top: `${rect.y}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                "z-index": 140,
              });
            };
            createEffect(applyRect);
            return (
              <article
                ref={(element) => {
                  tombstoneStyle = createRuntimeStyleBinding(element);
                  applyRect();
                }}
                class="app-window-card app-window-card--ended"
                role="status"
                data-window-id={windowId}
                data-ended="true"
              >
                <strong>{entry()?.title ?? "Terminal"}</strong>
                <span>Ended</span>
              </article>
            );
          }}
        </For>
        <Show when={mirrorScene()}>
          {(scene) => (
            <For each={mirrorPaneOrder()}>
              {(pane) => {
                // Row identity law: this row is keyed by the semantic pane id,
                // so its DOM node, its runtime-style rule, and the xterm
                // instance inside it survive every stream tick. Everything that
                // changes per tick reaches the row through `entry()`.
                const entry = createMemo<MirrorSceneEntry>(
                  (previous) => mirrorEntries().get(pane) ?? previous,
                  mirrorEntries().get(pane)!,
                );
                let mirrorStyle: RuntimeStyleBinding | null = null;
                onCleanup(() => mirrorStyle?.dispose());
                const applyRect = (): void => {
                  const rect = entry().rect;
                  mirrorStyle?.update({
                    left: `${rect.x}px`,
                    top: `${rect.y}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    "z-index": MIRROR_CARD_Z_INDEX,
                  });
                };
                // Placement now moves the SAME element instead of arriving with
                // a replacement one, so the rect needs its own effect.
                createEffect(applyRect);
                return (
                  <article
                    ref={(element) => {
                      mirrorStyle = createRuntimeStyleBinding(element);
                      applyRect();
                    }}
                    class="mirror-pane-card"
                    data-mirror-node-id={entry().nodeId}
                    data-pane={pane}
                    data-state={entry().node.state.kind}
                  >
                    <WebPaneFrame
                      model={mirrorNodeFrameModel(entry().node, entry().nodeId)}
                      renderPaneIcon={(_pane, icon) => <DomIcon id={icon} usage="pane" />}
                      renderActionIcon={(action) => <DomIcon id={action.icon} usage="action" />}
                      renderGripIcon={(icon) => <DomIcon id={icon} usage="action" />}
                    >
                      <div class="agent-pane__body agent-pane__body--mirror">
                        <MirrorPaneNode
                          pane={pane}
                          title={entry().node.title}
                          state={entry().node.state}
                          connection={scene().connection}
                          faultLabel={scene().faultLabel ?? null}
                          registerSink={entry().node.registerSink}
                          onRetry={scene().onRetry}
                          reducedMotion={props.reducedMotion}
                          themeKey={props.terminalThemeKey}
                          rendererFactory={scene().rendererFactory}
                        />
                      </div>
                    </WebPaneFrame>
                  </article>
                );
              }}
            </For>
          )}
        </Show>
        <Show when={projection().windows.length === 0}>
          <div class="app-window-canvas__empty" role="status">
            <strong>No terminal windows in this saved layout</strong>
            <span>Create or restore a terminal window to place it on the canvas.</span>
          </div>
        </Show>
      </div>
      <Show when={mirrorStatus()}>
        {(status) => (
          <p
            class="app-window-canvas__mirror-status"
            role="status"
            data-mirror-connection={props.mirror?.connection.kind}
          >
            {status().message}
          </p>
        )}
      </Show>
      <Show when={verbError()}>
        {(message) => (
          <p class="app-window-canvas__verb-error" role="alert" data-verb-error="true">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.overlayTruncated}>
        <p class="app-window-canvas__fleet-truncated" role="status" data-overlay-truncated="true">
          Fleet view is partial
        </p>
      </Show>
      <nav class="canvas-controls" aria-label="Canvas view controls">
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out (-)"
          disabled={transform().scale <= CANVAS_SCALE_RANGE.min}
          onClick={() => zoomViewport(1 / 1.2)}
        >
          <CanvasControlIcon id="zoom-out" />
        </button>
        <output aria-label={`Canvas zoom ${Math.round(transform().scale * 100)} percent`}>
          {Math.round(transform().scale * 100)}%
        </output>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in (+)"
          disabled={transform().scale >= CANVAS_SCALE_RANGE.max}
          onClick={() => zoomViewport(1.2)}
        >
          <CanvasControlIcon id="zoom-in" />
        </button>
        <i aria-hidden="true" />
        <button
          type="button"
          aria-label="Fit windows"
          title="Fit windows (F)"
          onClick={fitViewport}
        >
          <CanvasControlIcon id="fit" />
        </button>
        <button
          type="button"
          aria-label="Reset view"
          title="Reset view (0)"
          onClick={resetViewport}
        >
          <CanvasControlIcon id="reset" />
        </button>
        <Show when={props.mirror}>
          {(mirror) => (
            <button
              type="button"
              class="canvas-controls__mirror-toggle"
              aria-label="Toggle mirror panes"
              aria-pressed={mirror().enabled}
              title="Mirror this workspace's panes as read-only nodes"
              data-mirror-toggle="true"
              onClick={() => mirror().onToggle(!mirror().enabled)}
            >
              Mirror
            </button>
          )}
        </Show>
      </nav>
      <Show when={contextMenu()}>
        {(menu) => (
          <ContextMenu
            open
            pointer={menu().pointer}
            label={menu().kind === "window" ? "Window actions" : "Canvas actions"}
            sections={menuSections()}
            openSource="contextmenu"
            onClose={closeMenu}
            onActivate={(itemId) => activateMenuItem(itemId)}
          />
        )}
      </Show>
      <Show when={minimap()}>
        {(map) => (
          <div class="canvas-minimap" data-window-count={map().windows.length}>
            <svg
              class="canvas-minimap__surface"
              viewBox={`0 0 ${MINIMAP_SIZE.width} ${MINIMAP_SIZE.height}`}
              role="img"
              aria-label="Canvas minimap"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                if (bounds.width === 0 || bounds.height === 0) return;
                panToMinimapPoint({
                  x: ((event.clientX - bounds.left) / bounds.width) * MINIMAP_SIZE.width,
                  y: ((event.clientY - bounds.top) / bounds.height) * MINIMAP_SIZE.height,
                });
              }}
            >
              <For each={map().windows}>
                {(window) => (
                  <rect
                    class="canvas-minimap__window"
                    data-status={window.status ?? "none"}
                    data-attention={window.attention ? "true" : "false"}
                    x={window.rect.x}
                    y={window.rect.y}
                    width={Math.max(2, window.rect.width)}
                    height={Math.max(2, window.rect.height)}
                    rx="1.5"
                  />
                )}
              </For>
              <rect
                class="canvas-minimap__viewport"
                x={map().viewportRect.x}
                y={map().viewportRect.y}
                width={Math.max(0, map().viewportRect.width)}
                height={Math.max(0, map().viewportRect.height)}
              />
            </svg>
          </div>
        )}
      </Show>
    </div>
  );
}
