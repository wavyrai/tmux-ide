import {
  resolvePaneAppearance,
  type AgentGraphOverlay,
  type AppWindowDocumentV1,
  type ApplicationShellTerminalInventory,
  type PaneAppearance,
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
import { WebPaneFrame } from "../../../../packages/daemon/src/ui/pane-frame/web-host-unstyled.tsx";
import type {
  PaneFrameAction,
  PaneFrameModel,
} from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { TerminalRendererFactory } from "../terminal/xterm-renderer.ts";
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

interface LocalMaximizedWindow {
  readonly restoreRect: AppWindowCanvasItem["rect"];
  readonly maximizedRect: AppWindowCanvasItem["rect"];
  readonly observedRevision: number;
}

function unavailableReason(commandsAvailable: boolean, reason?: string): string | null {
  return commandsAvailable ? null : (reason ?? "Window mutations are unavailable in this host");
}

export function appWindowCanvasActions(input: {
  readonly placement: AppWindowCanvasItem["placement"];
  readonly maximized: boolean;
  readonly commandsAvailable: boolean;
  readonly unavailableReason?: string;
}): readonly PaneFrameAction[] {
  const mutationUnavailable = unavailableReason(input.commandsAvailable, input.unavailableReason);
  const docked = input.placement === "docked";
  return [
    {
      id: APP_WINDOW_CANVAS_ACTION_IDS.placement,
      commandId: docked ? "workspace.window.float" : "workspace.window.dock",
      behavior: "action",
      icon: docked ? "float" : "dock",
      label: docked ? "Float" : "Dock",
      description: docked ? "Float this window on the canvas" : "Dock this window",
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
      label: input.maximized ? "Restore" : "Maximize",
      description: input.maximized ? "Restore the floating window" : "Maximize the floating window",
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
      label: "Close",
      description: "Close this app window",
      available: false,
      disabledReason: "Closing app windows is not supported by the AppWindow command contract",
      pressed: false,
      busy: false,
    },
  ];
}

type CanvasControlIconId = "zoom-in" | "zoom-out" | "fit" | "reset";

function CanvasControlIcon(props: { readonly id: CanvasControlIconId }): JSX.Element {
  return (
    <svg
      class="canvas-controls__icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      data-icon={props.id}
    >
      <Show when={props.id === "zoom-in"}>
        <path d="M8 3v10M3 8h10" />
      </Show>
      <Show when={props.id === "zoom-out"}>
        <path d="M3 8h10" />
      </Show>
      <Show when={props.id === "fit"}>
        <path d="M6 3H3v3M10 3h3v3M13 10v3h-3M6 13H3v-3" />
      </Show>
      <Show when={props.id === "reset"}>
        <path d="M13 5.5V2.75l-1.5 1.5A5.25 5.25 0 1 0 13 10M13 2.75h-2.75" />
      </Show>
    </svg>
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
    }),
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
  const projection = createMemo(() => projectAppWindowCanvas(props.document, viewport()));
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
    if (!(target instanceof Element) || target.closest(".canvas-controls, .canvas-minimap")) {
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

  const handleWindowAction = (
    window: AppWindowCanvasItem,
    actionId: string,
    source: "keyboard" | "mouse",
  ) => {
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
                data-transient-geometry={rectOverrides().get(window().windowId)?.revision === null}
              >
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
        <Show when={projection().windows.length === 0}>
          <div class="app-window-canvas__empty" role="status">
            <strong>No terminal windows in this saved layout</strong>
            <span>Create or restore a terminal window to place it on the canvas.</span>
          </div>
        </Show>
      </div>
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
      </nav>
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
