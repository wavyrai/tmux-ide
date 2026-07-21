import { terminalDisplayWidth } from "../panel-host.ts";
import { actionChipWidth, iconButtonWidth, type RecipeTone, type Rect } from "../recipes.ts";
import { clipWorkspaceText } from "./text.ts";
import { workspaceIcon, type WorkspaceIconId } from "./icons.ts";

export type PaneFrameVariant = "compact" | "standard" | "wide";
export type PaneFrameKind =
  | "home"
  | "terminals"
  | "files"
  | "diff"
  | "missions"
  | "activity"
  | "preview"
  | "native";

export interface PaneFrameAction {
  id: string;
  label: string;
  compactLabel?: string;
  icon?: WorkspaceIconId;
  description: string;
  active?: boolean;
  disabled?: boolean;
  attention?: boolean;
  pressed?: boolean;
  hidden?: boolean;
}

export interface PaneFrameInput {
  width: number;
  height: number;
  title: string;
  kind: PaneFrameKind;
  subtitle?: string | null;
  focused: boolean;
  terminalFocused?: boolean;
  attention?: boolean;
  dirty?: boolean;
  windowEditSelected?: boolean;
  floating?: boolean;
  maximized?: boolean;
  status?: string | null;
  statusTone?: Exclude<RecipeTone, "neutral" | "accent">;
  actions?: readonly PaneFrameAction[];
  hoveredActionIndex?: number | null;
  pressedActionIndex?: number | null;
}

export interface PaneFrameSpan extends Rect {
  text: string;
}

export interface PaneFrameGripSpan extends PaneFrameSpan {
  kind: "grip";
}

export interface PaneFrameStatusChip {
  kind: "status";
  label: string;
  tone: Exclude<RecipeTone, "neutral" | "accent">;
  start: number;
  width: number;
}

export interface PaneFrameStateChip {
  kind: "state";
  id: "edit" | "float" | "maximized";
  label: string;
  tone: RecipeTone;
  start: number;
  width: number;
}

export interface PaneFrameActionChip extends PaneFrameAction {
  kind: "action";
  appearance: "label" | "icon";
  label: string;
  fullLabel: string;
  start: number;
  width: number;
  hovered: boolean;
  pressed: boolean;
}

export type PaneFrameChip = PaneFrameStatusChip | PaneFrameStateChip | PaneFrameActionChip;

export type PaneFrameBorderStyle = "none" | "single" | "strong";

export interface PaneFrameProjection {
  width: number;
  height: number;
  variant: PaneFrameVariant;
  outer: Rect;
  border: Rect;
  borderStyle: PaneFrameBorderStyle;
  header: Rect;
  body: Rect;
  grip: PaneFrameGripSpan | null;
  titleSpan: PaneFrameSpan;
  subtitleSpan: PaneFrameSpan | null;
  marker: string;
  glyph: string;
  title: string;
  subtitle: string;
  focused: boolean;
  terminalFocused: boolean;
  attention: boolean;
  windowEditSelected: boolean;
  floating: boolean;
  maximized: boolean;
  chips: readonly PaneFrameChip[];
  actions: readonly PaneFrameActionChip[];
}

export type PaneFrameHit =
  | { area: "grip" }
  | { area: "header" }
  | { area: "action"; actionId: string; actionIndex: number }
  | { area: "body" }
  | { area: "border" }
  | null;

const KIND_ICONS: Readonly<Record<PaneFrameKind, WorkspaceIconId>> = {
  home: "home",
  terminals: "terminals",
  files: "files",
  diff: "changes",
  missions: "missions",
  activity: "activity",
  preview: "preview",
  native: "native",
};

const STATUS_GLYPHS: Readonly<Record<Exclude<RecipeTone, "neutral" | "accent">, string>> = {
  blocked: "!",
  working: "●",
  done: "✓",
  idle: "○",
  unknown: "?",
};

export function paneFrameVariant(width: number, height: number): PaneFrameVariant {
  if (width >= 160 && height >= 44) return "wide";
  if (width >= 100 && height >= 28) return "standard";
  return "compact";
}

export function projectPaneFrame(input: PaneFrameInput): PaneFrameProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = paneFrameVariant(width, height);
  const bordered = width >= 8 && height >= 4;
  const inset = bordered ? 1 : 0;
  const innerWidth = Math.max(0, width - inset * 2);
  const innerHeight = Math.max(0, height - inset * 2);
  const headerHeight = Math.min(1, innerHeight);
  const bodyHeight = Math.max(0, innerHeight - headerHeight);
  const header: Rect = { x: inset, y: inset, width: innerWidth, height: headerHeight };
  const body: Rect = { x: inset, y: inset + headerHeight, width: innerWidth, height: bodyHeight };
  const terminalFocused = input.terminalFocused === true;
  const attention = input.attention === true;
  const windowEditSelected = input.windowEditSelected === true;
  const floating = input.floating === true;
  const maximized = input.maximized === true;
  const marker = paneFrameMarker({
    windowEditSelected,
    terminalFocused,
    attention,
    focused: input.focused,
    floating,
  });
  const status = statusChip(input.status, input.statusTone, variant);
  const stateChips = projectStateChips({ windowEditSelected, floating, maximized, variant });
  const actions = (input.actions ?? []).map((action, index) => ({
    ...action,
    kind: "action" as const,
    fullLabel: action.label,
    appearance: action.icon ? ("icon" as const) : ("label" as const),
    label: action.icon
      ? workspaceIcon(action.icon)
      : variant === "compact"
        ? (action.compactLabel ?? action.label)
        : action.label,
    hovered: input.hoveredActionIndex === index,
    pressed: input.pressedActionIndex === index || action.pressed === true,
  }));
  const visible = fitChips(header.width, variant, status, stateChips, actions);
  const chips = positionChips(header.x + header.width, visible);
  const firstChip = chips[0]?.start ?? header.x + header.width;
  const gripText = header.width >= 3 ? "::" : "";
  const grip: PaneFrameGripSpan | null =
    gripText && header.height > 0
      ? { kind: "grip", text: gripText, x: header.x, y: header.y, width: 2, height: 1 }
      : null;
  const titleStart = header.x + (grip ? grip.width + 1 : 0);
  const titleBudget = Math.max(0, firstChip - titleStart - (chips.length > 0 ? 1 : 0));
  const dirty = input.dirty ? " •" : "";
  const kindGlyph = workspaceIcon(KIND_ICONS[input.kind]);
  const titlePrefix = `${marker} ${kindGlyph} `;
  const requestedTitle = `${titlePrefix}${input.title}${dirty}`;
  const showSubtitle = variant !== "compact" && !!input.subtitle;
  const subtitleDividerWidth = showSubtitle ? 3 : 0;
  const subtitlePreferred = showSubtitle ? ` · ${input.subtitle}` : "";
  const titleOnlyBudget = showSubtitle
    ? Math.max(4, Math.floor(titleBudget * (variant === "wide" ? 0.58 : 0.68)))
    : titleBudget;
  const titleText = clipWorkspaceText(requestedTitle, Math.max(0, titleOnlyBudget));
  const titleWidth = terminalDisplayWidth(titleText);
  const subtitleBudget = Math.max(0, titleBudget - titleWidth - subtitleDividerWidth);
  const subtitleText =
    showSubtitle && subtitleBudget > 0
      ? clipWorkspaceText(subtitlePreferred, subtitleBudget + subtitleDividerWidth)
      : "";
  const subtitleSpan =
    subtitleText && titleStart + titleWidth < firstChip
      ? {
          text: subtitleText,
          x: titleStart + titleWidth,
          y: header.y,
          width: terminalDisplayWidth(subtitleText),
          height: 1,
        }
      : null;

  return {
    width,
    height,
    variant,
    outer: { x: 0, y: 0, width, height },
    border: { x: 0, y: 0, width, height },
    borderStyle: bordered ? (windowEditSelected ? "strong" : "single") : "none",
    header,
    body,
    grip,
    titleSpan: {
      text: titleText,
      x: titleStart,
      y: header.y,
      width: titleWidth,
      height: headerHeight,
    },
    subtitleSpan,
    marker,
    glyph: kindGlyph,
    title: titleText,
    subtitle: subtitleText,
    focused: input.focused,
    terminalFocused,
    attention,
    windowEditSelected,
    floating,
    maximized,
    chips,
    actions: chips.filter((chip): chip is PaneFrameActionChip => chip.kind === "action"),
  };
}

function paneFrameMarker(state: {
  windowEditSelected: boolean;
  terminalFocused: boolean;
  attention: boolean;
  focused: boolean;
  floating: boolean;
}): string {
  if (state.windowEditSelected) return "◇";
  if (state.terminalFocused) return "▣";
  if (state.attention) return "!";
  if (state.focused) return "●";
  if (state.floating) return "◌";
  return "○";
}

function statusChip(
  status: string | null | undefined,
  tone: PaneFrameInput["statusTone"],
  variant: PaneFrameVariant,
): Omit<PaneFrameStatusChip, "start" | "width"> | null {
  if (!status) return null;
  const resolvedTone = tone ?? "unknown";
  return {
    kind: "status",
    label: variant === "compact" ? STATUS_GLYPHS[resolvedTone] : status,
    tone: resolvedTone,
  };
}

function projectStateChips(input: {
  windowEditSelected: boolean;
  floating: boolean;
  maximized: boolean;
  variant: PaneFrameVariant;
}): Omit<PaneFrameStateChip, "start" | "width">[] {
  const compact = input.variant === "compact";
  const chips: Omit<PaneFrameStateChip, "start" | "width">[] = [];
  if (input.windowEditSelected) {
    chips.push({ kind: "state", id: "edit", label: compact ? "E" : "edit", tone: "accent" });
  }
  if (input.floating) {
    chips.push({ kind: "state", id: "float", label: compact ? "F" : "float", tone: "neutral" });
  }
  if (input.maximized) {
    chips.push({ kind: "state", id: "maximized", label: compact ? "M" : "max", tone: "accent" });
  }
  return chips;
}

function chipWidth(
  chip:
    | Omit<PaneFrameStatusChip, "start" | "width">
    | Omit<PaneFrameStateChip, "start" | "width">
    | Omit<PaneFrameActionChip, "start" | "width">,
): number {
  return chip.kind === "action"
    ? chip.appearance === "icon"
      ? iconButtonWidth()
      : actionChipWidth(chip.label)
    : terminalDisplayWidth(chip.label) + 2;
}

function fitChips(
  availableWidth: number,
  variant: PaneFrameVariant,
  status: Omit<PaneFrameStatusChip, "start" | "width"> | null,
  stateChips: readonly Omit<PaneFrameStateChip, "start" | "width">[],
  actions: readonly Omit<PaneFrameActionChip, "start" | "width">[],
): (
  | Omit<PaneFrameStatusChip, "start" | "width">
  | Omit<PaneFrameStateChip, "start" | "width">
  | Omit<PaneFrameActionChip, "start" | "width">
)[] {
  const minimumTitle = variant === "compact" ? 8 : variant === "standard" ? 20 : 30;
  const chips: (
    | Omit<PaneFrameStatusChip, "start" | "width">
    | Omit<PaneFrameStateChip, "start" | "width">
    | Omit<PaneFrameActionChip, "start" | "width">
  )[] = [...(status ? [status] : []), ...stateChips, ...actions];
  const fits = () => {
    const widthUsed = chips.reduce((sum, chip) => sum + chipWidth(chip), 0);
    return widthUsed + Math.max(0, chips.length - 1) + minimumTitle <= availableWidth;
  };
  while (chips.length > 0 && !fits()) {
    let lastAction = -1;
    for (let index = chips.length - 1; index >= 0; index -= 1) {
      if (chips[index]?.kind === "action") {
        lastAction = index;
        break;
      }
    }
    if (lastAction >= 0) {
      chips.splice(lastAction, 1);
      continue;
    }
    let lastState = -1;
    for (let index = chips.length - 1; index >= 0; index -= 1) {
      if (chips[index]?.kind === "state") {
        lastState = index;
        break;
      }
    }
    if (lastState >= 0) chips.splice(lastState, 1);
    else chips.pop();
  }
  return chips;
}

function positionChips(
  rightEdge: number,
  chips: readonly (
    | Omit<PaneFrameStatusChip, "start" | "width">
    | Omit<PaneFrameStateChip, "start" | "width">
    | Omit<PaneFrameActionChip, "start" | "width">
  )[],
): PaneFrameChip[] {
  const widths = chips.map(chipWidth);
  const total = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1);
  let x = Math.max(0, rightEdge - total);
  return chips.map((chip, index) => {
    const span = { ...chip, start: x, width: widths[index]! } as PaneFrameChip;
    x += span.width + 1;
    return span;
  });
}

export function paneFrameHitTest(
  projection: PaneFrameProjection,
  x: number,
  y: number,
): PaneFrameHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (cellX < 0 || cellY < 0 || cellX >= projection.width || cellY >= projection.height) {
    return null;
  }
  const actionIndex = projection.actions.findIndex(
    (action) =>
      !action.disabled &&
      cellY === projection.header.y &&
      cellX >= action.start &&
      cellX < action.start + action.width,
  );
  const action = projection.actions[actionIndex];
  if (action) return { area: "action", actionId: action.id, actionIndex };
  if (
    projection.grip &&
    cellX >= projection.grip.x &&
    cellX < projection.grip.x + projection.grip.width &&
    cellY === projection.grip.y
  ) {
    return { area: "grip" };
  }
  if (
    cellX >= projection.header.x &&
    cellX < projection.header.x + projection.header.width &&
    cellY >= projection.header.y &&
    cellY < projection.header.y + projection.header.height
  ) {
    return { area: "header" };
  }
  if (
    cellX >= projection.body.x &&
    cellX < projection.body.x + projection.body.width &&
    cellY >= projection.body.y &&
    cellY < projection.body.y + projection.body.height
  ) {
    return { area: "body" };
  }
  return projection.borderStyle === "none" ? null : { area: "border" };
}
