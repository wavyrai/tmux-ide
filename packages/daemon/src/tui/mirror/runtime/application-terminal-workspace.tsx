/* @jsxImportSource @opentui/solid */
import {
  For,
  Show,
  createMemo,
  createRenderEffect,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import type { AgentActivity } from "@tmux-ide/contracts";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import type { SemanticThemeSnapshot, TerminalPaletteProjection } from "../theme.ts";
import type { PaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import { clipTerminal } from "../terminal-text.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { PaneScopedTerminalSurface } from "./pane-scoped-terminal-surface.tsx";
import { projectOpenTuiPaneFrames, type OpenTuiPaneFrame } from "./terminal-layout-projection.ts";
import { MIN_PANE, type ResizeGuideRect } from "../resize-model.ts";
import { nativePaneResizeCells } from "./pane-resize-geometry.ts";
import {
  extractTerminalSelection,
  terminalMouseActionSupported,
  terminalGestureLeaseMatches,
  terminalSelectionCell,
  terminalSgrMouse,
  type TerminalGestureLease,
  type TerminalGestureRuntimeIdentity,
  type TerminalSelectionRange,
} from "./terminal-selection.ts";

type WorkspaceMouseEvent = {
  readonly type: string;
  readonly button?: number;
  readonly x: number;
  readonly y: number;
  readonly modifiers?: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean };
  readonly scroll?: { readonly direction?: "up" | "down" | "left" | "right" };
  stopPropagation?: () => void;
};

export interface ApplicationPaneResizePreview {
  readonly semanticPaneId: string;
  readonly axis: "cols" | "rows";
  readonly cells: number;
  readonly guide: ResizeGuideRect;
  /** Exact renderer-global guide cells after nested shell/canvas projection. */
  readonly globalGuide?: ResizeGuideRect;
  readonly pointerIngress?: ApplicationResizePointerIngress;
}

export interface ApplicationResizePointerIngress {
  readonly gestureId: string;
  readonly traceId: string;
  readonly action: "down" | "drag" | "up";
  readonly x: number;
  readonly y: number;
  readonly atMicros: number;
}

export type ApplicationPaneContextAction =
  | "rename-pane"
  | "split-right"
  | "split-down"
  | "close-pane";

interface ApplicationPaneContextMenuState {
  readonly paneId: string;
  readonly displayName: string;
  readonly left: number;
  readonly top: number;
  readonly selected: number;
  readonly closeArmed: boolean;
}

export interface ApplicationMousePointerIngress {
  readonly gestureId: string;
  readonly action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down";
  readonly x: number;
  readonly y: number;
  readonly atMicros: number;
}

interface ApplicationPaneSeparator {
  readonly axis: "x" | "y";
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly paneId: string;
  readonly initialCells: number;
  readonly siblingCells: number;
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
  readonly onTerminalInput?: (
    paneId: string,
    input:
      | { readonly kind: "text"; readonly data: string }
      | Readonly<{
          kind: "application-mouse";
          data: string;
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
  readonly onSelectionKeyOwner?: (handle: ((name: string) => boolean) | null) => void;
  readonly onWindowPresented?: (
    semanticWindowId: string,
    paneId: string,
    windowName?: string,
  ) => void;
}

export interface ApplicationTerminalAgentIndicator {
  readonly name: string;
  readonly activity: AgentActivity;
  readonly attention: boolean;
}

const EMPTY_AGENT_INDICATORS: ReadonlyMap<string, ApplicationTerminalAgentIndicator> = new Map();

const PANE_CONTEXT_MENU_WIDTH = 30;
const PANE_CONTEXT_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: "select-text" as const, label: "Select text…", shortcut: "Enter" }),
  Object.freeze({ id: "rename-pane" as const, label: "Rename pane…", shortcut: "R" }),
  Object.freeze({ id: "split-right" as const, label: "Split pane right", shortcut: "→" }),
  Object.freeze({ id: "split-down" as const, label: "Split pane down", shortcut: "↓" }),
  Object.freeze({ id: "close-pane" as const, label: "Close pane…", shortcut: "×" }),
]);

const PANE_HEADER_ACTIONS = Object.freeze([
  Object.freeze({ id: "split-right" as const, label: "→" }),
  Object.freeze({ id: "split-down" as const, label: "↓" }),
  Object.freeze({ id: "close-pane" as const, label: "×" }),
  Object.freeze({ id: "menu" as const, label: "⋯" }),
]);

export function applicationPaneHeaderActionCount(width: number): number {
  if (width >= 36) return PANE_HEADER_ACTIONS.length;
  if (width >= 8) return 1;
  return 0;
}

function applicationPaneHeaderActions(
  width: number,
): readonly (typeof PANE_HEADER_ACTIONS)[number][] {
  const count = applicationPaneHeaderActionCount(width);
  if (count === 1) return PANE_HEADER_ACTIONS.slice(-1);
  return PANE_HEADER_ACTIONS.slice(0, count);
}

export function terminalAgentStatusLabel(activity: AgentActivity): string {
  switch (activity) {
    case "running":
      return "WORKING";
    case "waiting":
      return "BLOCKED";
    case "complete":
      return "DONE";
    case "failed":
      return "FAILED";
    case "disconnected":
      return "UNKNOWN";
    case "idle":
      return "IDLE";
  }
}

function labelWithReservedStatus(
  marker: string,
  title: string,
  status: string | null,
  attention: boolean,
  width: number,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (!status) return clipTerminal(`${marker} ${title}`, safeWidth);
  const suffix = `${attention ? " !" : ""} [${status}]`;
  if (safeWidth <= suffix.length + 2) return clipTerminal(`${marker} ${status}`, safeWidth);
  const titleWidth = Math.max(1, safeWidth - marker.length - 1 - suffix.length);
  return clipTerminal(`${marker} ${clipTerminal(title, titleWidth)}${suffix}`, safeWidth);
}

export function terminalPaneChromeLabel(
  paneId: string,
  focused: boolean,
  width: number,
  indicator?: ApplicationTerminalAgentIndicator,
  displayName?: string | null,
  displayNameSource?: "manual" | "agent" | "process" | "title" | "generated" | null,
): string {
  const presentedName = displayName?.trim() || paneId;
  const title = indicator
    ? displayNameSource === "manual" && presentedName !== indicator.name.trim()
      ? `${presentedName} · ${indicator.name.trim()}`
      : indicator.name.trim() || presentedName
    : presentedName;
  return labelWithReservedStatus(
    focused ? "●" : "○",
    title,
    indicator ? terminalAgentStatusLabel(indicator.activity) : null,
    indicator?.attention === true,
    width,
  );
}

export function terminalWindowStripSlotWidth(width: number, windowCount: number): number {
  return Math.max(1, Math.min(32, Math.floor(width / Math.max(1, windowCount))));
}

export function terminalWindowStripLabel(
  title: string,
  active: boolean,
  width: number,
  activity?: AgentActivity,
  attention = false,
): string {
  return labelWithReservedStatus(
    active ? "●" : "○",
    title,
    activity ? terminalAgentStatusLabel(activity) : null,
    attention,
    width,
  );
}

export const ACTIVE_RESIZE_GUIDE_CELL = Object.freeze({ cols: "╎", rows: "╌" });

function titleOf(layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number]): string {
  return layout.windowName ?? layout.semanticWindowId ?? "window";
}

function paneForWindow(layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number]): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

function retainedWindowKey(
  layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string | null {
  return layout.semanticWindowId ?? paneForWindow(layout);
}

const AGENT_ACTIVITY_PRIORITY: Readonly<Record<AgentActivity, number>> = Object.freeze({
  failed: 6,
  waiting: 5,
  running: 4,
  disconnected: 3,
  complete: 2,
  idle: 1,
});

function windowAgentIndicator(
  window: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
  indicators: ReadonlyMap<string, ApplicationTerminalAgentIndicator>,
): Pick<ApplicationTerminalAgentIndicator, "activity" | "attention"> | undefined {
  let selected: AgentActivity | undefined;
  let attention = false;
  for (const pane of window.panes) {
    if (!pane.pane) continue;
    const indicator = indicators.get(pane.pane);
    const activity = indicator?.activity;
    attention ||= indicator?.attention === true;
    if (
      activity &&
      (selected === undefined ||
        AGENT_ACTIVITY_PRIORITY[activity] > AGENT_ACTIVITY_PRIORITY[selected])
    )
      selected = activity;
  }
  return selected ? { activity: selected, attention } : undefined;
}

function separatorAt(
  frames: ReturnType<typeof projectOpenTuiPaneFrames>,
  paneBorderStatus: "top" | "bottom" | "off",
  x: number,
  y: number,
): ApplicationPaneSeparator | null {
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        y >= Math.max(before.top, candidate.top) &&
        y < Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after && x === before.left + before.width) {
      return Object.freeze({
        axis: "x" as const,
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
    }
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        x >= Math.max(before.left, candidate.left) &&
        x < Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (after && y === before.top + before.height) {
      const initialCells = nativePaneResizeCells(before, "rows", paneBorderStatus);
      const siblingCells = nativePaneResizeCells(after, "rows", paneBorderStatus);
      if (initialCells === null || siblingCells === null) return null;
      return Object.freeze({
        axis: "y" as const,
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells,
        siblingCells,
      });
    }
  }
  return null;
}

function separatorsFor(
  frames: ReturnType<typeof projectOpenTuiPaneFrames>,
  paneBorderStatus: "top" | "bottom" | "off",
): readonly ApplicationPaneSeparator[] {
  const separators: ApplicationPaneSeparator[] = [];
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        Math.max(before.top, candidate.top) <
          Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after)
      separators.push({
        axis: "x",
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        Math.max(before.left, candidate.left) <
          Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (!after) continue;
    const initialCells = nativePaneResizeCells(before, "rows", paneBorderStatus);
    const siblingCells = nativePaneResizeCells(after, "rows", paneBorderStatus);
    if (initialCells === null || siblingCells === null) continue;
    separators.push({
      axis: "y",
      position: before.top + before.height,
      start: Math.max(before.left, after.left),
      end: Math.min(before.left + before.width, after.left + after.width),
      paneId: before.paneId,
      initialCells,
      siblingCells,
    });
  }
  return Object.freeze(separators);
}

function previewFor(
  separator: ApplicationPaneSeparator,
  pointer: number,
  origin: number,
): ApplicationPaneResizePreview {
  const total = separator.initialCells + separator.siblingCells;
  const cells = Math.max(
    MIN_PANE,
    Math.min(total - MIN_PANE, separator.initialCells + pointer - origin),
  );
  const delta = cells - separator.initialCells;
  return Object.freeze({
    semanticPaneId: separator.paneId,
    axis: separator.axis === "x" ? "cols" : "rows",
    cells,
    guide:
      separator.axis === "x"
        ? Object.freeze({
            x: separator.position + delta,
            y: separator.start,
            width: 1,
            height: Math.max(1, separator.end - separator.start),
          })
        : Object.freeze({
            x: separator.start,
            y: separator.position + delta,
            width: Math.max(1, separator.end - separator.start),
            height: 1,
          }),
  });
}

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
        projectOpenTuiPaneFrames(window, {
          width: props.width,
          height: props.height,
        }).map((frame) => Object.freeze({ ...frame, visible: window.currentWindow })),
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
            frame.active === candidate.active &&
            frame.visible === candidate.visible
          );
        }),
    },
  );
  const visibleFrames = createMemo(() => projectedFrames().filter((frame) => frame.visible));
  const retainedWindowIds = createMemo(
    () =>
      Object.freeze(
        layout()
          .windows.map(retainedWindowKey)
          .filter((id): id is string => id !== null),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length && previous.every((id, index) => id === next[index]),
    },
  );
  if (props.onWindowPresented)
    createRenderEffect(() => {
      const current = layout().current;
      const pane = current ? paneForWindow(current) : null;
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
  const [selection, setSelection] = createSignal<TerminalSelectionRange | null>(null);
  const [committedSelection, setCommittedSelection] = createSignal<Readonly<{
    range: TerminalSelectionRange;
    text: string;
    bytes: number;
    lease: TerminalGestureLease;
  }> | null>(null);
  const [selectModePane, setSelectModePane] = createSignal<string | null>(null);
  const [paneContextMenu, setPaneContextMenu] =
    createSignal<ApplicationPaneContextMenuState | null>(null);
  let selecting: {
    readonly paneId: string;
    readonly anchor: TerminalSelectionRange["start"];
    readonly frame: OpenTuiPaneFrame;
    readonly lease: TerminalGestureLease;
    moved: boolean;
  } | null = null;
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
  const paneContextMenuHeight = () => PANE_CONTEXT_MENU_ITEMS.length + 3;
  const openPaneContextMenu = (
    paneId: string,
    event: Pick<WorkspaceMouseEvent, "x" | "y">,
    selected = 0,
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
    setPaneContextMenu({
      paneId,
      displayName: pane?.displayName?.trim() || paneId,
      left: Math.max(0, Math.min(localX, props.width - width)),
      top: localY + 1 + height <= bottom ? localY + 1 : Math.max(topOffset(), localY - height),
      selected: Math.max(0, Math.min(PANE_CONTEXT_MENU_ITEMS.length - 1, selected)),
      closeArmed: false,
    });
  };
  const activatePaneContextItem = (index: number): void => {
    const menu = paneContextMenu();
    const item = PANE_CONTEXT_MENU_ITEMS[index];
    if (!menu || !item) return;
    if (item.id === "close-pane" && !menu.closeArmed) {
      setPaneContextMenu({ ...menu, selected: index, closeArmed: true });
      return;
    }
    setPaneContextMenu(null);
    if (item.id === "select-text") {
      setSelectModePane(menu.paneId);
      setSelection(null);
      setCommittedSelection(null);
      return;
    }
    props.onPaneContextAction?.(menu.paneId, item.id, menu.displayName);
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
      identity.cols !== snapshot.cols ||
      identity.rows !== snapshot.rows
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
    const data = terminalSgrMouse({
      action,
      column: cell.col,
      row: cell.row,
      ...(button === undefined ? {} : { button }),
      ...modifiers,
    });
    if (!data) return false;
    props.onTerminalInput?.(lease.paneId, {
      kind: "application-mouse",
      data,
      action,
      column: cell.col,
      row: cell.row,
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
    for (const paneId of retainedPaneIds()) props.adapter.paneVersion(paneId);
    if (selecting && !gestureLeaseCurrent(selecting.lease)) {
      selecting = null;
      setSelection(null);
      setCommittedSelection(null);
      setSelectModePane(null);
    }
    if (forwardedPointer) {
      const refreshed = refreshApplicationMouseLease(forwardedPointer.lease);
      if (refreshed) forwardedPointer.lease = refreshed;
      else forwardedPointer = null;
    }
    const committed = committedSelection();
    if (committed && !gestureLeaseCurrent(committed.lease)) {
      setSelection(null);
      setCommittedSelection(null);
    }
  });
  props.onSelectionCopyOwner?.(copySelection);
  const handleSelectionKey = (name: string): boolean => {
    const menu = paneContextMenu();
    if (!menu) return false;
    if (name === "escape") setPaneContextMenu(null);
    else if (name === "up" || name === "k")
      setPaneContextMenu({
        ...menu,
        selected:
          (menu.selected - 1 + PANE_CONTEXT_MENU_ITEMS.length) % PANE_CONTEXT_MENU_ITEMS.length,
        closeArmed: false,
      });
    else if (name === "down" || name === "j")
      setPaneContextMenu({
        ...menu,
        selected: (menu.selected + 1) % PANE_CONTEXT_MENU_ITEMS.length,
        closeArmed: false,
      });
    else if (name === "return" || name === "enter") activatePaneContextItem(menu.selected);
    else return false;
    return true;
  };
  props.onSelectionKeyOwner?.(handleSelectionKey);
  onCleanup(() => {
    props.onSelectionCopyOwner?.(null);
    props.onSelectionKeyOwner?.(null);
  });
  const routePointer = (event: WorkspaceMouseEvent): void => {
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
    if (drag) {
      event.stopPropagation?.();
      const ingress = resizeIngress();
      if (event.type === "drag" || isRelease) {
        const pointer = drag.separator.axis === "x" ? point.x : point.y;
        const next = previewFor(drag.separator, pointer, drag.origin);
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
      const separator = separatorAt(
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
      if (hit && snapshot && selectModePane() !== hit.frame.paneId) {
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
      if (event.scroll?.direction !== "up" && event.scroll?.direction !== "down") return;
      const hit = paneContentAt(point);
      const snapshot = hit ? props.adapter.paneSelectionSnapshot(hit.frame.paneId) : null;
      const lease = hit ? captureGestureLease(hit.frame.paneId, hit.frame) : null;
      const action = event.scroll?.direction === "up" ? "wheel-up" : "wheel-down";
      if (
        hit &&
        snapshot &&
        lease &&
        selectModePane() !== hit.frame.paneId &&
        forwardMouse(lease, action, hit, undefined, event.modifiers, applicationIngress())
      )
        event.stopPropagation?.();
      return;
    }
    if (event.type === "out") {
      setHoveredSeparator(null);
      return;
    }
    if (event.type === "down" && event.button !== 2) {
      const separator = separatorAt(
        visibleFrames(),
        layout().current?.paneBorderStatus ?? "off",
        point.x,
        point.y,
      );
      if (separator) {
        event.stopPropagation?.();
        const ingress = resizeIngress();
        const origin = separator.axis === "x" ? point.x : point.y;
        const preview = previewFor(separator, origin, origin);
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
        const snapshot = active.lease.snapshot;
        const cell = clampedPaneCell(active.frame, snapshot, point);
        const head =
          gestureLeaseCurrent(active.lease) && cell
            ? terminalSelectionCell(snapshot, cell.col, cell.row)
            : null;
        if (
          !snapshot ||
          !head ||
          !active.moved ||
          (head.row === active.anchor.row && head.col === active.anchor.col)
        ) {
          setSelection(null);
          setCommittedSelection(null);
          return;
        }
        const completed = Object.freeze({ paneId: active.paneId, start: active.anchor, end: head });
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
        const active = selecting;
        const snapshot = active.lease.snapshot;
        const cell = clampedPaneCell(active.frame, snapshot, point);
        const head =
          gestureLeaseCurrent(active.lease) && cell
            ? terminalSelectionCell(snapshot, cell.col, cell.row)
            : null;
        if (head) {
          active.moved ||= head.row !== active.anchor.row || head.col !== active.anchor.col;
          setSelection({ paneId: active.paneId, start: active.anchor, end: head });
        }
        return;
      }
      const hit = paneContentAt(point);
      if (!hit) return;
      const snapshot = props.adapter.paneSelectionSnapshot(hit.frame.paneId);
      if (!snapshot) return;
      const lease = captureGestureLease(hit.frame.paneId, hit.frame);
      if (!lease) return;
      const appMouse = terminalMouseActionSupported(snapshot, "down");
      if (event.button === 2 && event.type === "down") {
        event.stopPropagation?.();
        openPaneContextMenu(hit.frame.paneId, event);
        return;
      }
      const localSelection =
        selectModePane() === hit.frame.paneId || event.modifiers?.shift === true;
      const forward = appMouse && !localSelection;
      if (event.type === "down") {
        event.stopPropagation?.();
        props.onSelectPane(hit.frame.paneId);
        setPaneContextMenu(null);
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
        const anchor = terminalSelectionCell(snapshot, hit.col, hit.row);
        if (!anchor) return;
        selecting = {
          paneId: hit.frame.paneId,
          anchor,
          frame: hit.frame,
          lease,
          moved: false,
        };
        setCommittedSelection(null);
        setSelection({ paneId: hit.frame.paneId, start: anchor, end: anchor });
        return;
      }
      if (event.type === "drag" && selecting?.paneId === hit.frame.paneId) {
        event.stopPropagation?.();
        const head = terminalSelectionCell(snapshot, hit.col, hit.row);
        if (head) {
          selecting.moved ||=
            head.row !== selecting.anchor.row || head.col !== selecting.anchor.col;
          setSelection({ paneId: hit.frame.paneId, start: selecting.anchor, end: head });
        }
        return;
      }
      if (event.type === "drag" && forwardedPointer?.paneId === hit.frame.paneId) {
        event.stopPropagation?.();
        forwardMouse(
          forwardedPointer.lease,
          "drag",
          hit,
          forwardedPointer.button,
          event.modifiers,
          applicationIngress(),
        );
      }
      return;
    }
  };
  const guide = createMemo(() => {
    const active = resizePreview();
    if (active) return { rect: active.guide, active: true };
    const hovered = hoveredSeparator();
    return hovered
      ? { rect: previewFor(hovered, hovered.position, hovered.position).guide, active: false }
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
          <For each={retainedWindowIds()}>
            {(windowId) => {
              const window = createMemo(
                () =>
                  layout().windows.find((candidate) => retainedWindowKey(candidate) === windowId)!,
              );
              const indicator = createMemo(() => windowAgentIndicator(window(), agentIndicators()));
              return (
                <text
                  width={terminalWindowStripSlotWidth(props.width, retainedWindowIds().length)}
                  height={1}
                  fg={
                    window().currentWindow
                      ? props.theme.roles.text.link
                      : props.theme.roles.text.secondary
                  }
                  onMouseDown={() => {
                    const pane = paneForWindow(window());
                    if (pane) props.onSelectPane(pane);
                  }}
                >
                  <Show
                    when={window().currentWindow}
                    fallback={terminalWindowStripLabel(
                      titleOf(window()),
                      false,
                      terminalWindowStripSlotWidth(props.width, retainedWindowIds().length),
                      indicator()?.activity,
                      indicator()?.attention,
                    )}
                  >
                    <strong>
                      {terminalWindowStripLabel(
                        titleOf(window()),
                        true,
                        terminalWindowStripSlotWidth(props.width, retainedWindowIds().length),
                        indicator()?.activity,
                        indicator()?.attention,
                      )}
                    </strong>
                  </Show>
                </text>
              );
            }}
          </For>
        </Show>
        <text
          position="absolute"
          right={0}
          top={0}
          width={4}
          height={1}
          zIndex={4}
          content=" [+]"
          fg={props.theme.roles.text.link}
          bg={props.theme.roles.surfaces.panel}
          onMouseDown={(event) => {
            event.stopPropagation();
            props.onCreateWindow?.();
          }}
        />
      </box>
      <For each={retainedPaneIds()}>
        {(paneId) => {
          const frame = createMemo(
            () => projectedFrames().find((candidate) => candidate.paneId === paneId)!,
          );
          const headerActions = createMemo(() => applicationPaneHeaderActions(frame().width));
          const headerActionsWidth = createMemo(() => headerActions().length * 3);
          const headerTitleWidth = createMemo(() =>
            Math.max(1, frame().width - headerActionsWidth()),
          );
          const headerActionsLabel = createMemo(
            () =>
              headerActions()
                .map((action) => `[${action.label}]`)
                .join("") || " ",
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
              <box
                position="absolute"
                left={0}
                top={0}
                width={frame().width}
                height={1}
                zIndex={2}
                backgroundColor={props.theme.roles.surfaces.command}
                onMouseDown={(event) => {
                  if (event.button === 2) {
                    event.stopPropagation();
                    openPaneContextMenu(frame().paneId, event);
                    return;
                  }
                  props.onSelectPane(frame().paneId);
                }}
              >
                <text
                  width={headerTitleWidth()}
                  height={1}
                  overflow="hidden"
                  content={terminalPaneChromeLabel(
                    frame().paneId,
                    props.focusedPane === frame().paneId,
                    headerTitleWidth(),
                    agentIndicators().get(frame().paneId),
                    layout()
                      .windows.flatMap((window) => window.panes)
                      .find((pane) => pane.pane === frame().paneId)?.displayName,
                    layout()
                      .windows.flatMap((window) => window.panes)
                      .find((pane) => pane.pane === frame().paneId)?.displayNameSource,
                  )}
                  fg={
                    props.focusedPane === frame().paneId
                      ? props.theme.roles.text.link
                      : props.theme.roles.text.secondary
                  }
                />
                <text
                  position="absolute"
                  right={0}
                  top={0}
                  width={Math.max(1, headerActionsWidth())}
                  height={1}
                  zIndex={4}
                  content={headerActionsLabel()}
                  fg={props.theme.roles.text.link}
                  bg={props.theme.roles.surfaces.command}
                  onMouseDown={(event) => {
                    event.stopPropagation();
                    openPaneContextMenu(frame().paneId, event);
                  }}
                />
              </box>
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
                  scrollOffset={0}
                  paneFocused={terminalSurfaceFocused(frame())}
                  active={() => frame().visible}
                  presentationGeneration={presentationGeneration()}
                  sourceEpoch={props.rendererEpoch}
                  hostFocusTransitionOwner={props.hostFocusTransitionOwner}
                  selRange={
                    selection()?.paneId === frame().paneId
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
      {/* PaneSurface is a native renderable. Keep the one-cell focus marker as
          a workspace-level overlay so its framebuffer cell cannot be cleared
          by native child composition at the frame origin. */}
      <For each={retainedPaneIds()}>
        {(paneId) => {
          const frame = createMemo(
            () => projectedFrames().find((candidate) => candidate.paneId === paneId)!,
          );
          return (
            <text
              position="absolute"
              left={frame().left}
              top={frame().top + topOffset()}
              visible={frame().visible}
              zIndex={3}
              selectable={false}
              onMouseDown={() => props.onSelectPane(frame().paneId)}
              fg={
                props.focusedPane === frame().paneId
                  ? props.theme.roles.text.link
                  : props.theme.roles.text.secondary
              }
            >
              {props.focusedPane === frame().paneId ? "●" : "○"}
            </text>
          );
        }}
      </For>
      <For each={separatorsFor(visibleFrames(), layout().current?.paneBorderStatus ?? "off")}>
        {(separator) => (
          <box
            position="absolute"
            left={separator.axis === "x" ? separator.position : separator.start}
            top={(separator.axis === "x" ? separator.start : separator.position) + topOffset()}
            width={separator.axis === "x" ? 1 : Math.max(1, separator.end - separator.start)}
            height={separator.axis === "x" ? Math.max(1, separator.end - separator.start) : 1}
            backgroundColor={props.theme.colors.accentMuted}
            onMouse={routePointer}
            onMouseDown={routePointer}
            onMouseUp={routePointer}
          />
        )}
      </For>
      <For each={paneContextMenu() ? [paneContextMenu()!] : []}>
        {(menu) => (
          <box
            position="absolute"
            left={menu.left}
            top={menu.top}
            width={paneContextMenuWidth()}
            height={paneContextMenuHeight()}
            zIndex={20}
            border
            borderStyle="rounded"
            borderColor={props.theme.roles.borders.focused}
            backgroundColor={props.theme.roles.surfaces.panelRaised}
            flexDirection="column"
            overflow="hidden"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <text
              height={1}
              fg={props.theme.roles.text.primary}
              content={clipTerminal(` ${menu.displayName}`, paneContextMenuWidth() - 2)}
            />
            <For each={PANE_CONTEXT_MENU_ITEMS}>
              {(item, index) => {
                const selected = () => paneContextMenu()?.selected === index();
                const closeArmed = () =>
                  item.id === "close-pane" && paneContextMenu()?.closeArmed === true;
                const label = () =>
                  closeArmed()
                    ? "Confirm close pane"
                    : `${item.label}${" ".repeat(
                        Math.max(
                          1,
                          paneContextMenuWidth() - item.label.length - item.shortcut.length - 4,
                        ),
                      )}${item.shortcut}`;
                return (
                  <text
                    height={1}
                    width={Math.max(1, paneContextMenuWidth() - 2)}
                    overflow="hidden"
                    content={`${selected() ? "›" : " "} ${label()}`}
                    fg={
                      closeArmed()
                        ? props.theme.roles.statusTone.warning
                        : selected()
                          ? props.theme.roles.selection.selectionText
                          : props.theme.roles.text.secondary
                    }
                    bg={
                      selected()
                        ? props.theme.roles.selection.selection
                        : props.theme.roles.surfaces.panelRaised
                    }
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      activatePaneContextItem(index());
                    }}
                  />
                );
              }}
            </For>
          </box>
        )}
      </For>
      <Show when={selectModePane()}>
        <text
          position="absolute"
          right={1}
          top={topOffset()}
          zIndex={20}
          fg={props.theme.roles.text.link}
        >
          {" ⧉ select "}
        </text>
      </Show>
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
    </>
  );
}
