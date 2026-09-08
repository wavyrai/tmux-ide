import type { PaneInteractionProjection } from "@tmux-ide/core";
/* @jsxImportSource @opentui/solid */
import {
  clampTerminalViewportOrigin,
  terminalLiveViewportOrigin,
  reflowTerminalPosition,
} from "../terminal-viewport.ts";
import {
  For,
  Show,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import type { SemanticThemeSnapshot, TerminalPaletteProjection } from "../theme.ts";
import type { PaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { PaneScopedTerminalSurface } from "./pane-scoped-terminal-surface.tsx";
import {
  nativePaneGeometries,
  projectOpenTuiPaneFrames,
  type OpenTuiPaneFrame,
} from "./terminal-layout-projection.ts";
import {
  TerminalWindowStrip,
  type TerminalWindowTab,
} from "../workspace/terminal-window-strip.tsx";
import { orderCells } from "../selection.ts";
import { terminalSelectionUnit, extendTerminalSelectionUnit } from "./terminal-selection-units.ts";
import { terminalLinkAt, isTerminalLinkClick } from "./terminal-links.ts";
import { extractTerminalCopySelection } from "./terminal-copy-selection.ts";
import {
  createTerminalCopyCursor,
  moveTerminalCopyCursor,
  pageTerminalCopyCursor,
  scrollTerminalCopyCursor,
  type TerminalCopyCursor,
  type TerminalCopyMotion,
} from "./terminal-copy-cursor.ts";
import {
  createTerminalScrollback,
  createTerminalWheelGesture,
} from "../workspace/terminal-scrollback.ts";
import { PaneTitleBar } from "../workspace/terminal-pane-header.tsx";
import { PANE_ACTION_MENU_ITEMS, PaneActionMenu } from "../workspace/pane-action-menu.tsx";
import type { PaneMenuKeyHandler } from "../workspace/pane-action-menu-model.ts";
import { createApplicationPaneMenuOwner } from "./application-pane-menu-owner.ts";
import {
  extractTerminalSelection,
  terminalMouseActionSupported,
  terminalGestureLeaseMatches,
  terminalSelectionCell,
  terminalMouseInput,
  type TerminalGestureLease,
  type TerminalGestureRuntimeIdentity,
  type TerminalSelectionRange,
} from "./terminal-selection.ts";
import {
  retainedTerminalWindowKey,
  terminalAgentStatusLabel,
  terminalPaneDisplayTitle,
  terminalPaneResizePreview,
  terminalPaneSeparatorAt,
  terminalPaneSeparators,
  terminalWindowAgentIndicator,
  terminalWindowPane,
  terminalWindowTitle,
  type ApplicationPaneResizePreview,
  type ApplicationPaneSeparator,
  type ApplicationTerminalAgentIndicator,
} from "./application-terminal-workspace-policy.ts";
export {
  terminalAgentStatusLabel,
  terminalPaneChromeLabel,
  terminalPaneDisplayTitle,
  type ApplicationPaneResizePreview,
  type ApplicationTerminalAgentIndicator,
} from "./application-terminal-workspace-policy.ts";

type WorkspaceMouseEvent = {
  readonly type: string;
  readonly button?: number;
  readonly x: number;
  readonly y: number;
  readonly modifiers?: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean };
  readonly scroll?: {
    readonly direction?: "up" | "down" | "left" | "right";
    readonly delta?: number;
  };
  stopPropagation?: () => void;
};

export interface ApplicationResizePointerIngress {
  readonly gestureId: string;
  readonly traceId: string;
  readonly action: "down" | "drag" | "up";
  readonly x: number;
  readonly y: number;
  readonly atMicros: number;
}

export type ApplicationPaneContextAction =
  | "zoom-pane"
  | "rename-pane"
  | "split-right"
  | "split-down"
  | "close-pane";

export interface ApplicationMousePointerIngress {
  readonly gestureId: string;
  readonly action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down";
  readonly x: number;
  readonly y: number;
  readonly atMicros: number;
}

export function safeApplicationMouseIngressMicros(
  now: () => number = () => performance.now(),
): number | null {
  try {
    const atMicros = Math.floor(now() * 1_000);
    return Number.isSafeInteger(atMicros) && atMicros >= 0 ? atMicros : null;
  } catch {
    return null;
  }
}

export function beginApplicationMouseIngress(
  ingress: ApplicationTerminalWorkspaceProps["onApplicationMousePointerIngress"],
  now: () => number = () => performance.now(),
):
  | ((
      input: Omit<Parameters<NonNullable<typeof ingress>>[0], "atMicros">,
    ) => ApplicationMousePointerIngress | null)
  | null {
  if (!ingress) return null;
  const atMicros = safeApplicationMouseIngressMicros(now);
  if (atMicros === null) return () => null;
  return (input) => ingress({ ...input, atMicros }) ?? null;
}

export interface ApplicationTerminalWorkspaceProps {
  readonly paneInteractions?: Accessor<ReadonlyMap<string, PaneInteractionProjection>>;
  readonly layout: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
  readonly adapter: PaneScopedTerminalAdapter;
  readonly rendererEpoch: number;
  readonly hostFocusTransitionOwner?: PaneSurfaceHostFocusTransitionOwner;
  readonly width: number;
  readonly height: number;
  /** Rows owned by parent chrome before the terminal canvas. Defaults to the
   * standalone app bar + window strip; nested shells use one window-strip row. */
  readonly topOffset?: number;
  /** Parent origin in renderer cells; OpenTUI mouse events are viewport-relative. */
  readonly originX?: number;
  readonly originY?: number;
  readonly focusedPane: string | null;
  /** Physical host focus is independent from which retained window is current. */
  readonly rendererFocused?: boolean;
  /** Higher-level palette/rename overlays suspend pane menu ownership. */
  readonly interactive?: boolean;
  readonly theme: SemanticThemeSnapshot;
  readonly palette: TerminalPaletteProjection;
  /** Daemon-authored semantic agent state, keyed by durable pane identity. */
  readonly agentIndicators?: Accessor<ReadonlyMap<string, ApplicationTerminalAgentIndicator>>;
  readonly onSelectPane: (paneId: string) => void;
  readonly onCreateWindow?: () => void;
  readonly onPaneContextAction?: (
    paneId: string,
    action: ApplicationPaneContextAction,
    currentName: string,
  ) => void;
  readonly onResizePreview?: (preview: ApplicationPaneResizePreview) => void;
  readonly onResizePane?: (preview: ApplicationPaneResizePreview) => void;
  readonly onResizePointerIngress?: (input: {
    readonly action: "down" | "drag" | "up";
    readonly x: number;
    readonly y: number;
    readonly gestureId: string | null;
  }) => ApplicationResizePointerIngress | null;
  /** Optional bounded host diagnostics; contains no terminal content. */
  readonly onWheelObservation?: (observation: Readonly<Record<string, unknown>>) => void;
  readonly onTerminalInput?: (
    paneId: string,
    input:
      | { readonly kind: "text"; readonly data: string }
      | Readonly<{
          kind: "application-mouse";
          data: string;
          dataEncoding?: "hex";
          action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down";
          column: number;
          row: number;
          button: number | null;
          modifiers: Readonly<{ shift: boolean; alt: boolean; ctrl: boolean }>;
          ingress: ApplicationMousePointerIngress | null;
        }>,
  ) => void;
  readonly onApplicationMousePointerIngress?: (
    input: Omit<ApplicationMousePointerIngress, "gestureId">,
  ) => ApplicationMousePointerIngress | null;
  /** Exact live generation owner used to fence multi-event pointer/copy gestures. */
  readonly terminalGestureRuntime?: Accessor<TerminalGestureRuntimeIdentity | null>;
  readonly copyFeedback?: Readonly<{ paneId: string; copied: boolean }> | null;
  readonly onOpenLink?: (url: string) => void;
  readonly onCopyText?: (
    text: string,
    evidence: Readonly<{
      semanticPaneId: string;
      bytes: number;
      start: Readonly<{ row: number; col: number }>;
      end: Readonly<{ row: number; col: number }>;
    }>,
  ) => boolean;
  readonly onSelectionCopyOwner?: (copy: (() => boolean) | null) => void;
  readonly onSelectionKeyOwner?: (
    handle: PaneMenuKeyHandler | null,
    ownsInput?: () => boolean,
    beforeTerminalInput?: () => void,
  ) => void;
  readonly onWindowPresented?: (
    semanticWindowId: string,
    paneId: string,
    windowName?: string,
  ) => void;
}

const EMPTY_AGENT_INDICATORS: ReadonlyMap<string, ApplicationTerminalAgentIndicator> = new Map();

const PANE_CONTEXT_MENU_WIDTH = 36;

export const ACTIVE_RESIZE_GUIDE_CELL = Object.freeze({ cols: "╎", rows: "╌" });

/* extracted: pure separator and resize projection lives in application-terminal-workspace-policy */
/**
 * Renderer-only terminal composition. Canonical layout and terminal cells are
 * supplied by the generation host; this component owns no daemon lifecycle,
 * replica reduction, authority queue, or optional tool surface.
 */
export function ApplicationTerminalWorkspace(props: ApplicationTerminalWorkspaceProps) {
  const layout = props.layout;
  const agentIndicators = () => props.agentIndicators?.() ?? EMPTY_AGENT_INDICATORS;
  const topOffset = () => Math.max(1, Math.floor(props.topOffset ?? 2));
  // Immutable layout publications may be fresh objects with identical pane
  // geometry. Retain the frame items so Solid's keyed-by-reference <For>
  // preserves each PaneSurface owner and its canonical subscription.
  const projectedFrames = createMemo(
    () =>
      layout().windows.flatMap((window) =>
        projectOpenTuiPaneFrames(
          window,
          {
            width: props.width,
            height: props.height,
          },
          props.focusedPane,
        ).map((frame) => Object.freeze({ ...frame, visible: window.currentWindow })),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((frame, index) => {
          const candidate = next[index]!;
          return (
            frame.paneId === candidate.paneId &&
            frame.left === candidate.left &&
            frame.top === candidate.top &&
            frame.width === candidate.width &&
            frame.height === candidate.height &&
            frame.contentHeight === candidate.contentHeight &&
            frame.nativeHeight === candidate.nativeHeight &&
            frame.nativeWidth === candidate.nativeWidth &&
            frame.compactPosition === candidate.compactPosition &&
            frame.active === candidate.active &&
            frame.visible === candidate.visible
          );
        }),
    },
  );
  createRenderEffect(() => {
    const adapter = props.adapter;
    const geometries = layout().windows.flatMap(nativePaneGeometries);
    untrack(() => adapter.setNativePaneGeometries?.(geometries));
  });
  const liveViewport = (paneId: string) => {
    const frame = projectedFrames().find((frame) => frame.paneId === paneId);
    const snapshot = props.adapter.paneSelectionSnapshot(paneId);
    return frame && snapshot && props.adapter.renderSource.supportsViewportOrigin
      ? terminalLiveViewportOrigin(snapshot, { cols: frame.width, rows: frame.contentHeight })
      : { x: 0, y: 0 };
  };
  const wheelGesture = createTerminalWheelGesture();
  const scrollback = createTerminalScrollback(
    props.adapter,
    liveViewport,
    (paneId, origin) => {
      const frame = projectedFrames().find((frame) => frame.paneId === paneId);
      const snapshot = props.adapter.paneSelectionSnapshot(paneId);
      return frame && snapshot
        ? clampTerminalViewportOrigin(
            snapshot,
            { cols: frame.width, rows: frame.contentHeight },
            origin,
            snapshot.history.length,
          )
        : origin;
    },
    (paneId) => props.adapter.retainPaneView?.(paneId) ?? null,
  );
  const selectionViewport = (paneId: string, frame: OpenTuiPaneFrame) =>
    props.adapter.renderSource.supportsViewportOrigin
      ? {
          cols: frame.width,
          rows: frame.contentHeight,
          origin: scrollback.origin(paneId) ?? liveViewport(paneId),
        }
      : undefined;
  onCleanup(scrollback.dispose);
  createRenderEffect(() =>
    scrollback.retain(
      new Set(
        layout().windows.flatMap((window) =>
          window.panes.flatMap((pane) => (pane.pane ? [pane.pane] : [])),
        ),
      ),
    ),
  );
  const visibleFrames = createMemo(() => projectedFrames().filter((frame) => frame.visible));
  const retainedWindowIds = createMemo(
    () =>
      Object.freeze(
        layout()
          .windows.map(retainedTerminalWindowKey)
          .filter((id): id is string => id !== null),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length && previous.every((id, index) => id === next[index]),
    },
  );
  const terminalWindowTabs = createMemo<readonly TerminalWindowTab[]>(() =>
    retainedWindowIds().map((windowId, index) => {
      const window = layout().windows.find(
        (candidate) => retainedTerminalWindowKey(candidate) === windowId,
      )!;
      const indicator = terminalWindowAgentIndicator(window, agentIndicators());
      return {
        index,
        name: terminalWindowTitle(window),
        active: window.currentWindow,
        sync: false,
        semanticWindowId: window.semanticWindowId,
        activePaneId: terminalWindowPane(window),
        status: indicator ? terminalAgentStatusLabel(indicator.activity) : undefined,
        attention: indicator?.attention,
      };
    }),
  );
  if (props.onWindowPresented)
    createRenderEffect(() => {
      const current = layout().current;
      const pane = current ? terminalWindowPane(current) : null;
      const semanticWindowId = current?.semanticWindowId ?? current?.windowName;
      const windowName = current?.windowName ?? undefined;
      if (!pane || !semanticWindowId) return;
      try {
        props.onWindowPresented?.(semanticWindowId, pane, windowName);
      } catch {
        // Optional switch diagnostics never own native presentation.
      }
    });
  const retainedPaneIds = createMemo(
    () =>
      Object.freeze(
        projectedFrames()
          .map(({ paneId }) => paneId)
          .sort((left, right) => left.localeCompare(right)),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((paneId, index) => paneId === next[index]),
    },
  );
  const [hoveredSeparator, setHoveredSeparator] = createSignal<ApplicationPaneSeparator | null>(
    null,
  );
  const [resizePreview, setResizePreview] = createSignal<ApplicationPaneResizePreview | null>(null);
  const [pointerSelecting, setPointerSelecting] = createSignal(false);
  const [selection, setSelection] = createSignal<TerminalSelectionRange | null>(null);
  const [committedSelection, setCommittedSelection] = createSignal<Readonly<{
    range: TerminalSelectionRange;
    text: string;
    bytes: number;
    lease: TerminalGestureLease;
  }> | null>(null);
  const [selectModePane, setSelectModePane] = createSignal<string | null>(null);
  const [retainedSelectionPane, setRetainedSelectionPane] = createSignal<string | null>(null);
  const [keyboardCopy, setKeyboardCopy] = createSignal<{
    paneId: string;
    cursor: TerminalCopyCursor;
  } | null>(null);
  const copyModeFor = (paneId: string) =>
    layout().windows.find((window) => window.panes.some((pane) => pane.pane === paneId))?.modeKeys;
  let releaseSelectionView: (() => void) | null = null;
  let selectionViewLease: TerminalGestureLease | null = null;
  const endSelectionView = () => {
    const release = releaseSelectionView;
    releaseSelectionView = null;
    selectionViewLease = null;
    selecting = null;
    setPointerSelecting(false);
    stopSelectionScroll();
    setRetainedSelectionPane(null);
    setKeyboardCopy(null);
    setSelection(null);
    setCommittedSelection(null);
    setSelectModePane(null);
    release?.();
  };
  const retainSelectionView = (paneId: string) => {
    if (retainedSelectionPane() === paneId) return;
    endSelectionView();
    releaseSelectionView = props.adapter.retainPaneView?.(paneId) ?? null;
    if (releaseSelectionView) {
      const frame = projectedFrames().find((frame) => frame.paneId === paneId && frame.visible);
      selectionViewLease = frame ? captureGestureLease(paneId, frame) : null;
      if (selectionViewLease) {
        setRetainedSelectionPane(paneId);
        scrollback.move(paneId, 0);
      } else endSelectionView();
    }
  };
  const paneMenu = createApplicationPaneMenuOwner({
    rendererEpoch: () => props.rendererEpoch,
    paneVisible: (paneId) =>
      props.interactive !== false && visibleFrames().some((frame) => frame.paneId === paneId),
    onAction: (paneId, id, displayName) => {
      if (id === "select-text") {
        retainSelectionView(paneId);
        setSelectModePane(paneId);
        setSelection(null);
        setCommittedSelection(null);
        const mode = copyModeFor(paneId);
        const snapshot = props.adapter.paneSelectionSnapshot(paneId);
        const frame = projectedFrames().find((frame) => frame.paneId === paneId);
        const lease = frame ? captureGestureLease(paneId, frame) : null;
        if (
          mode &&
          snapshot &&
          lease &&
          props.adapter.renderSource.paneCanonicalIdentity?.(paneId)?.viewCols !== undefined
        ) {
          selectionViewLease = lease;
          setRetainedSelectionPane(paneId);
          const origin = scrollback.origin(paneId) ?? liveViewport(paneId);
          setKeyboardCopy({
            paneId,
            cursor: createTerminalCopyCursor(snapshot, mode, {
              ...origin,
              cols: frame!.width,
              rows: frame!.contentHeight,
            }),
          });
          scrollback.move(paneId, 0);
        }
      } else props.onPaneContextAction?.(paneId, id, displayName);
    },
  });
  const paneContextMenu = paneMenu.state;
  let selecting: {
    readonly paneId: string;
    readonly anchor: TerminalSelectionRange["start"];
    readonly frame: OpenTuiPaneFrame;
    readonly lease: TerminalGestureLease;
    readonly unit: "cell" | "word" | "line";
    readonly anchorRange: Readonly<{
      start: TerminalSelectionRange["start"];
      end: TerminalSelectionRange["end"];
    }>;
    pointer: Readonly<{ x: number; y: number }>;
    moved: boolean;
  } | null = null;
  let linkPointer = false;
  let liveReturnPointer = false;
  let lastSelectionClick: {
    paneId: string;
    row: number;
    col: number;
    at: number;
    count: number;
    lease: TerminalGestureLease;
  } | null = null;
  let selectionScrollTimer: ReturnType<typeof setInterval> | null = null;
  const stopSelectionScroll = () => {
    if (selectionScrollTimer) clearInterval(selectionScrollTimer);
    selectionScrollTimer = null;
  };
  let forwardedPointer: {
    readonly paneId: string;
    readonly button: number;
    readonly frame: OpenTuiPaneFrame;
    lease: TerminalGestureLease;
  } | null = null;
  let drag: {
    readonly separator: ApplicationPaneSeparator;
    readonly origin: number;
    preview: ApplicationPaneResizePreview;
    readonly gestureId: string | null;
  } | null = null;

  const terminalPoint = (event: WorkspaceMouseEvent): { x: number; y: number } => ({
    x: event.x - (props.originX ?? 0),
    y: event.y - (props.originY ?? 0) - topOffset(),
  });
  const paneContextMenuWidth = () => Math.max(1, Math.min(PANE_CONTEXT_MENU_WIDTH, props.width));
  const paneContextMenuHeight = () => PANE_ACTION_MENU_ITEMS.length + 4;
  const openPaneContextMenu = (
    paneId: string,
    event: Pick<WorkspaceMouseEvent, "x" | "y">,
  ): void => {
    props.onSelectPane(paneId);
    const pane = layout()
      .windows.flatMap((window) => window.panes)
      .find((item) => item.pane === paneId);
    const localX = event.x - (props.originX ?? 0);
    const localY = event.y - (props.originY ?? 0);
    const width = paneContextMenuWidth();
    const height = paneContextMenuHeight();
    const bottom = topOffset() + props.height;
    paneMenu.open({
      paneId,
      displayName: pane?.displayName?.trim() || paneId,
      left: Math.max(0, Math.min(localX, props.width - width)),
      top: localY + 1 + height <= bottom ? localY + 1 : Math.max(topOffset(), localY - height),
    });
  };
  const globalPreview = (preview: ApplicationPaneResizePreview): ApplicationPaneResizePreview =>
    Object.freeze({
      ...preview,
      globalGuide: Object.freeze({
        ...preview.guide,
        x: preview.guide.x + (props.originX ?? 0),
        y: preview.guide.y + (props.originY ?? 0) + topOffset(),
      }),
    });
  // tmux retains one active pane per window even while that window is hidden.
  // Keep those native terminal surfaces presentation-ready while the host has
  // focus; switching the visible window then changes only composition, not
  // terminal cursor/style state or grid dirtiness. The selected-pane marker
  // remains a separate workspace chrome overlay.
  const terminalSurfaceFocused = (frame: OpenTuiPaneFrame): boolean =>
    (props.rendererFocused ?? props.focusedPane !== null) && frame.active;
  const paneContentAt = (
    point: Readonly<{ x: number; y: number }>,
  ): Readonly<{
    frame: OpenTuiPaneFrame & { readonly visible: boolean };
    col: number;
    row: number;
  }> | null => {
    const frame = visibleFrames().find(
      (candidate) =>
        point.x >= candidate.left &&
        point.x < candidate.left + candidate.width &&
        point.y >= candidate.top + 1 &&
        point.y < candidate.top + 1 + candidate.contentHeight,
    );
    return frame
      ? Object.freeze({
          frame,
          col: point.x - frame.left,
          row: point.y - frame.top - 1,
        })
      : null;
  };
  const clampedPaneCell = (
    frame: OpenTuiPaneFrame,
    snapshot: ReturnType<PaneScopedTerminalAdapter["paneSelectionSnapshot"]>,
    point: Readonly<{ x: number; y: number }>,
  ): Readonly<{ col: number; row: number }> | null => {
    if (!snapshot || snapshot.cols < 1 || snapshot.rows < 1) return null;
    const cols = Math.min(snapshot.cols, frame.width);
    const rows = Math.min(snapshot.rows, frame.contentHeight);
    if (cols < 1 || rows < 1) return null;
    return Object.freeze({
      col: Math.max(0, Math.min(cols - 1, point.x - frame.left)),
      row: Math.max(0, Math.min(rows - 1, point.y - frame.top - 1)),
    });
  };
  const updatePointerSelection = (point: Readonly<{ x: number; y: number }>) => {
    const active = selecting;
    if (!active || !gestureLeaseCurrent(active.lease)) return;
    active.pointer = point;
    const cell = clampedPaneCell(active.frame, active.lease.snapshot, point);
    const head =
      cell &&
      terminalSelectionCell(
        active.lease.snapshot,
        cell.col,
        cell.row,
        scrollback.offset(active.paneId),
        selectionViewport(active.paneId, active.frame),
      );
    if (!head) return;
    active.moved ||= head.row !== active.anchor.row || head.col !== active.anchor.col;
    if (active.moved) lastSelectionClick = null;
    const range = extendTerminalSelectionUnit(
      active.lease.snapshot,
      active.anchorRange,
      head,
      active.unit,
    );
    if (range) setSelection({ paneId: active.paneId, ...range });
  };
  const scheduleSelectionScroll = () => {
    const active = selecting;
    if (
      !active ||
      (active.pointer.y > active.frame.top &&
        active.pointer.y < active.frame.top + active.frame.contentHeight + 1)
    ) {
      stopSelectionScroll();
      return;
    }
    if (selectionScrollTimer) return;
    selectionScrollTimer = setInterval(() => {
      const current = selecting;
      if (!current || !gestureLeaseCurrent(current.lease)) {
        stopSelectionScroll();
        return;
      }
      const direction = current.pointer.y <= current.frame.top ? 1 : -1;
      scrollback.move(current.paneId, direction * 2);
      updatePointerSelection(current.pointer);
    }, 40);
  };
  const captureGestureLease = (
    paneId: string,
    frame: OpenTuiPaneFrame,
  ): TerminalGestureLease | null => {
    const runtime = props.terminalGestureRuntime?.();
    const identity = props.adapter.renderSource.paneCanonicalIdentity?.(paneId);
    const snapshot = props.adapter.paneSelectionSnapshot(paneId);
    if (
      !runtime ||
      runtime.adapter !== props.adapter ||
      runtime.rendererEpoch !== props.rendererEpoch ||
      !identity ||
      !Number.isSafeInteger(identity.historyTrim) ||
      !snapshot ||
      (identity.viewCols ?? identity.cols) !== snapshot.cols ||
      (identity.viewRows ?? identity.rows) !== snapshot.rows
    )
      return null;
    return Object.freeze({
      paneId,
      runtime,
      sourceEpoch: identity.sourceEpoch,
      canonicalIdentity: Object.freeze({ ...identity }),
      snapshot,
      historyLength: snapshot.history.length,
      historyTrim: identity.historyTrim!,
      mouseProtocol: snapshot.modes.mouseProtocol,
      mouseEncoding: snapshot.modes.mouseEncoding,
      frame: Object.freeze({
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
        contentHeight: frame.contentHeight,
      }),
    });
  };
  const gestureLeaseCurrent = (lease: TerminalGestureLease): boolean => {
    const runtime = props.terminalGestureRuntime?.();
    const identity = props.adapter.renderSource.paneCanonicalIdentity?.(lease.paneId);
    const snapshot = props.adapter.paneSelectionSnapshot(lease.paneId);
    const frame = projectedFrames().find(
      ({ paneId, visible }) => paneId === lease.paneId && visible,
    );
    return terminalGestureLeaseMatches(lease, {
      runtime: runtime ?? null,
      identity: identity ?? null,
      snapshot,
      frame: frame ?? null,
    });
  };
  const refreshApplicationMouseLease = (
    lease: TerminalGestureLease,
  ): TerminalGestureLease | null => {
    const frame = projectedFrames().find(
      ({ paneId, visible }) => paneId === lease.paneId && visible,
    );
    const next = frame ? captureGestureLease(lease.paneId, frame) : null;
    return next &&
      next.runtime.daemonGeneration === lease.runtime.daemonGeneration &&
      next.runtime.clientGeneration === lease.runtime.clientGeneration &&
      next.runtime.connection === lease.runtime.connection &&
      next.runtime.client === lease.runtime.client &&
      next.runtime.adapter === lease.runtime.adapter &&
      next.runtime.rendererEpoch === lease.runtime.rendererEpoch &&
      next.sourceEpoch === lease.sourceEpoch &&
      next.canonicalIdentity.generation === lease.canonicalIdentity.generation &&
      next.canonicalIdentity.incarnation === lease.canonicalIdentity.incarnation &&
      next.canonicalIdentity.cols === lease.canonicalIdentity.cols &&
      next.canonicalIdentity.rows === lease.canonicalIdentity.rows &&
      next.historyLength === lease.historyLength &&
      next.historyTrim === lease.historyTrim &&
      next.mouseProtocol === lease.mouseProtocol &&
      next.mouseEncoding === lease.mouseEncoding &&
      next.frame.left === lease.frame.left &&
      next.frame.top === lease.frame.top &&
      next.frame.width === lease.frame.width &&
      next.frame.height === lease.frame.height &&
      next.frame.contentHeight === lease.frame.contentHeight
      ? next
      : null;
  };
  const forwardMouse = (
    lease: TerminalGestureLease,
    action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down",
    cell: Readonly<{ col: number; row: number }>,
    button: number | undefined,
    modifiers: WorkspaceMouseEvent["modifiers"],
    ingress: ApplicationMousePointerIngress | null,
  ): boolean => {
    if (!gestureLeaseCurrent(lease)) return false;
    const snapshot = lease.snapshot;
    if (!terminalMouseActionSupported(snapshot, action)) return false;
    const origin = props.adapter.renderSource.supportsViewportOrigin
      ? terminalLiveViewportOrigin(snapshot, {
          cols: lease.frame.width,
          rows: lease.frame.contentHeight,
        })
      : { x: 0, y: 0 };
    const column = cell.col + origin.x;
    const row = cell.row + origin.y;
    const encoded = terminalMouseInput(
      {
        action,
        column,
        row,
        ...(button === undefined ? {} : { button }),
        ...modifiers,
      },
      snapshot.modes.mouseEncoding,
    );
    if (!encoded) return false;
    props.onTerminalInput?.(lease.paneId, {
      kind: "application-mouse",
      data: encoded.data,
      ...(encoded.kind === "bytes" ? { dataEncoding: "hex" as const } : {}),
      action,
      column,
      row,
      button: button ?? null,
      modifiers: Object.freeze({
        shift: modifiers?.shift === true,
        alt: modifiers?.alt === true,
        ctrl: modifiers?.ctrl === true,
      }),
      ingress,
    });
    return true;
  };
  const copySelection = (): boolean => {
    const keyboard = keyboardCopy();
    if (keyboard) {
      if (
        !selectionViewLease ||
        !gestureLeaseCurrent(selectionViewLease) ||
        !keyboard.cursor.anchor
      )
        return false;
      const copied = extractTerminalCopySelection(
        keyboard.cursor.snapshot,
        keyboard.cursor.anchor,
        keyboard.cursor.position,
        keyboard.cursor.mode,
      );
      return (
        copied !== null &&
        props.onCopyText?.(copied.text, {
          semanticPaneId: keyboard.paneId,
          bytes: copied.bytes,
          start: keyboard.cursor.anchor,
          end: keyboard.cursor.position,
        }) === true
      );
    }
    const committed = committedSelection();
    if (!committed || !gestureLeaseCurrent(committed.lease)) return false;
    return (
      props.onCopyText?.(committed.text, {
        semanticPaneId: committed.range.paneId,
        bytes: committed.bytes,
        start: committed.range.start,
        end: committed.range.end,
      }) === true
    );
  };
  createRenderEffect(() => {
    props.terminalGestureRuntime?.();
    projectedFrames();
    const currentCopy = keyboardCopy();
    const keyMode = currentCopy && copyModeFor(currentCopy.paneId);
    if (currentCopy && keyMode && keyMode !== currentCopy.cursor.mode)
      setKeyboardCopy({
        ...currentCopy,
        cursor: { ...currentCopy.cursor, mode: keyMode, anchor: null },
      });
    for (const paneId of retainedPaneIds()) props.adapter.paneVersion(paneId);
    if (selectionViewLease && !gestureLeaseCurrent(selectionViewLease)) {
      const previous = selectionViewLease;
      const frame = projectedFrames().find(
        (frame) => frame.paneId === previous.paneId && frame.visible,
      );
      const next = frame ? captureGestureLease(previous.paneId, frame) : null;
      // A geometry-only change clears native copy-mode selection, but leaves
      // the frozen backing content and its source identity available to read.
      if (
        next &&
        next.runtime.daemonGeneration === previous.runtime.daemonGeneration &&
        next.runtime.clientGeneration === previous.runtime.clientGeneration &&
        next.runtime.connection === previous.runtime.connection &&
        next.runtime.client === previous.runtime.client &&
        next.runtime.adapter === previous.runtime.adapter &&
        next.runtime.rendererEpoch === previous.runtime.rendererEpoch &&
        next.sourceEpoch === previous.sourceEpoch &&
        next.canonicalIdentity.generation === previous.canonicalIdentity.generation &&
        next.canonicalIdentity.incarnation === previous.canonicalIdentity.incarnation &&
        next.canonicalIdentity.revision === previous.canonicalIdentity.revision &&
        next.canonicalIdentity.stateHash === previous.canonicalIdentity.stateHash
      ) {
        selectionViewLease = next;
        const keyboard = keyboardCopy();
        if (keyboard) {
          const old = keyboard.cursor;
          const mapped = reflowTerminalPosition(
            { ...old.snapshot, modes: { ...old.snapshot.modes, alternateScreen: false } },
            { ...next.snapshot, modes: { ...next.snapshot.modes, alternateScreen: false } },
            { x: old.position.col, y: old.position.row - old.snapshot.history.length },
          );
          const position = mapped
            ? { col: mapped.x, row: mapped.y + next.snapshot.history.length }
            : {
                col: next.snapshot.cursor.x,
                row: next.snapshot.history.length + next.snapshot.cursor.y,
              };
          setKeyboardCopy({
            ...keyboard,
            cursor: { ...old, snapshot: next.snapshot, position, anchor: null },
          });
        }
        selecting = null;
        setPointerSelecting(false);
        stopSelectionScroll();
        setSelection(null);
        setCommittedSelection(null);
      } else endSelectionView();
    }
    if (selecting && !gestureLeaseCurrent(selecting.lease)) endSelectionView();
    if (forwardedPointer) {
      const refreshed = refreshApplicationMouseLease(forwardedPointer.lease);
      if (refreshed) forwardedPointer.lease = refreshed;
      else forwardedPointer = null;
    }
    const committed = committedSelection();
    if (committed && !gestureLeaseCurrent(committed.lease)) endSelectionView();
  });
  props.onSelectionCopyOwner?.(copySelection);
  const handlePaneMenuKey: PaneMenuKeyHandler = (name, event) => {
    if (props.interactive === false) return false;
    if (paneMenu.handleKey(name, event)) return true;
    const focused = props.focusedPane;
    const keyboard = keyboardCopy();
    if (keyboard && keyboard.paneId === focused) {
      if (["f1", "f2", "f5"].includes(name) || (event?.ctrl && name === "q")) return false;
      if (event?.eventType === "release") return true;
      const cancel = () => {
        endSelectionView();
        wheelGesture.reset();
        scrollback.live(keyboard.paneId);
      };
      const mode = keyboard.cursor.mode;
      if (
        (name === "q" && !event?.ctrl && !event?.meta) ||
        (event?.ctrl && name === "c") ||
        (mode === "emacs" && name === "escape")
      ) {
        cancel();
        return true;
      }
      if (
        (mode === "vi" && name === "escape") ||
        (mode === "emacs" && event?.ctrl && name === "g")
      ) {
        setKeyboardCopy({ ...keyboard, cursor: { ...keyboard.cursor, anchor: null } });
        return true;
      }
      if (
        (mode === "vi" && ["enter", "return"].includes(name)) ||
        (mode === "emacs" && event?.ctrl && name === "w")
      ) {
        copySelection();
        cancel();
        return true;
      }
      if ((name === "space" || name === " ") && (mode === "vi" ? !event?.ctrl : event?.ctrl)) {
        setKeyboardCopy({
          ...keyboard,
          cursor: { ...keyboard.cursor, anchor: { ...keyboard.cursor.position } },
        });
        return true;
      }
      const pageDirection =
        name === "pageup" || (mode === "vi" && event?.ctrl && ["b", "u"].includes(name))
          ? -1
          : name === "pagedown" ||
              (mode === "vi" && event?.ctrl && ["f", "d"].includes(name)) ||
              (mode === "emacs" &&
                ((event?.ctrl && name === "v") || (!event?.ctrl && name === "space")))
            ? 1
            : 0;
      if (pageDirection) {
        const frame = visibleFrames().find((frame) => frame.paneId === keyboard.paneId);
        if (frame) {
          const origin = scrollback.origin(keyboard.paneId) ?? liveViewport(keyboard.paneId);
          const half = mode === "vi" && event?.ctrl && ["u", "d"].includes(name);
          const page = pageTerminalCopyCursor(
            keyboard.cursor,
            origin.y,
            frame.contentHeight,
            pageDirection,
            half,
          );
          scrollback.seek(keyboard.paneId, { ...origin, y: page.originY });
          setKeyboardCopy({ ...keyboard, cursor: page.cursor });
        }
        return true;
      }
      let motion: TerminalCopyMotion | undefined;
      if (
        !event?.ctrl &&
        !event?.meta &&
        ["left", "right", "up", "down", "home", "end"].includes(name)
      )
        motion = name as TerminalCopyMotion;
      if (!event?.ctrl && !event?.meta && mode === "vi")
        motion ??= ({ h: "left", j: "down", k: "up", l: "right", "0": "home", $: "end" } as const)[
          name as "h"
        ];
      if (event?.ctrl && mode === "emacs")
        motion ??= ({ b: "left", f: "right", p: "up", n: "down", a: "home", e: "end" } as const)[
          name as "b"
        ];
      if (motion) {
        const cursor = moveTerminalCopyCursor(keyboard.cursor, motion);
        setKeyboardCopy({ ...keyboard, cursor });
        const frame = visibleFrames().find((frame) => frame.paneId === keyboard.paneId);
        if (frame) {
          const origin = scrollback.origin(keyboard.paneId) ?? liveViewport(keyboard.paneId);
          const x = Math.min(cursor.snapshot.cols - 1, cursor.position.col);
          const y = cursor.position.row - cursor.snapshot.history.length;
          scrollback.seek(keyboard.paneId, {
            x: x < origin.x ? x : x >= origin.x + frame.width ? x - frame.width + 1 : origin.x,
            y:
              y < origin.y
                ? y
                : y >= origin.y + frame.contentHeight
                  ? y - frame.contentHeight + 1
                  : origin.y,
          });
        }
      }
      return true;
    }
    if (focused) {
      if (name === "escape" && (retainedSelectionPane() || selectModePane())) {
        const paneId = retainedSelectionPane() ?? selectModePane()!;
        endSelectionView();
        wheelGesture.reset();
        scrollback.live(paneId);
        return true;
      }
      if (
        (retainedSelectionPane() === focused ||
          (scrollback.offset(focused) > 0 &&
            props.adapter.renderSource.paneCanonicalIdentity?.(focused)?.viewCols !== undefined)) &&
        !event?.ctrl &&
        !event?.meta
      ) {
        const page = Math.max(
          1,
          (visibleFrames().find((frame) => frame.paneId === focused)?.contentHeight ?? 10) - 1,
        );
        const delta =
          name === "up"
            ? 1
            : name === "down"
              ? -1
              : name === "pageup"
                ? page
                : name === "pagedown"
                  ? -page
                  : name === "home"
                    ? Infinity
                    : name === "end"
                      ? -Infinity
                      : null;
        if (delta !== null) {
          scrollback.move(focused, delta);
          return true;
        }
      }
      if (event?.shift && (name === "pageup" || name === "pagedown")) {
        scrollback.move(
          focused,
          (name === "pageup" ? 1 : -1) *
            Math.max(
              1,
              (visibleFrames().find((frame) => frame.paneId === focused)?.contentHeight ?? 10) - 1,
            ),
        );
        return true;
      }
      if (name === "escape" && scrollback.offset(focused) > 0) {
        wheelGesture.reset();
        scrollback.live(focused);
        return true;
      }
    }
    if (
      name !== "f10" ||
      !event?.shift ||
      event.ctrl ||
      event.meta ||
      event.repeated ||
      (event.eventType && event.eventType !== "press")
    )
      return false;
    const frame = visibleFrames().find((frame) => frame.paneId === props.focusedPane);
    if (!frame) return false;
    openPaneContextMenu(frame.paneId, {
      x: (props.originX ?? 0) + frame.left + Math.max(0, frame.width - 1),
      y: (props.originY ?? 0) + frame.top + topOffset(),
    });
    return true;
  };
  props.onSelectionKeyOwner?.(
    handlePaneMenuKey,
    () => props.interactive !== false && (paneMenu.ownsInput() || keyboardCopy() !== null),
    () => {
      // Called only after global shortcuts, copy, and local navigation decline
      // the event, immediately before terminal key or paste delivery.
      const paneId = retainedSelectionPane() ?? props.focusedPane;
      wheelGesture.reset();
      endSelectionView();
      if (paneId) scrollback.live(paneId);
    },
  );
  onCleanup(() => {
    endSelectionView();
    props.onSelectionCopyOwner?.(null);
    props.onSelectionKeyOwner?.(null);
  });
  const routePointer = (event: WorkspaceMouseEvent): void => {
    if (event.type === "down") wheelGesture.reset();
    if (paneMenu.ownsInput()) {
      event.stopPropagation?.();
      return;
    }
    const applicationAction =
      event.type === "down"
        ? "down"
        : event.type === "drag"
          ? "drag"
          : event.type === "move" || event.type === "over"
            ? "move"
            : event.type === "up" || event.type === "drag-end" || event.type === "drop"
              ? "up"
              : event.type === "scroll" && event.scroll?.direction === "up"
                ? "wheel-up"
                : event.type === "scroll" && event.scroll?.direction === "down"
                  ? "wheel-down"
                  : null;
    const applicationIngressStart = beginApplicationMouseIngress(
      props.onApplicationMousePointerIngress,
    );
    const applicationIngress = () =>
      applicationAction && applicationIngressStart
        ? applicationIngressStart({
            action: applicationAction,
            x: event.x,
            y: event.y,
          })
        : null;
    const requestedAction =
      event.type === "down"
        ? "down"
        : event.type === "drag"
          ? "drag"
          : event.type === "up" || event.type === "drag-end" || event.type === "drop"
            ? "up"
            : null;
    const resizeIngress = () =>
      requestedAction
        ? (props.onResizePointerIngress?.({
            action: requestedAction,
            x: event.x,
            y: event.y,
            gestureId: drag?.gestureId ?? null,
          }) ?? null)
        : null;
    const point = terminalPoint(event);
    const isRelease = event.type === "up" || event.type === "drag-end" || event.type === "drop";
    if ((linkPointer || liveReturnPointer) && (isRelease || event.type === "drag")) {
      event.stopPropagation?.();
      if (isRelease) {
        linkPointer = false;
        liveReturnPointer = false;
      }
      return;
    }
    if (event.type === "down") {
      linkPointer = false;
      liveReturnPointer = false;
    }
    if (drag) {
      event.stopPropagation?.();
      const ingress = resizeIngress();
      if (event.type === "drag" || isRelease) {
        const pointer = drag.separator.axis === "x" ? point.x : point.y;
        const next = terminalPaneResizePreview(drag.separator, pointer, drag.origin);
        if (next.cells !== drag.preview.cells) {
          drag.preview = Object.freeze({
            ...next,
            ...(ingress ? { pointerIngress: ingress } : {}),
          });
          props.onResizePreview?.(globalPreview(drag.preview));
          setResizePreview(next);
        }
        if (isRelease) {
          const completed = drag.preview;
          const changed = completed.cells !== drag.separator.initialCells;
          drag = null;
          setResizePreview(null);
          setHoveredSeparator(null);
          if (changed)
            props.onResizePane?.(
              globalPreview(
                Object.freeze({
                  ...completed,
                  ...(ingress ? { pointerIngress: ingress } : {}),
                }),
              ),
            );
        }
      }
      return;
    }
    if (event.type === "move" || event.type === "over") {
      const separator = terminalPaneSeparatorAt(
        visibleFrames(),
        layout().current?.paneBorderStatus ?? "off",
        point.x,
        point.y,
      );
      setHoveredSeparator(separator);
      if (separator) {
        event.stopPropagation?.();
        return;
      }
      const hit = paneContentAt(point);
      const snapshot = hit ? props.adapter.paneSelectionSnapshot(hit.frame.paneId) : null;
      if (
        hit &&
        snapshot &&
        scrollback.offset(hit.frame.paneId) === 0 &&
        selectModePane() !== hit.frame.paneId &&
        retainedSelectionPane() !== hit.frame.paneId
      ) {
        const lease = captureGestureLease(hit.frame.paneId, hit.frame);
        if (
          lease &&
          forwardMouse(lease, "move", hit, undefined, event.modifiers, applicationIngress())
        )
          event.stopPropagation?.();
      }
      return;
    }
    if (event.type === "scroll") {
      // A held selection owns the gesture even when the pointer crosses a sibling.
      const activeSelection = selecting;
      const selectionCell =
        activeSelection &&
        clampedPaneCell(activeSelection.frame, activeSelection.lease.snapshot, point);
      const hit =
        activeSelection && selectionCell
          ? { frame: activeSelection.frame, ...selectionCell }
          : paneContentAt(point);
      const before = props.onWheelObservation && hit ? scrollback.offset(hit.frame.paneId) : null;
      const observe = (route: string): void => {
        props.onWheelObservation?.({
          paneId: hit?.frame.paneId ?? null,
          direction: event.scroll?.direction ?? null,
          delta: event.scroll?.delta ?? null,
          shift: event.modifiers?.shift === true,
          alt: event.modifiers?.alt === true,
          ctrl: event.modifiers?.ctrl === true,
          route,
          offsetBefore: before,
          offsetAfter: hit ? scrollback.offset(hit.frame.paneId) : null,
        });
      };
      if (event.scroll?.direction !== "up" && event.scroll?.direction !== "down") {
        observe("unsupported-direction");
        return;
      }
      const snapshot = hit ? props.adapter.paneSelectionSnapshot(hit.frame.paneId) : null;
      const lease = hit ? captureGestureLease(hit.frame.paneId, hit.frame) : null;
      const action = event.scroll?.direction === "up" ? "wheel-up" : "wheel-down";
      if (!hit || !snapshot) {
        wheelGesture.reset();
        observe("missing-pane-or-snapshot");
        return;
      }
      const identity = props.adapter.renderSource.paneCanonicalIdentity?.(hit.frame.paneId);
      const applicationWheel = event.modifiers?.alt === true && !event.modifiers?.shift;
      const motion = wheelGesture.consume(
        JSON.stringify([
          hit.frame.paneId,
          applicationWheel ? "application" : "history",
          identity?.generation,
          identity?.incarnation,
          identity?.sourceEpoch,
        ]),
        action === "wheel-up" ? 1 : -1,
        event.scroll?.delta,
      );
      if (
        hit &&
        snapshot &&
        lease &&
        !motion.local &&
        scrollback.offset(hit.frame.paneId) === 0 &&
        applicationWheel &&
        selectModePane() !== hit.frame.paneId &&
        retainedSelectionPane() !== hit.frame.paneId &&
        forwardMouse(
          lease,
          action,
          hit,
          undefined,
          { ...event.modifiers, alt: false },
          applicationIngress(),
        )
      ) {
        event.stopPropagation?.();
        observe("application");
      } else if (hit && snapshot) {
        wheelGesture.retainLocal();
        event.stopPropagation?.();
        if (motion.lines === 0) {
          observe("local-accumulating");
          return;
        }
        const keyboard = keyboardCopy();
        if (keyboard?.paneId === hit.frame.paneId) {
          const origin = scrollback.origin(hit.frame.paneId) ?? liveViewport(hit.frame.paneId);
          const next = scrollTerminalCopyCursor(
            keyboard.cursor,
            origin.y,
            hit.frame.contentHeight,
            action === "wheel-up" ? -1 : 1,
            Math.abs(motion.lines),
          );
          scrollback.seek(hit.frame.paneId, { ...origin, y: next.originY });
          setKeyboardCopy({ ...keyboard, cursor: next.cursor });
        } else scrollback.move(hit.frame.paneId, motion.lines);
        observe("local-history");
        if (selecting?.paneId === hit.frame.paneId) updatePointerSelection(selecting.pointer);
        else {
          setSelection(null);
          setCommittedSelection(null);
        }
        event.stopPropagation?.();
      }
      return;
    }
    if (event.type === "out") {
      setHoveredSeparator(null);
      return;
    }
    if (event.type === "down" && event.button !== 2) {
      const separator = terminalPaneSeparatorAt(
        visibleFrames(),
        layout().current?.paneBorderStatus ?? "off",
        point.x,
        point.y,
      );
      if (separator) {
        event.stopPropagation?.();
        const ingress = resizeIngress();
        const origin = separator.axis === "x" ? point.x : point.y;
        const preview = terminalPaneResizePreview(separator, origin, origin);
        drag = { separator, origin, preview, gestureId: ingress?.gestureId ?? null };
        setHoveredSeparator(null);
        setResizePreview(preview);
        return;
      }
    }
    {
      if (isRelease && forwardedPointer) {
        event.stopPropagation?.();
        const debt = forwardedPointer;
        forwardedPointer = null;
        const lease = refreshApplicationMouseLease(debt.lease);
        const cell = lease ? clampedPaneCell(debt.frame, lease.snapshot, point) : null;
        if (cell)
          forwardMouse(lease!, "up", cell, debt.button, event.modifiers, applicationIngress());
        return;
      }
      if (isRelease && selecting) {
        event.stopPropagation?.();
        const active = selecting;
        selecting = null;
        setPointerSelecting(false);
        stopSelectionScroll();
        const snapshot = active.lease.snapshot;
        const cell = clampedPaneCell(active.frame, snapshot, point);
        const head =
          gestureLeaseCurrent(active.lease) && cell
            ? terminalSelectionCell(
                snapshot,
                cell.col,
                cell.row,
                scrollback.offset(active.paneId),
                selectionViewport(active.paneId, active.frame),
              )
            : null;
        if (
          !snapshot ||
          !head ||
          (active.unit === "cell" &&
            (!active.moved || (head.row === active.anchor.row && head.col === active.anchor.col)))
        ) {
          endSelectionView();
          return;
        }
        const range = extendTerminalSelectionUnit(snapshot, active.anchorRange, head, active.unit);
        if (!range) {
          endSelectionView();
          return;
        }
        const completed = Object.freeze({ paneId: active.paneId, ...range });
        const copied = extractTerminalSelection(snapshot, completed.start, completed.end);
        setSelection(completed);
        setCommittedSelection(
          copied
            ? Object.freeze({
                range: completed,
                text: copied.text,
                bytes: copied.bytes,
                lease: active.lease,
              })
            : null,
        );
        if (selectModePane() === active.paneId) setSelectModePane(null);
        if (copied)
          props.onCopyText?.(copied.text, {
            semanticPaneId: active.paneId,
            bytes: copied.bytes,
            start: completed.start,
            end: completed.end,
          });
        return;
      }
      if (event.type === "drag" && forwardedPointer) {
        event.stopPropagation?.();
        const debt = forwardedPointer;
        const lease = refreshApplicationMouseLease(debt.lease);
        if (lease) debt.lease = lease;
        const cell = lease ? clampedPaneCell(debt.frame, lease.snapshot, point) : null;
        if (cell)
          forwardMouse(lease!, "drag", cell, debt.button, event.modifiers, applicationIngress());
        return;
      }
      if (event.type === "drag" && selecting) {
        event.stopPropagation?.();
        updatePointerSelection(point);
        scheduleSelectionScroll();
        return;
      }
      const hit = paneContentAt(point);
      if (!hit) return;
      if (
        event.type === "down" &&
        retainedSelectionPane() &&
        retainedSelectionPane() !== hit.frame.paneId
      )
        endSelectionView();
      const snapshot = props.adapter.paneSelectionSnapshot(hit.frame.paneId);
      if (!snapshot) return;
      const lease = captureGestureLease(hit.frame.paneId, hit.frame);
      if (!lease) return;
      if (props.onOpenLink && isTerminalLinkClick(event)) {
        const cell = terminalSelectionCell(
          snapshot,
          hit.col,
          hit.row,
          scrollback.offset(hit.frame.paneId),
          selectionViewport(hit.frame.paneId, hit.frame),
        );
        const url = cell && terminalLinkAt(snapshot, cell);
        if (url) {
          event.stopPropagation?.();
          linkPointer = true;
          lastSelectionClick = null;
          props.onOpenLink(url);
          return;
        }
      }
      const appMouse = terminalMouseActionSupported(snapshot, "down");
      if (event.button === 2 && event.type === "down") {
        event.stopPropagation?.();
        openPaneContextMenu(hit.frame.paneId, event);
        return;
      }
      const localSelection =
        scrollback.offset(hit.frame.paneId) > 0 ||
        selectModePane() === hit.frame.paneId ||
        retainedSelectionPane() === hit.frame.paneId ||
        event.modifiers?.shift === true;
      const forward = appMouse && !localSelection;
      if (event.type === "down") {
        event.stopPropagation?.();
        props.onSelectPane(hit.frame.paneId);
        paneMenu.dismiss();
        if (forward) {
          setSelection(null);
          setCommittedSelection(null);
          if (
            !forwardMouse(lease, "down", hit, event.button, event.modifiers, applicationIngress())
          )
            return;
          forwardedPointer = {
            paneId: hit.frame.paneId,
            button: event.button ?? 0,
            frame: hit.frame,
            lease,
          };
          return;
        }
        setKeyboardCopy(null);
        retainSelectionView(hit.frame.paneId);
        // Retention may synchronously reflow to this client's viewport. Capture
        // the gesture after that transition so its coordinates match the held view.
        const selectionLease = captureGestureLease(hit.frame.paneId, hit.frame);
        if (!selectionLease) {
          endSelectionView();
          return;
        }
        const selectionSnapshot = selectionLease.snapshot;
        const anchor = terminalSelectionCell(
          selectionSnapshot,
          hit.col,
          hit.row,
          scrollback.offset(hit.frame.paneId),
          selectionViewport(hit.frame.paneId, hit.frame),
        );
        if (!anchor) {
          endSelectionView();
          return;
        }
        const now = performance.now();
        const previous = lastSelectionClick;
        const count =
          previous &&
          previous.paneId === hit.frame.paneId &&
          previous.row === anchor.row &&
          previous.col === anchor.col &&
          now - previous.at <= 400 &&
          gestureLeaseCurrent(previous.lease)
            ? (previous.count % 3) + 1
            : 1;
        lastSelectionClick = {
          paneId: hit.frame.paneId,
          row: anchor.row,
          col: anchor.col,
          at: now,
          count,
          lease: selectionLease,
        };
        const unit = count === 3 ? "line" : count === 2 ? "word" : "cell";
        const anchorRange = terminalSelectionUnit(selectionSnapshot, anchor, unit);
        if (!anchorRange) {
          endSelectionView();
          return;
        }
        selecting = {
          paneId: hit.frame.paneId,
          anchor,
          anchorRange,
          unit,
          pointer: point,
          frame: hit.frame,
          lease: selectionLease,
          moved: false,
        };
        setPointerSelecting(true);
        setCommittedSelection(null);
        setSelection({ paneId: hit.frame.paneId, ...anchorRange });
        return;
      }
      return;
    }
  };
  const guide = createMemo(() => {
    const active = resizePreview();
    if (active) return { rect: active.guide, active: true };
    const hovered = hoveredSeparator();
    return hovered
      ? {
          rect: terminalPaneResizePreview(hovered, hovered.position, hovered.position).guide,
          active: false,
        }
      : null;
  });
  const guideCells = createMemo(() => {
    const active = guide();
    if (!active?.active) return Object.freeze([]);
    const axis = resizePreview()?.axis;
    if (!axis) return Object.freeze([]);
    const cells: Array<{ x: number; y: number; marker: string }> = [];
    for (let y = 0; y < active.rect.height; y += 1)
      for (let x = 0; x < active.rect.width; x += 1)
        cells.push({
          x: active.rect.x + x,
          y: active.rect.y + y + topOffset(),
          marker: ACTIVE_RESIZE_GUIDE_CELL[axis],
        });
    return Object.freeze(cells);
  });

  return (
    <>
      <box
        position="absolute"
        left={0}
        top={topOffset()}
        width={props.width}
        height={props.height}
        onMouse={routePointer}
        onMouseDown={routePointer}
        onMouseUp={routePointer}
      />
      <box
        position="absolute"
        left={0}
        top={topOffset() - 1}
        width={props.width}
        height={1}
        backgroundColor={props.theme.roles.surfaces.panel}
        flexDirection="row"
        onMouse={routePointer}
      >
        <Show
          when={layout().windows.length > 0}
          fallback={<text fg={props.theme.roles.text.muted}> no terminal windows </text>}
        >
          <TerminalWindowStrip
            theme={props.theme}
            width={props.width}
            tabs={terminalWindowTabs}
            hoveredIndex={null}
            onActivate={(index) => {
              const pane = terminalWindowTabs()[index]?.activePaneId;
              if (pane) props.onSelectPane(pane);
            }}
            onNewWindow={() => props.onCreateWindow?.()}
          />
        </Show>
      </box>
      <For each={retainedPaneIds()}>
        {(paneId) => {
          const frame = createMemo(
            () => projectedFrames().find((candidate) => candidate.paneId === paneId)!,
          );
          const paneInventory = createMemo(() =>
            layout()
              .windows.flatMap((window) => window.panes)
              .find((pane) => pane.pane === frame().paneId),
          );
          const indicator = createMemo(() => agentIndicators().get(frame().paneId));
          const displayTitle = createMemo(() =>
            terminalPaneDisplayTitle(
              frame().paneId,
              indicator(),
              paneInventory()?.displayName,
              paneInventory()?.displayNameSource,
            ),
          );
          const presentationGeneration = createMemo(() => {
            const currentFrame = frame();
            return [
              props.rendererEpoch,
              currentFrame.paneId,
              currentFrame.visible ? 1 : 0,
              currentFrame.left,
              currentFrame.top,
              currentFrame.width,
              currentFrame.height,
              currentFrame.contentHeight,
            ].join(":");
          });
          return (
            <box
              position="absolute"
              left={frame().left}
              top={frame().top + topOffset()}
              width={frame().width}
              height={frame().height}
              visible={frame().visible}
              backgroundColor={props.theme.roles.surfaces.canvas}
              onMouse={routePointer}
            >
              <PaneTitleBar
                theme={props.theme}
                paneId={frame().paneId}
                title={`${frame().compactPosition ? `Compact ${frame().compactPosition} · Ctrl+O: next · ` : ""}${displayTitle()}${scrollback.offset(frame().paneId) > 0 ? ` ↑${scrollback.offset(frame().paneId)} · Esc: live` : ""}`}
                zoomed={layout().windows.some(
                  (window) =>
                    window.zoomed && window.panes.some((pane) => pane.pane === frame().paneId),
                )}
                onRestoreIntent={() =>
                  props.onPaneContextAction?.(frame().paneId, "zoom-pane", displayTitle())
                }
                width={frame().width}
                selected={props.focusedPane === frame().paneId}
                terminalFocused={terminalSurfaceFocused(frame())}
                keyboardFocused={props.focusedPane === frame().paneId}
                menuOpen={paneContextMenu()?.paneId === frame().paneId}
                interaction={props.paneInteractions?.().get(frame().paneId)}
                activity={indicator()?.activity}
                attention={indicator()?.attention}
                menuAnchor={{
                  x: (props.originX ?? 0) + frame().left + Math.max(0, frame().width - 1),
                  y: (props.originY ?? 0) + frame().top + topOffset(),
                }}
                onSelectIntent={() => props.onSelectPane(frame().paneId)}
                onMenuIntent={(anchor) => openPaneContextMenu(frame().paneId, anchor)}
              />
              <box
                position="absolute"
                left={0}
                top={1}
                width={frame().width}
                height={frame().contentHeight}
              >
                <PaneScopedTerminalSurface
                  adapter={props.adapter}
                  paneId={frame().paneId}
                  width={frame().width}
                  height={frame().contentHeight}
                  defaultFg={props.palette.foreground}
                  defaultBg={props.palette.background}
                  terminalPalette={props.palette}
                  searchHl={props.palette.searchHighlight}
                  searchCur={props.palette.searchCurrent}
                  scrollOffset={scrollback.offset(frame().paneId)}
                  viewportOrigin={scrollback.origin(frame().paneId)}
                  paneFocused={terminalSurfaceFocused(frame())}
                  active={() => frame().visible}
                  presentationGeneration={presentationGeneration()}
                  sourceEpoch={props.rendererEpoch}
                  hostFocusTransitionOwner={props.hostFocusTransitionOwner}
                  copyCursor={
                    keyboardCopy()?.paneId === frame().paneId
                      ? {
                          row: keyboardCopy()!.cursor.position.row,
                          col: Math.min(
                            keyboardCopy()!.cursor.snapshot.cols - 1,
                            keyboardCopy()!.cursor.position.col,
                          ),
                        }
                      : null
                  }
                  selRange={
                    keyboardCopy()?.paneId === frame().paneId && keyboardCopy()!.cursor.anchor
                      ? (() => {
                          const state = keyboardCopy()!.cursor;
                          const ordered = orderCells(state.anchor!, state.position);
                          if (state.mode === "vi") return ordered;
                          const end =
                            ordered.end.col > 0
                              ? { ...ordered.end, col: ordered.end.col - 1 }
                              : { row: ordered.end.row - 1, col: state.snapshot.cols - 1 };
                          return end.row < ordered.start.row ||
                            (end.row === ordered.start.row && end.col < ordered.start.col)
                            ? null
                            : { start: ordered.start, end };
                        })()
                      : selection()?.paneId === frame().paneId
                        ? { start: selection()!.start, end: selection()!.end }
                        : null
                  }
                  search={null}
                />
              </box>
            </box>
          );
        }}
      </For>
      <For
        each={terminalPaneSeparators(visibleFrames(), layout().current?.paneBorderStatus ?? "off")}
      >
        {(separator) => (
          <box
            position="absolute"
            left={separator.axis === "x" ? separator.position : separator.start}
            top={(separator.axis === "x" ? separator.start : separator.position) + topOffset()}
            width={1}
            height={separator.axis === "x" ? Math.max(1, separator.end - separator.start) : 1}
            backgroundColor={props.theme.colors.accentMuted}
            onMouse={routePointer}
            onMouseDown={routePointer}
            onMouseUp={routePointer}
          >
            <Show when={separator.axis === "y"}>
              <text fg={props.theme.roles.text.primary}>↕</text>
            </Show>
          </box>
        )}
      </For>
      <Show when={paneContextMenu()}>
        {(menu) => (
          <PaneActionMenu
            theme={props.theme}
            left={menu().left}
            top={menu().top}
            width={paneContextMenuWidth()}
            viewportWidth={props.width}
            viewportHeight={props.height + topOffset()}
            paneTitle={menu().displayName}
            active
            onDismiss={paneMenu.dismiss}
            selectedId={menu().selectedId}
            closeArmed={menu().closeArmed}
            onHighlight={paneMenu.highlight}
            onActionIntent={paneMenu.activate}
          />
        )}
      </Show>
      <For
        each={[
          ...new Set([
            ...(retainedSelectionPane() || selectModePane()
              ? [retainedSelectionPane() ?? selectModePane()!]
              : []),
            ...visibleFrames()
              .filter((frame) => scrollback.offset(frame.paneId) > 0)
              .map((frame) => frame.paneId),
            ...(props.copyFeedback ? [props.copyFeedback.paneId] : []),
          ]),
        ]}
      >
        {(paneId) => {
          const ownerFrame = createMemo(() =>
            projectedFrames().find((frame) => frame.paneId === paneId),
          );
          const canReturnLive = () =>
            scrollback.offset(paneId) > 0 ||
            retainedSelectionPane() === paneId ||
            selectModePane() === paneId;
          const returnLive = () => {
            if (selecting || !canReturnLive()) return;
            if (
              retainedSelectionPane() === paneId ||
              selectModePane() === paneId ||
              keyboardCopy()?.paneId === paneId
            )
              endSelectionView();
            wheelGesture.reset();
            scrollback.live(paneId);
          };
          return (
            <text
              onMouse={(event) => {
                if (liveReturnPointer && event.type === "up") {
                  liveReturnPointer = false;
                  event.stopPropagation();
                  return;
                }
                if (selecting || !canReturnLive()) return;
                event.stopPropagation();
                if (event.type === "down" && event.button === 0) {
                  liveReturnPointer = true;
                  returnLive();
                }
              }}
              position="absolute"
              right={
                Math.max(
                  0,
                  props.width - ((ownerFrame()?.left ?? 0) + (ownerFrame()?.width ?? 0)),
                ) + ((ownerFrame()?.width ?? 0) < 12 ? 0 : 1)
              }
              top={(ownerFrame()?.top ?? 0) + topOffset()}
              height={1}
              maxWidth={Math.max(
                1,
                (ownerFrame()?.width ?? 1) - ((ownerFrame()?.width ?? 0) < 12 ? 0 : 2),
              )}
              visible={ownerFrame()?.visible ?? false}
              wrapMode="none"
              truncate
              zIndex={20}
              fg={
                props.copyFeedback?.paneId === paneId
                  ? props.copyFeedback.copied
                    ? props.theme.roles.statusTone.success
                    : props.theme.roles.statusTone.danger
                  : props.theme.roles.text.link
              }
              bg={props.theme.roles.surfaces.panel}
            >
              {props.copyFeedback?.paneId === paneId
                ? canReturnLive() && (ownerFrame()?.width ?? 0) < 22
                  ? `${props.copyFeedback.copied ? "✓" : "!"} · Live`
                  : `${props.copyFeedback.copied ? "Copied" : "Copy unavailable"}${canReturnLive() ? ((ownerFrame()?.width ?? 0) < 36 ? " · Live" : " · Back to live") : ""}`
                : keyboardCopy()?.paneId === paneId
                  ? (ownerFrame()?.width ?? 0) >= 75
                    ? ` ⧉ copy ${keyboardCopy()!.cursor.mode} · ${keyboardCopy()!.cursor.mode === "vi" ? "Space select · Enter copy · q live" : "Ctrl+Space select · Ctrl+W copy · Esc live"} · Back to live `
                    : (ownerFrame()?.width ?? 0) < 14
                      ? `copy ${keyboardCopy()!.cursor.mode}`
                      : `copy ${keyboardCopy()!.cursor.mode} · ${(ownerFrame()?.width ?? 0) < 30 ? "Live" : "Back to live"}`
                  : (ownerFrame()?.width ?? 0) < 14
                    ? retainedSelectionPane() === paneId || selectModePane() === paneId
                      ? "select"
                      : "Live"
                    : retainedSelectionPane() === paneId || selectModePane() === paneId
                      ? "select · Back to live"
                      : (ownerFrame()?.width ?? 0) < 30
                        ? "Scrollback · Live"
                        : "Scrollback · Back to live"}
            </text>
          );
        }}
      </For>
      <box
        position="absolute"
        left={guide()?.rect.x ?? 0}
        top={(guide()?.rect.y ?? 0) + topOffset()}
        width={guide()?.rect.width ?? 0}
        height={guide()?.rect.height ?? 0}
        backgroundColor={
          guide()?.active ? props.theme.colors.accent : props.theme.colors.accentMuted
        }
        onMouse={routePointer}
      />
      <For each={guideCells()}>
        {(cell) => (
          <text
            position="absolute"
            left={cell.x}
            top={cell.y}
            width={1}
            height={1}
            zIndex={5}
            selectable={false}
            fg={props.theme.roles.text.primary}
            content={cell.marker}
            onMouse={routePointer}
          />
        )}
      </For>
      <Show when={pointerSelecting()}>
        <box
          position="absolute"
          left={0}
          top={0}
          width={props.width}
          height={props.height + topOffset()}
          zIndex={40}
          onMouse={routePointer}
        />
      </Show>
    </>
  );
}
