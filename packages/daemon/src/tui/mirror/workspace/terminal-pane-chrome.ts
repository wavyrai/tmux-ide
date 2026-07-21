import {
  SemanticProductIdSchemaZ,
  type AgentActivity,
  type CanonicalDomainStatus,
  type PaneAttention,
  type PaneVisualStateV1,
  type SemanticProductId,
} from "@tmux-ide/contracts";
import type { PaneFrameActionIntent } from "../../../ui/pane-frame/presenter.tsx";
import { terminalDisplayWidth } from "../panel-host.ts";
import { iconButtonWidth, type RecipeTone, type Rect } from "../recipes.ts";
import type { AgentTerminalCanvasProjection } from "./agent-terminal-canvas.ts";
import {
  paneFrameHitTest,
  projectPaneFrame,
  resolveEffectivePaneFrameActionState,
  type PaneFrameActionChip,
  type PaneFrameHit,
  type PaneFrameProjection,
} from "./pane-frame.ts";
import { clipWorkspaceText } from "./text.ts";
import { workspaceIcon } from "./icons.ts";

export interface TerminalPaneChromePane {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  active: boolean;
  zoomed: boolean;
  /** Optional future SessionMirror descriptor fields. */
  title?: string | null;
  currentCommand?: string | null;
}

export interface TerminalPaneChromeMetadata {
  title?: string | null;
  subtitle?: string | null;
  status?: string | null;
  statusTone?: Exclude<RecipeTone, "neutral" | "accent">;
  attention?: boolean;
  agentActivity?: AgentActivity;
  domainStatus?: CanonicalDomainStatus;
  attentionKind?: PaneAttention;
}

export interface TerminalPaneChromeActionTarget {
  paneId: string;
  actionIndex: number;
}

export interface TerminalPaneChromeHoverTarget {
  paneId: string;
  actionIndex: number | null;
}

export type TerminalPaneChromePlacement =
  | "native-header"
  | "gutter-header"
  | "compact-gutter"
  | "unavailable";

export interface TerminalPaneChromeProjection {
  paneId: string;
  placement: TerminalPaneChromePlacement;
  /** Coordinates in the complete AgentTerminalCanvas. */
  canvasRect: Rect;
  /** Coordinates in the native chrome layer or framebuffer layer. */
  layerRect: Rect;
  layer: "native" | "framebuffer";
  frame: PaneFrameProjection | null;
  diagnostic: string | null;
}

export interface TerminalPaneChromeLayout {
  native: readonly TerminalPaneChromeProjection[];
  framebuffer: readonly TerminalPaneChromeProjection[];
  diagnostics: readonly string[];
}

export interface TerminalPaneChromeInput {
  canvas: AgentTerminalCanvasProjection;
  panes: readonly TerminalPaneChromePane[];
  metadataByPane?: ReadonlyMap<string, TerminalPaneChromeMetadata>;
  hoveredAction?: TerminalPaneChromeHoverTarget | null;
  pressedAction?: TerminalPaneChromeActionTarget | null;
}

export interface TerminalPaneChromeHit {
  paneId: string;
  placement: TerminalPaneChromePlacement;
  hit: Exclude<PaneFrameHit, null>;
}

export type TerminalPaneChromePointerIntent =
  | { kind: "hover"; target: TerminalPaneChromeHoverTarget | null }
  | { kind: "focus"; paneId: string }
  | {
      kind: "action";
      paneId: string;
      actionId: string;
      actionIndex: number;
      semanticIntent: PaneFrameActionIntent;
    }
  | { kind: "menu"; paneId: string }
  | { kind: "settle"; paneId: string }
  | { kind: "consume"; paneId: string }
  | null;

export interface TerminalPaneChromePointerEffects {
  hover(target: TerminalPaneChromeHoverTarget | null): void;
  focus(paneId: string): void;
  action(
    paneId: string,
    actionId: string,
    actionIndex: number,
    semanticIntent: PaneFrameActionIntent,
  ): void;
  menu(paneId: string): void;
  settle(paneId: string): void;
}

export interface TerminalPaneChromeMotionState {
  hovered: TerminalPaneChromeHoverTarget | null;
  pressed: TerminalPaneChromeActionTarget | null;
}

interface Segment {
  start: number;
  end: number;
}

/** Live tmux ids are transport identities, so encode them before crossing the semantic boundary. */
export function terminalPaneSemanticId(paneId: string): SemanticProductId {
  const prefix = "pane.tmux.";
  const encoded =
    Array.from(paneId, (character) => character.codePointAt(0)!.toString(16)).join("-") || "empty";
  const maximumEncodedLength = 128 - prefix.length;
  const hash = stablePaneIdHash(paneId);
  const bounded =
    encoded.length <= maximumEncodedLength
      ? encoded
      : `${encoded.slice(0, maximumEncodedLength - hash.length - 1)}-${hash}`;
  return SemanticProductIdSchemaZ.parse(`${prefix}${bounded}`);
}

function stablePaneIdHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Project one-row pane chrome without changing the tmux framebuffer contract.
 *
 * Top panes share the app-owned row immediately above the framebuffer (after
 * the global window strip). Lower panes reuse only cells in their existing
 * separator row. Every candidate is subtracted against every
 * tmux body rectangle before a frame is emitted, so malformed/nested geometry
 * can degrade but can never cover terminal output.
 */
export function projectTerminalPaneChrome(
  input: TerminalPaneChromeInput,
): TerminalPaneChromeLayout {
  const native: TerminalPaneChromeProjection[] = [];
  const framebuffer: TerminalPaneChromeProjection[] = [];
  const diagnostics: string[] = [];
  const panes = input.panes.map(normalizePane).filter((pane) => pane.width > 0 && pane.height > 0);
  const framebufferRect = input.canvas.framebuffer;

  for (const pane of panes) {
    let placement: TerminalPaneChromePlacement;
    let layer: TerminalPaneChromeProjection["layer"];
    let layerRect: Rect;
    let diagnostic: string | null = null;

    if (pane.top === 0) {
      const start = clamp(pane.left, 0, input.canvas.chrome.width);
      const end = clamp(pane.left + pane.width, start, input.canvas.chrome.width);
      const nativeHeaderY = Math.max(0, input.canvas.chrome.height - 1);
      placement = "native-header";
      layer = "native";
      layerRect = {
        x: start,
        y: nativeHeaderY,
        width: end - start,
        height: end > start && input.canvas.chrome.height > 0 ? 1 : 0,
      };
      if (layerRect.width !== pane.width) {
        diagnostic = `${pane.id}: native header clipped to canvas`;
      }
    } else {
      const row = pane.top - 1;
      const requested: Segment = {
        start: clamp(pane.left, 0, framebufferRect.width),
        end: clamp(pane.left + pane.width, 0, framebufferRect.width),
      };
      const occupied = panes
        .filter((candidate) => row >= candidate.top && row < candidate.top + candidate.height)
        .map((candidate) => ({
          start: clamp(candidate.left, requested.start, requested.end),
          end: clamp(candidate.left + candidate.width, requested.start, requested.end),
        }))
        .filter((segment) => segment.end > segment.start);
      const safe = subtractSegments(requested, occupied).sort(
        (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
      );
      const chosen = safe[0];
      if (!chosen || row < 0 || row >= framebufferRect.height) {
        placement = "unavailable";
        layer = "framebuffer";
        layerRect = { x: 0, y: 0, width: 0, height: 0 };
        diagnostic = `${pane.id}: no non-body cell available for pane chrome`;
      } else {
        const full = chosen.start === requested.start && chosen.end === requested.end;
        placement = full ? "gutter-header" : "compact-gutter";
        layer = "framebuffer";
        layerRect = { x: chosen.start, y: row, width: chosen.end - chosen.start, height: 1 };
        if (!full) diagnostic = `${pane.id}: pane chrome compacted around occupied cells`;
      }
    }

    const canvasRect: Rect = {
      x: layerRect.x + (layer === "native" ? input.canvas.chrome.x : framebufferRect.x),
      y: layerRect.y + (layer === "native" ? input.canvas.chrome.y : framebufferRect.y),
      width: layerRect.width,
      height: layerRect.height,
    };
    const frame =
      placement === "unavailable" || layerRect.width === 0
        ? null
        : paneHeaderFrame(
            pane,
            input.metadataByPane?.get(pane.id),
            layerRect.width,
            input.hoveredAction,
            input.pressedAction,
          );
    const projection: TerminalPaneChromeProjection = {
      paneId: pane.id,
      placement,
      canvasRect,
      layerRect,
      layer,
      frame,
      diagnostic,
    };
    if (diagnostic) diagnostics.push(diagnostic);
    if (layer === "native") native.push(projection);
    else framebuffer.push(projection);
  }

  return { native, framebuffer, diagnostics };
}

export function terminalPaneChromeHitTest(
  layout: TerminalPaneChromeLayout,
  canvasX: number,
  canvasY: number,
): TerminalPaneChromeHit | null {
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null;
  const x = Math.floor(canvasX);
  const y = Math.floor(canvasY);
  for (const projection of [...layout.native, ...layout.framebuffer]) {
    if (!projection.frame || !contains(projection.canvasRect, x, y)) continue;
    const hit = paneFrameHitTest(
      projection.frame,
      x - projection.canvasRect.x,
      y - projection.canvasRect.y,
    );
    if (hit) return { paneId: projection.paneId, placement: projection.placement, hit };
  }
  return null;
}

export function terminalPaneChromeSemanticActionIntent(
  layout: TerminalPaneChromeLayout,
  paneId: string,
  hit: Extract<Exclude<PaneFrameHit, null>, { area: "action" }>,
): PaneFrameActionIntent | null {
  const pane = [...layout.native, ...layout.framebuffer].find(
    (projection) => projection.paneId === paneId,
  );
  const action = pane?.frame?.model.actions.find((candidate) => candidate.id === hit.actionId);
  if (!pane?.frame || !action) return null;
  return {
    kind: "action",
    paneId: pane.frame.model.pane.id,
    actionId: action.id,
    commandId: action.commandId,
  };
}

/** Reverse the renderer-neutral intent into the existing live tmux cell target. */
export function terminalPaneChromeActionTargetForIntent(
  layout: TerminalPaneChromeLayout,
  intent: PaneFrameActionIntent,
): TerminalPaneChromeActionTarget | null {
  for (const pane of [...layout.native, ...layout.framebuffer]) {
    if (pane.frame?.model.pane.id !== intent.paneId) continue;
    const actionIndex = pane.frame.actions.findIndex(
      (action) =>
        action.id === intent.actionId &&
        pane.frame?.model.actions.some(
          (semanticAction) =>
            semanticAction.id === action.id && semanticAction.commandId === intent.commandId,
        ),
    );
    if (actionIndex >= 0) return { paneId: pane.paneId, actionIndex };
  }
  return null;
}

/** Root-owned pointer policy. A chrome cell is always consumed and never PTY-routed. */
export function terminalPaneChromePointerIntent(
  layout: TerminalPaneChromeLayout,
  canvasX: number,
  canvasY: number,
  eventType: string,
  button = 0,
): TerminalPaneChromePointerIntent {
  const result = terminalPaneChromeHitTest(layout, canvasX, canvasY);
  if (!result) return null;
  const gutterPassThrough = result.placement !== "native-header" && result.hit.area !== "action";
  if (eventType === "down" && button === 2) return { kind: "menu", paneId: result.paneId };
  // Passive motion may reveal reserved controls across the whole titlebar,
  // including lower headers that share a tmux resize separator. Press/drag and
  // release on those non-action gutter cells still fall through to tmux.
  if (eventType === "move" || eventType === "over") {
    return {
      kind: "hover",
      target:
        result.hit.area === "action"
          ? { paneId: result.paneId, actionIndex: result.hit.actionIndex }
          : { paneId: result.paneId, actionIndex: null },
    };
  }
  // Lower headers paint the existing resize separator. Only their concrete
  // action chips capture left-pointer input; title/grip cells retain tmux's
  // established separator-resize path.
  if (gutterPassThrough) return null;
  if (isRelease(eventType)) return { kind: "settle", paneId: result.paneId };
  if (eventType === "drag") {
    return {
      kind: "hover",
      target:
        result.hit.area === "action"
          ? { paneId: result.paneId, actionIndex: result.hit.actionIndex }
          : { paneId: result.paneId, actionIndex: null },
    };
  }
  if (eventType === "down" && result.hit.area === "action") {
    const semanticIntent = terminalPaneChromeSemanticActionIntent(
      layout,
      result.paneId,
      result.hit,
    );
    if (!semanticIntent) return { kind: "consume", paneId: result.paneId };
    return {
      kind: "action",
      paneId: result.paneId,
      actionId: result.hit.actionId,
      actionIndex: result.hit.actionIndex,
      semanticIntent,
    };
  }
  if (eventType === "down") return { kind: "focus", paneId: result.paneId };
  return { kind: "consume", paneId: result.paneId };
}

/**
 * Root adapter with an explicit ordering contract: a pane is focused before
 * its action or context menu runs. There is intentionally no PTY forwarding
 * effect in this boundary.
 */
export function dispatchTerminalPaneChromePointerIntent(
  intent: Exclude<TerminalPaneChromePointerIntent, null>,
  effects: TerminalPaneChromePointerEffects,
): void {
  if (intent.kind === "hover") effects.hover(intent.target);
  else if (intent.kind === "focus") effects.focus(intent.paneId);
  else if (intent.kind === "action") {
    effects.focus(intent.paneId);
    effects.action(intent.paneId, intent.actionId, intent.actionIndex, intent.semanticIntent);
  } else if (intent.kind === "menu") {
    effects.focus(intent.paneId);
    effects.menu(intent.paneId);
  } else if (intent.kind === "settle") effects.settle(intent.paneId);
}

/** Motion keeps a pressed visual only while the pointer remains on that action. */
export function terminalPaneChromeMotionState(
  intent: TerminalPaneChromePointerIntent,
  pressed: TerminalPaneChromeActionTarget | null,
): TerminalPaneChromeMotionState {
  const hovered = intent?.kind === "hover" ? intent.target : null;
  return {
    hovered,
    pressed: sameActionTarget(hovered, pressed) ? pressed : null,
  };
}

/** Drop transient action state when its pane dies or Terminals stops being active. */
export function reconcileTerminalPaneChromeActionTarget<T extends { paneId: string }>(
  target: T | null,
  paneIds: ReadonlySet<string>,
  terminalsActive: boolean,
): T | null {
  return target && terminalsActive && paneIds.has(target.paneId) ? target : null;
}

export function terminalPaneChromeOverlapsBodies(
  input: Pick<TerminalPaneChromeInput, "canvas" | "panes">,
  projection: TerminalPaneChromeProjection,
): boolean {
  return input.panes.some((pane) =>
    overlaps(projection.canvasRect, {
      x: input.canvas.framebuffer.x + pane.left,
      y: input.canvas.framebuffer.y + pane.top,
      width: pane.width,
      height: pane.height,
    }),
  );
}

function paneHeaderFrame(
  pane: TerminalPaneChromePane,
  metadata: TerminalPaneChromeMetadata | undefined,
  width: number,
  hovered: TerminalPaneChromeHoverTarget | null | undefined,
  pressed: TerminalPaneChromeActionTarget | null | undefined,
): PaneFrameProjection {
  const title = terminalPaneChromeTitle(pane, metadata);
  const actionsVisible = pane.active || hovered?.paneId === pane.id || pressed?.paneId === pane.id;
  const actions = [
    {
      id: "zoom",
      commandId: "workspace.windowMode.maximize.toggle" as const,
      behavior: "toggle" as const,
      label: pane.zoomed ? "restore" : "zoom",
      compactLabel: pane.zoomed ? "R" : "Z",
      icon: pane.zoomed ? "restore" : "maximize",
      description: pane.zoomed ? "Restore pane layout" : "Zoom this pane",
      active: pane.zoomed,
      hidden: !actionsVisible,
    },
    {
      id: "menu",
      commandId: "workspace.pane.menu.open" as const,
      behavior: "action" as const,
      label: "more",
      compactLabel: ".",
      icon: "more",
      description: "Open pane actions",
      hidden: !actionsVisible,
    },
  ] as const;
  const input = {
    paneId: terminalPaneSemanticId(pane.id),
    width,
    height: 1,
    title,
    kind: "terminals" as const,
    subtitle: metadata?.subtitle ?? pane.id,
    focused: pane.active,
    terminalFocused: pane.active,
    attention: metadata?.attention === true,
    status: metadata?.status,
    statusTone: metadata?.statusTone,
    visualState: terminalPaneVisualState(pane, metadata),
    hoveredActionIndex: hovered?.paneId === pane.id ? hovered.actionIndex : null,
    pressedActionIndex: pressed?.paneId === pane.id ? pressed.actionIndex : null,
    actions,
  };
  const full = projectPaneFrame(input);
  if (
    full.actions.some((action) => action.id === "zoom") &&
    full.actions.some((action) => action.id === "menu")
  )
    return full;

  // PaneFrame's general recipe protects a minimum title/status budget and may
  // remove all actions in very narrow rows. A terminal header has a stricter
  // safety contract: zoom is its guaranteed escape hatch. Build a compact
  // action-first projection, then spend whatever remains on the pane identity.
  const base = projectPaneFrame({ ...input, status: null, actions: [] });
  const zoomNaturalWidth = iconButtonWidth();
  const zoomWidth = Math.min(width, zoomNaturalWidth);
  const menuWidth = iconButtonWidth();
  const minimumIdentityWidth = 2;
  const showMenu = width >= zoomWidth + 1 + menuWidth + minimumIdentityWidth;
  const actionWidth = zoomWidth + (showMenu ? 1 + menuWidth : 0);
  let actionX = Math.max(0, width - actionWidth);
  const projectedActions: PaneFrameActionChip[] = [];
  const pushAction = (index: number, chipWidth: number) => {
    const action = actions[index]!;
    const semanticAction = full.model.actions[index]!;
    const effective = resolveEffectivePaneFrameActionState({
      appearance: full.model.appearance,
      action: semanticAction,
      attention: false,
      hostHovered: hovered?.paneId === pane.id && hovered.actionIndex === index,
      hostPressed: pressed?.paneId === pane.id && pressed.actionIndex === index,
    });
    projectedActions.push({
      ...action,
      kind: "action",
      appearance: "icon",
      label: workspaceIcon(action.icon),
      fullLabel: action.label,
      start: actionX,
      width: chipWidth,
      active: effective.active,
      disabled: effective.disabled,
      attention: effective.attention,
      focused: effective.focused,
      hovered: effective.hovered,
      interactive: effective.interactive,
      loading: effective.loading,
      pressed: effective.pressed,
      state: effective.state,
    });
    actionX += chipWidth + 1;
  };
  pushAction(0, zoomWidth);
  if (showMenu) pushAction(1, menuWidth);

  const identityBudget = projectedActions[0]?.start ?? width;
  const titleText = clipWorkspaceText(title, identityBudget);
  const titleWidth = terminalDisplayWidth(titleText);
  return {
    ...base,
    model: full.model,
    grip: null,
    title: titleText,
    subtitle: "",
    titleSpan: { text: titleText, x: 0, y: 0, width: titleWidth, height: 1 },
    subtitleSpan: null,
    chips: projectedActions,
    actions: projectedActions,
  };
}

function terminalPaneDomainStatus(
  metadata: TerminalPaneChromeMetadata | undefined,
): CanonicalDomainStatus {
  if (metadata?.domainStatus) return metadata.domainStatus;
  if (metadata?.statusTone === "working") return "running";
  if (metadata?.statusTone === "blocked") return "blocked";
  if (metadata?.statusTone === "done") return "done";
  if (metadata?.statusTone === "unknown") return "disconnected";
  return "idle";
}

function terminalPaneAgentActivity(
  metadata: TerminalPaneChromeMetadata | undefined,
  status: CanonicalDomainStatus,
): AgentActivity {
  if (metadata?.agentActivity) return metadata.agentActivity;
  if (status === "running") return "running";
  if (status === "blocked" || status === "review") return "waiting";
  if (status === "done") return "complete";
  if (status === "disconnected") return "disconnected";
  if (status === "recovering") return "running";
  return "idle";
}

function terminalPaneVisualState(
  pane: TerminalPaneChromePane,
  metadata: TerminalPaneChromeMetadata | undefined,
): PaneVisualStateV1 {
  const domainStatus = terminalPaneDomainStatus(metadata);
  return {
    structure: pane.zoomed ? "maximized" : "docked",
    applicationFocus: {
      pane: pane.active,
      terminalInput: pane.active,
      windowActive: true,
    },
    agentActivity: terminalPaneAgentActivity(metadata, domainStatus),
    domainStatus,
    attention:
      metadata?.attentionKind ??
      (metadata?.attention ? (domainStatus === "blocked" ? "warning" : "requested") : "none"),
    layoutInteraction: {
      editable: true,
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
  };
}

export function terminalPaneChromeTitle(
  pane: TerminalPaneChromePane,
  metadata?: TerminalPaneChromeMetadata,
): string {
  const candidates = [metadata?.title, pane.title, pane.currentCommand, pane.id];
  return candidates
    .find((value): value is string => typeof value === "string" && value.trim() !== "")!
    .trim();
}

function normalizePane(pane: TerminalPaneChromePane): TerminalPaneChromePane {
  return {
    ...pane,
    left: cell(pane.left),
    top: cell(pane.top),
    width: cell(pane.width),
    height: cell(pane.height),
  };
}

function subtractSegments(requested: Segment, occupied: readonly Segment[]): Segment[] {
  let safe = requested.end > requested.start ? [requested] : [];
  for (const block of [...occupied].sort((a, b) => a.start - b.start)) {
    safe = safe.flatMap((segment) => {
      if (block.end <= segment.start || block.start >= segment.end) return [segment];
      const parts: Segment[] = [];
      if (block.start > segment.start) parts.push({ start: segment.start, end: block.start });
      if (block.end < segment.end) parts.push({ start: block.end, end: segment.end });
      return parts;
    });
  }
  return safe.filter((segment) => segment.end > segment.start);
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isRelease(eventType: string): boolean {
  return (
    eventType === "up" || eventType === "drag-end" || eventType === "drop" || eventType === "out"
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cell(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function sameActionTarget(
  left: TerminalPaneChromeHoverTarget | null,
  right: TerminalPaneChromeActionTarget | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.paneId === right.paneId &&
      left.actionIndex === right.actionIndex)
  );
}
