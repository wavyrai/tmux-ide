import { terminalDisplayWidth } from "../panel-host.ts";
import { actionChipWidth, type RecipeTone, type Rect } from "../recipes.ts";
import { clipWorkspaceText } from "./text.ts";

export type PaneFrameVariant = "compact" | "standard" | "wide";
export type PaneFrameKind = "home" | "terminals" | "files" | "diff" | "missions" | "preview";

export interface PaneFrameAction {
  id: string;
  label: string;
  compactLabel?: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  attention?: boolean;
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
  status?: string | null;
  statusTone?: Exclude<RecipeTone, "neutral" | "accent">;
  actions?: readonly PaneFrameAction[];
  hoveredActionIndex?: number | null;
}

export interface PaneFrameStatusChip {
  kind: "status";
  label: string;
  tone: Exclude<RecipeTone, "neutral" | "accent">;
  start: number;
  width: number;
}

export interface PaneFrameActionChip extends PaneFrameAction {
  kind: "action";
  start: number;
  width: number;
  hovered: boolean;
}

export type PaneFrameChip = PaneFrameStatusChip | PaneFrameActionChip;

export interface PaneFrameProjection {
  width: number;
  height: number;
  variant: PaneFrameVariant;
  header: Rect;
  body: Rect;
  marker: string;
  glyph: string;
  title: string;
  focused: boolean;
  terminalFocused: boolean;
  attention: boolean;
  chips: readonly PaneFrameChip[];
  actions: readonly PaneFrameActionChip[];
}

export type PaneFrameHit =
  | { area: "header"; actionId?: string; actionIndex?: number }
  | { area: "body" }
  | null;

const KIND_GLYPHS: Readonly<Record<PaneFrameKind, string>> = {
  home: "⌂",
  terminals: "❯",
  files: "▤",
  diff: "±",
  missions: "◆",
  preview: "◫",
};

const STATUS_GLYPHS: Readonly<Record<Exclude<RecipeTone, "neutral" | "accent">, string>> = {
  blocked: "!",
  working: "●",
  done: "✓",
  idle: "○",
  unknown: "?",
};

export function paneFrameVariant(width: number, height: number): PaneFrameVariant {
  if (width >= 120 && height >= 32) return "wide";
  if (width >= 72 && height >= 18) return "standard";
  return "compact";
}

export function projectPaneFrame(input: PaneFrameInput): PaneFrameProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = paneFrameVariant(width, height);
  const headerHeight = Math.min(1, height);
  const status = statusChip(input.status, input.statusTone, variant);
  const actions = (input.actions ?? []).map((action, index) => ({
    ...action,
    kind: "action" as const,
    label: variant === "compact" ? (action.compactLabel ?? action.label) : action.label,
    hovered: input.hoveredActionIndex === index,
  }));
  const visible = fitChips(width, variant, status, actions);
  const chips = positionChips(width, visible);
  const firstChip = chips[0]?.start ?? width;
  const titleBudget = Math.max(0, firstChip - (chips.length > 0 ? 1 : 0));
  const terminalFocused = input.terminalFocused === true;
  const attention = input.attention === true;
  const marker = terminalFocused ? "▣" : attention ? "!" : input.focused ? "●" : "○";
  const dirty = input.dirty ? " •" : "";
  const subtitle = input.subtitle && variant !== "compact" ? ` · ${input.subtitle}` : "";
  const title = clipWorkspaceText(
    ` ${marker} ${KIND_GLYPHS[input.kind]} ${input.title}${dirty}${subtitle}`,
    titleBudget,
  );

  return {
    width,
    height,
    variant,
    header: { x: 0, y: 0, width, height: headerHeight },
    body: { x: 0, y: headerHeight, width, height: Math.max(0, height - headerHeight) },
    marker,
    glyph: KIND_GLYPHS[input.kind],
    title,
    focused: input.focused,
    terminalFocused,
    attention,
    chips,
    actions: chips.filter((chip): chip is PaneFrameActionChip => chip.kind === "action"),
  };
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

function chipWidth(
  chip: Omit<PaneFrameStatusChip, "start" | "width"> | Omit<PaneFrameActionChip, "start" | "width">,
): number {
  return chip.kind === "status"
    ? terminalDisplayWidth(chip.label) + 2
    : actionChipWidth(chip.label);
}

function fitChips(
  width: number,
  variant: PaneFrameVariant,
  status: Omit<PaneFrameStatusChip, "start" | "width"> | null,
  actions: readonly Omit<PaneFrameActionChip, "start" | "width">[],
): (Omit<PaneFrameStatusChip, "start" | "width"> | Omit<PaneFrameActionChip, "start" | "width">)[] {
  const minimumTitle = variant === "compact" ? 8 : variant === "standard" ? 18 : 24;
  const chips: (
    | Omit<PaneFrameStatusChip, "start" | "width">
    | Omit<PaneFrameActionChip, "start" | "width">
  )[] = status ? [status, ...actions] : [...actions];
  const fits = () => {
    const widthUsed = chips.reduce((sum, chip) => sum + chipWidth(chip), 0);
    return widthUsed + Math.max(0, chips.length - 1) + minimumTitle <= width;
  };
  while (chips.length > 0 && !fits()) {
    let lastAction = -1;
    for (let index = chips.length - 1; index >= 0; index -= 1) {
      if (chips[index]?.kind === "action") {
        lastAction = index;
        break;
      }
    }
    if (lastAction >= 0) chips.splice(lastAction, 1);
    else chips.pop();
  }
  return chips;
}

function positionChips(
  width: number,
  chips: readonly (
    | Omit<PaneFrameStatusChip, "start" | "width">
    | Omit<PaneFrameActionChip, "start" | "width">
  )[],
): PaneFrameChip[] {
  const widths = chips.map(chipWidth);
  const total = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1);
  let x = Math.max(0, width - total);
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
  if (cellY < projection.header.height) {
    const actionIndex = projection.actions.findIndex(
      (action) => !action.disabled && cellX >= action.start && cellX < action.start + action.width,
    );
    const action = projection.actions[actionIndex];
    return action ? { area: "header", actionId: action.id, actionIndex } : { area: "header" };
  }
  return { area: "body" };
}
