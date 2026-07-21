import {
  resolvePaneAppearance,
  type CanonicalDomainStatus,
  type CommandId,
  type PaneRoleId,
  type PaneVisualStateV1,
  type SemanticProductId,
  type StatusToneRole,
} from "@tmux-ide/contracts";
import type {
  PaneFrameAction as SemanticPaneFrameAction,
  PaneFrameChip as SemanticPaneFrameChip,
  PaneFrameModel,
  PaneFrameStatus as SemanticPaneFrameStatus,
} from "../../../ui/pane-frame/presenter.tsx";
import {
  resolveEffectivePaneFrameActionState,
  type EffectivePaneFrameActionState,
  type EffectivePaneFrameActionVisualState,
} from "../../../ui/pane-frame/action-state.ts";
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
  commandId?: CommandId;
  behavior?: "action" | "toggle";
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
  /** Stable renderer-neutral identity. Live tmux ids are encoded by their host adapter. */
  paneId?: SemanticProductId;
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
  /** Canonical state wins over every legacy compatibility flag above. */
  visualState?: PaneVisualStateV1;
}

export interface SemanticPaneFrameProjectionInput {
  width: number;
  height: number;
  model: PaneFrameModel;
  dirty?: boolean;
  actionPresentation?: readonly PaneFrameAction[];
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
  id: SemanticProductId;
  label: string;
  tone: Exclude<RecipeTone, "neutral" | "accent">;
  start: number;
  width: number;
}

export interface PaneFrameStateChip {
  kind: "state";
  id: SemanticProductId;
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
  active: boolean;
  disabled: boolean;
  attention: boolean;
  focused: boolean;
  hovered: boolean;
  interactive: boolean;
  loading: boolean;
  pressed: boolean;
  state: EffectivePaneFrameActionVisualState;
}

export type { EffectivePaneFrameActionState, EffectivePaneFrameActionVisualState };
export { resolveEffectivePaneFrameActionState };

export type PaneFrameChip = PaneFrameStatusChip | PaneFrameStateChip | PaneFrameActionChip;

export type PaneFrameBorderStyle = "none" | "single" | "strong";

export interface PaneFrameProjection {
  /** Shared semantic presenter input; all semantic state priority is resolved here. */
  model: PaneFrameModel;
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

const STATUS_GLYPHS: Readonly<Record<Exclude<RecipeTone, "neutral" | "accent">, string>> = {
  blocked: "!",
  working: "●",
  done: "✓",
  idle: "○",
  unknown: "?",
};

const ROLE_BY_KIND: Readonly<Record<PaneFrameKind, PaneRoleId>> = {
  home: "home",
  terminals: "terminal",
  files: "files",
  diff: "changes",
  missions: "missions",
  activity: "activity",
  preview: "preview",
  native: "native",
};

const ICON_BY_ROLE: Readonly<Record<PaneRoleId, WorkspaceIconId>> = {
  home: "home",
  terminal: "terminals",
  files: "files",
  changes: "changes",
  missions: "missions",
  activity: "activity",
  preview: "preview",
  native: "native",
};

function domainStatusForRecipeTone(tone: PaneFrameInput["statusTone"]): CanonicalDomainStatus {
  if (tone === "blocked") return "blocked";
  if (tone === "working") return "running";
  if (tone === "done") return "done";
  if (tone === "unknown") return "disconnected";
  return "idle";
}

function recipeToneForStatus(tone: StatusToneRole | null): RecipeTone {
  if (tone === null) return "neutral";
  if (tone === "warning") return "blocked";
  if (tone === "info") return "working";
  if (tone === "success") return "done";
  if (tone === "danger") return "unknown";
  return "idle";
}

function recipeDomainTone(tone: StatusToneRole): Exclude<RecipeTone, "neutral" | "accent"> {
  const recipeTone = recipeToneForStatus(tone);
  return recipeTone === "neutral" || recipeTone === "accent" ? "idle" : recipeTone;
}

function semanticId(value: string, fallback: string): SemanticProductId {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return (
    normalized && /^[A-Za-z0-9]/u.test(normalized) ? normalized : fallback
  ) as SemanticProductId;
}

function commandIdForAction(action: PaneFrameAction): CommandId {
  if (action.commandId) return action.commandId;
  const suffix =
    action.id
      .trim()
      .replace(/[^A-Za-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "activate";
  return `pane.action.${suffix}` as CommandId;
}

function paneFrameVisualState(input: PaneFrameInput): PaneVisualStateV1 {
  if (input.visualState) return input.visualState;
  const domainStatus = domainStatusForRecipeTone(input.statusTone);
  return {
    structure: input.maximized ? "maximized" : input.floating ? "floating" : "docked",
    applicationFocus: {
      pane: input.focused,
      terminalInput: input.terminalFocused === true,
      windowActive: true,
    },
    agentActivity:
      domainStatus === "running"
        ? "running"
        : domainStatus === "done"
          ? "complete"
          : domainStatus === "blocked"
            ? "waiting"
            : domainStatus === "disconnected"
              ? "disconnected"
              : "idle",
    domainStatus,
    attention:
      input.attention === true ? (domainStatus === "blocked" ? "warning" : "requested") : "none",
    layoutInteraction: {
      editable: true,
      selected: input.windowEditSelected === true,
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

function legacyStateChips(
  input: PaneFrameInput,
  appearance: PaneFrameModel["appearance"],
): SemanticPaneFrameChip[] {
  const chips: SemanticPaneFrameChip[] = [];
  if (appearance.accessibility.layoutSelected) {
    chips.push({ id: "edit", kind: "mode", label: "edit", tone: "info" });
  }
  if (input.visualState ? appearance.structure === "floating" : input.floating === true) {
    chips.push({ id: "float", kind: "state", label: "float", tone: null });
  }
  if (input.visualState ? appearance.structure === "maximized" : input.maximized === true) {
    chips.push({ id: "maximized", kind: "state", label: "max", tone: "info" });
  }
  return chips;
}

/** Compatibility adapter. New hosts should construct the model directly. */
export function paneFrameModel(input: PaneFrameInput): PaneFrameModel {
  const appearance = resolvePaneAppearance(paneFrameVisualState(input));
  const status: SemanticPaneFrameStatus | null = input.status
    ? {
        id: "status.domain",
        label: input.status,
        description: appearance.accessibility.description,
        tone: appearance.status.domainTone,
        busy: appearance.accessibility.busy,
      }
    : null;
  const actions: SemanticPaneFrameAction[] = (input.actions ?? []).map((action) => ({
    id: semanticId(action.id, "action.activate"),
    commandId: commandIdForAction(action),
    behavior: action.behavior ?? "action",
    icon: action.icon ?? "command",
    label: action.label,
    description: action.description,
    available: action.disabled !== true,
    disabledReason: action.disabled ? action.description : null,
    pressed: action.active === true || action.pressed === true,
    busy: false,
  }));
  return {
    pane: {
      id: input.paneId ?? "pane.preview",
      kind: ROLE_BY_KIND[input.kind],
    },
    appearance,
    title: input.title,
    subtitle: input.subtitle ?? null,
    status,
    chips: legacyStateChips(input, appearance),
    actions,
  };
}

function compactChipLabel(chip: SemanticPaneFrameChip): string {
  if (chip.id === "edit") return "E";
  if (chip.id === "float") return "F";
  if (chip.id === "maximized") return "M";
  return clipWorkspaceText(chip.label, 1);
}

export function paneFrameVariant(width: number, height: number): PaneFrameVariant {
  if (width >= 160 && height >= 44) return "wide";
  if (width >= 100 && height >= 28) return "standard";
  return "compact";
}

export function projectPaneFrame(input: PaneFrameInput): PaneFrameProjection {
  const model = paneFrameModel(input);
  return projectSemanticPaneFrame({
    width: input.width,
    height: input.height,
    model,
    dirty: input.dirty,
    actionPresentation: input.actions,
    hoveredActionIndex: input.hoveredActionIndex,
    pressedActionIndex: input.pressedActionIndex,
  });
}

/** Cell geometry for a shared semantic PaneFrame model. */
export function projectSemanticPaneFrame(
  input: SemanticPaneFrameProjectionInput,
): PaneFrameProjection {
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
  const { appearance } = input.model;
  const terminalFocused = appearance.accessibility.terminalInputOwner;
  const attention = appearance.accessibility.hasAttention;
  const windowEditSelected = appearance.accessibility.layoutSelected;
  const floating = appearance.structure === "floating";
  const maximized = appearance.structure === "maximized";
  const marker = paneFrameMarker(appearance);
  const status = statusChip(input.model.status, variant);
  const stateChips = projectStateChips(input.model.chips, variant);
  const presentations = new Map(
    (input.actionPresentation ?? []).map((action) => [action.id, action]),
  );
  const actions = input.model.actions.map((semanticAction, index) => {
    const presentation = presentations.get(semanticAction.id);
    const effective = resolveEffectivePaneFrameActionState({
      appearance,
      action: semanticAction,
      attention: presentation?.attention === true || semanticAction.attention === true,
      hostHovered: input.hoveredActionIndex === index,
      hostPressed: input.pressedActionIndex === index,
    });
    const action: PaneFrameAction = {
      id: semanticAction.id,
      commandId: semanticAction.commandId,
      behavior: semanticAction.behavior,
      label: semanticAction.label,
      compactLabel: presentation?.compactLabel,
      icon: presentation ? presentation.icon : semanticAction.icon,
      description: semanticAction.description ?? semanticAction.label,
      active: effective.active,
      disabled: effective.disabled,
      attention: effective.attention,
      pressed: effective.pressed,
      hidden: presentation?.hidden,
    };
    return {
      ...action,
      kind: "action" as const,
      fullLabel: action.label,
      appearance: action.icon ? ("icon" as const) : ("label" as const),
      label: action.icon
        ? workspaceIcon(action.icon)
        : variant === "compact"
          ? (action.compactLabel ?? action.label)
          : action.label,
      active: effective.active,
      disabled: effective.disabled,
      attention: effective.attention,
      focused: effective.focused,
      hovered: effective.hovered,
      interactive: effective.interactive,
      loading: effective.loading,
      pressed: effective.pressed,
      state: effective.state,
    };
  });
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
  const kindGlyph = workspaceIcon(ICON_BY_ROLE[input.model.pane.kind]);
  const titlePrefix = `${marker} ${kindGlyph} `;
  const requestedTitle = `${titlePrefix}${input.model.title}${dirty}`;
  const showSubtitle = variant !== "compact" && !!input.model.subtitle;
  const subtitleDividerWidth = showSubtitle ? 3 : 0;
  const subtitlePreferred = showSubtitle ? ` · ${input.model.subtitle}` : "";
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
    model: input.model,
    width,
    height,
    variant,
    outer: { x: 0, y: 0, width, height },
    border: { x: 0, y: 0, width, height },
    borderStyle: bordered ? (appearance.outerOutline.visible ? "strong" : "single") : "none",
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
    focused: appearance.accessibility.focused,
    terminalFocused,
    attention,
    windowEditSelected,
    floating,
    maximized,
    chips,
    actions: chips.filter((chip): chip is PaneFrameActionChip => chip.kind === "action"),
  };
}

function paneFrameMarker(appearance: PaneFrameModel["appearance"]): string {
  if (appearance.accessibility.layoutSelected) return "◇";
  if (appearance.accessibility.terminalInputOwner) return "▣";
  if (appearance.accessibility.hasAttention) return "!";
  if (appearance.accessibility.focused) return "●";
  if (appearance.structure === "floating") return "◌";
  return "○";
}

function statusChip(
  status: PaneFrameModel["status"],
  variant: PaneFrameVariant,
): Omit<PaneFrameStatusChip, "start" | "width"> | null {
  if (!status) return null;
  const resolvedTone = recipeDomainTone(status.tone);
  return {
    kind: "status",
    id: status.id,
    label: variant === "compact" ? STATUS_GLYPHS[resolvedTone] : status.label,
    tone: resolvedTone,
  };
}

function projectStateChips(
  chips: readonly SemanticPaneFrameChip[],
  variant: PaneFrameVariant,
): Omit<PaneFrameStateChip, "start" | "width">[] {
  return chips.map((chip) => ({
    kind: "state",
    id: chip.id,
    label: variant === "compact" ? compactChipLabel(chip) : chip.label,
    tone: recipeToneForStatus(chip.tone),
  }));
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
      action.interactive &&
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
