import { terminalDisplayWidth } from "../panel-host.ts";
import type { Rect } from "../recipes.ts";
import { workspaceIcon, type WorkspaceIconId } from "./icons.ts";
import { clipWorkspaceText } from "./text.ts";

export type CommandPaletteVariant = "compact" | "standard" | "wide";
export type CommandPalettePhase = "ready" | "loading" | "error";

/**
 * Data-only contribution consumed by the command palette. Execution and input
 * policy stay with the root command controller; this descriptor is safe to
 * persist, rank, filter, and project without importing OpenTUI.
 */
export interface CommandPaletteDescriptor {
  id: string;
  icon: WorkspaceIconId;
  label: string;
  description?: string;
  detail?: string;
  /**
   * Optional presentation group. `category` remains the command's semantic
   * category (Files, Window, …), while adapters can preserve ranked sections
   * such as Recent/Suggested without lying about command semantics.
   */
  group?: string;
  category: string;
  shortcut?: string | null;
  status?: string | null;
  disabledReason?: string | null;
  current?: boolean;
}

export interface CommandPaletteInput {
  width: number;
  height: number;
  query: string;
  commands: readonly CommandPaletteDescriptor[];
  selectedCommandId?: string | null;
  phase?: CommandPalettePhase;
  errorMessage?: string | null;
  retryCommandId?: string;
  scrollTop?: number;
  title?: string;
  queryPlaceholder?: string;
}

export interface CommandPaletteTextSpan extends Rect {
  text: string;
}

export interface CommandPaletteGroupRow {
  kind: "group";
  id: string;
  category: string;
  rect: Rect;
  labelSpan: CommandPaletteTextSpan;
}

export interface CommandPaletteCommandRow {
  kind: "command";
  id: string;
  commandId: string;
  iconId: WorkspaceIconId;
  icon: string;
  label: string;
  detail: string;
  category: string;
  shortcut: string;
  status: string;
  disabledReason: string;
  current: boolean;
  selected: boolean;
  disabled: boolean;
  rect: Rect;
  markerSpan: CommandPaletteTextSpan;
  iconSpan: CommandPaletteTextSpan;
  labelSpan: CommandPaletteTextSpan;
  detailSpan: CommandPaletteTextSpan | null;
  trailingSpan: CommandPaletteTextSpan | null;
}

export type CommandPaletteStateKind = "loading" | "empty" | "no-match" | "error" | "retry";

export interface CommandPaletteStateRow {
  kind: "state";
  id: string;
  state: CommandPaletteStateKind;
  rect: Rect;
  icon: string;
  title: string;
  detail: string;
  selected: boolean;
  actionable: boolean;
  labelSpan: CommandPaletteTextSpan;
  detailSpan: CommandPaletteTextSpan | null;
}

export type CommandPaletteRow =
  | CommandPaletteGroupRow
  | CommandPaletteCommandRow
  | CommandPaletteStateRow;

export interface CommandPaletteProjection {
  width: number;
  height: number;
  variant: CommandPaletteVariant;
  phase: CommandPalettePhase;
  overlay: Rect;
  bordered: boolean;
  header: Rect;
  query: Rect;
  divider: Rect;
  list: Rect;
  footer: Rect;
  title: string;
  queryText: string;
  queryPlaceholder: string;
  commandCount: number;
  contentRowCount: number;
  scrollTop: number;
  visibleStart: number;
  visibleEnd: number;
  rows: readonly CommandPaletteRow[];
  rowIds: readonly string[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  retryCommandId: string;
}

export type CommandPaletteHit =
  | { kind: "command"; commandId: string; disabled: boolean }
  | { kind: "retry"; commandId: string }
  | { kind: "query" }
  | { kind: "palette" }
  | null;

interface CandidateGroup {
  kind: "group";
  id: string;
  category: string;
}

interface CandidateCommand {
  kind: "command";
  id: string;
  command: CommandPaletteDescriptor;
}

interface CandidateState {
  kind: "state";
  id: string;
  state: CommandPaletteStateKind;
  icon: string;
  title: string;
  detail: string;
  actionable: boolean;
}

type CandidateRow = CandidateGroup | CandidateCommand | CandidateState;

const clampCell = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function span(text: string, x: number, y: number, width: number): CommandPaletteTextSpan {
  const clipped = clipWorkspaceText(text, Math.max(0, width));
  return { text: clipped, x, y, width: terminalDisplayWidth(clipped), height: width > 0 ? 1 : 0 };
}

export function commandPaletteVariant(width: number, height: number): CommandPaletteVariant {
  if (width >= 160 && height >= 44) return "wide";
  if (width >= 100 && height >= 28) return "standard";
  return "compact";
}

function paletteGeometry(width: number, height: number, variant: CommandPaletteVariant) {
  const horizontalMargin = width >= 12 ? 2 : 0;
  const verticalMargin = height >= 8 ? 1 : 0;
  const maxWidth = variant === "wide" ? 96 : variant === "standard" ? 82 : 64;
  const maxHeight = variant === "wide" ? 34 : variant === "standard" ? 26 : 20;
  const overlayWidth = Math.min(Math.max(0, width - horizontalMargin * 2), maxWidth);
  const overlayHeight = Math.min(Math.max(0, height - verticalMargin * 2), maxHeight);
  const overlay: Rect = {
    x: Math.max(0, Math.floor((width - overlayWidth) / 2)),
    y: Math.max(0, Math.floor((height - overlayHeight) / 2)),
    width: overlayWidth,
    height: overlayHeight,
  };
  const bordered = overlay.width >= 8 && overlay.height >= 6;
  const inset = bordered ? 1 : 0;
  const inner: Rect = {
    x: overlay.x + inset,
    y: overlay.y + inset,
    width: Math.max(0, overlay.width - inset * 2),
    height: Math.max(0, overlay.height - inset * 2),
  };
  const headerHeight = inner.height >= 1 ? 1 : 0;
  const queryHeight = inner.height >= 2 ? 1 : 0;
  const dividerHeight = inner.height >= 5 ? 1 : 0;
  const footerHeight = inner.height >= 4 ? 1 : 0;
  const listHeight = Math.max(
    0,
    inner.height - headerHeight - queryHeight - dividerHeight - footerHeight,
  );
  const header: Rect = { x: inner.x, y: inner.y, width: inner.width, height: headerHeight };
  const query: Rect = {
    x: inner.x,
    y: header.y + header.height,
    width: inner.width,
    height: queryHeight,
  };
  const divider: Rect = {
    x: inner.x,
    y: query.y + query.height,
    width: inner.width,
    height: dividerHeight,
  };
  const list: Rect = {
    x: inner.x,
    y: divider.y + divider.height,
    width: inner.width,
    height: listHeight,
  };
  const footer: Rect = {
    x: inner.x,
    y: list.y + list.height,
    width: inner.width,
    height: footerHeight,
  };
  return { overlay, bordered, header, query, divider, list, footer };
}

function uniqueCommands(commands: readonly CommandPaletteDescriptor[]): CommandPaletteDescriptor[] {
  const seen = new Set<string>();
  const unique: CommandPaletteDescriptor[] = [];
  for (const command of commands) {
    if (!command.id || seen.has(command.id)) continue;
    seen.add(command.id);
    unique.push(command);
  }
  return unique;
}

function commandCandidates(commands: readonly CommandPaletteDescriptor[]): CandidateRow[] {
  const categories = new Map<string, CommandPaletteDescriptor[]>();
  for (const command of commands) {
    const category = command.group?.trim() || command.category.trim() || "Commands";
    const group = categories.get(category);
    if (group) group.push(command);
    else categories.set(category, [command]);
  }
  const candidates: CandidateRow[] = [];
  for (const [category, categoryCommands] of categories) {
    candidates.push({ kind: "group", id: `group:${category}`, category });
    for (const command of categoryCommands) {
      candidates.push({ kind: "command", id: `command:${command.id}`, command });
    }
  }
  return candidates;
}

function stateCandidates(input: {
  phase: CommandPalettePhase;
  query: string;
  errorMessage: string;
  retryCommandId: string;
}): CandidateRow[] {
  if (input.phase === "loading") {
    return [
      {
        kind: "state",
        id: "state:loading",
        state: "loading",
        icon: workspaceIcon("more"),
        title: "Loading commands…",
        detail: "Collecting actions from the workspace",
        actionable: false,
      },
    ];
  }
  if (input.phase === "error") {
    return [
      {
        kind: "state",
        id: "state:error",
        state: "error",
        icon: "!",
        title: "Commands unavailable",
        detail: input.errorMessage || "The command catalog could not be loaded",
        actionable: false,
      },
      {
        kind: "state",
        id: `state:retry:${input.retryCommandId}`,
        state: "retry",
        icon: workspaceIcon("refresh"),
        title: "Retry",
        detail: "Load the command catalog again",
        actionable: true,
      },
    ];
  }
  const hasQuery = input.query.trim().length > 0;
  return [
    {
      kind: "state",
      id: hasQuery ? "state:no-match" : "state:empty",
      state: hasQuery ? "no-match" : "empty",
      icon: workspaceIcon(hasQuery ? "search" : "command"),
      title: hasQuery ? "No matching commands" : "No commands yet",
      detail: hasQuery ? "Try another name, category, or shortcut" : "Contributions appear here",
      actionable: false,
    },
  ];
}

function rowHeight(candidate: CandidateRow, variant: CommandPaletteVariant): number {
  if (candidate.kind === "group") return 1;
  if (candidate.kind === "state" && candidate.state === "retry") return 1;
  if (candidate.kind === "state") return 2;
  return variant === "compact" ? 1 : 2;
}

/** A category header and its first command are one pagination atom. */
function requiredCandidateHeight(
  candidates: readonly CandidateRow[],
  index: number,
  variant: CommandPaletteVariant,
): number {
  const candidate = candidates[index];
  if (!candidate) return 0;
  const preferredHeight = rowHeight(candidate, variant);
  if (candidate.kind !== "group") return preferredHeight;
  const firstCommand = candidates[index + 1];
  return firstCommand?.kind === "command"
    ? preferredHeight + rowHeight(firstCommand, variant)
    : preferredHeight;
}

function trailingText(command: CommandPaletteDescriptor, width: number): string {
  const values = [command.status?.trim(), command.shortcut?.trim()].filter(
    (value): value is string => !!value,
  );
  if (values.length === 0 || width <= 0) return "";
  return clipWorkspaceText(values.join("  "), Math.min(width, 24));
}

function projectCommandRow(
  candidate: CandidateCommand,
  rect: Rect,
  selectedCommandId: string | null,
): CommandPaletteCommandRow {
  const command = candidate.command;
  const selected = command.id === selectedCommandId;
  const disabledReason = command.disabledReason?.trim() ?? "";
  const disabled = disabledReason.length > 0;
  const left = rect.x;
  const markerText = disabled
    ? "×"
    : selected
      ? workspaceIcon("command")
      : command.current
        ? "✓"
        : " ";
  const markerSpan = span(markerText, left, rect.y, Math.min(1, rect.width));
  const iconX = left + Math.min(2, rect.width);
  const iconSpan = span(workspaceIcon(command.icon), iconX, rect.y, Math.max(0, rect.width - 2));
  const labelX = left + Math.min(4, rect.width);
  const trailing = trailingText(command, Math.max(0, rect.width - 5));
  const trailingWidth = terminalDisplayWidth(trailing);
  const trailingGap = trailingWidth > 0 ? 1 : 0;
  const labelBudget = Math.max(0, rect.x + rect.width - labelX - trailingWidth - trailingGap);
  const rowLabel =
    rect.height === 1 && disabledReason ? `${command.label} — ${disabledReason}` : command.label;
  const labelSpan = span(rowLabel, labelX, rect.y, labelBudget);
  const trailingSpan =
    trailingWidth > 0
      ? span(trailing, rect.x + rect.width - trailingWidth, rect.y, trailingWidth)
      : null;
  const detail = disabledReason || command.detail?.trim() || command.description?.trim() || "";
  const detailSpan =
    rect.height > 1 && detail
      ? span(detail, labelX, rect.y + 1, Math.max(0, rect.x + rect.width - labelX))
      : null;
  return {
    kind: "command",
    id: candidate.id,
    commandId: command.id,
    iconId: command.icon,
    icon: iconSpan.text,
    label: command.label,
    detail,
    category: command.category,
    shortcut: command.shortcut?.trim() ?? "",
    status: command.status?.trim() ?? "",
    disabledReason,
    current: command.current === true,
    selected,
    disabled,
    rect,
    markerSpan,
    iconSpan,
    labelSpan,
    detailSpan,
    trailingSpan,
  };
}

function projectStateRow(
  candidate: CandidateState,
  rect: Rect,
  selectedCommandId: string | null,
  retryCommandId: string,
): CommandPaletteStateRow {
  const selected = candidate.actionable && selectedCommandId === retryCommandId;
  const prefix = `${selected ? workspaceIcon("command") : " "} ${candidate.icon} `;
  const labelSpan = span(`${prefix}${candidate.title}`, rect.x, rect.y, rect.width);
  const detailSpan =
    rect.height > 1
      ? span(
          candidate.detail,
          rect.x + Math.min(4, rect.width),
          rect.y + 1,
          Math.max(0, rect.width - 4),
        )
      : null;
  return {
    kind: "state",
    id: candidate.id,
    state: candidate.state,
    rect,
    icon: candidate.icon,
    title: candidate.title,
    detail: candidate.detail,
    selected,
    actionable: candidate.actionable,
    labelSpan,
    detailSpan,
  };
}

export function projectCommandPalette(input: CommandPaletteInput): CommandPaletteProjection {
  const width = clampCell(input.width);
  const height = clampCell(input.height);
  const variant = commandPaletteVariant(width, height);
  const geometry = paletteGeometry(width, height, variant);
  const phase = input.phase ?? "ready";
  const retryCommandId = input.retryCommandId?.trim() || "palette.retry";
  const commands = uniqueCommands(input.commands);
  const selectedCommandId = input.selectedCommandId ?? null;
  const candidates =
    phase === "ready" && commands.length > 0
      ? commandCandidates(commands)
      : stateCandidates({
          phase,
          query: input.query,
          errorMessage: input.errorMessage?.trim() ?? "",
          retryCommandId,
        });
  const scrollTop = Math.min(Math.max(0, clampCell(input.scrollTop ?? 0)), candidates.length);
  const visible: CommandPaletteRow[] = [];
  let y = geometry.list.y;
  let end = scrollTop;
  for (
    let index = scrollTop;
    index < candidates.length && y < geometry.list.y + geometry.list.height;
    index++
  ) {
    const candidate = candidates[index]!;
    const preferredHeight = rowHeight(candidate, variant);
    const heightBudget = geometry.list.y + geometry.list.height - y;
    if (requiredCandidateHeight(candidates, index, variant) > heightBudget) break;
    const rect: Rect = {
      x: geometry.list.x,
      y,
      width: geometry.list.width,
      height: preferredHeight,
    };
    if (candidate.kind === "group") {
      visible.push({
        kind: "group",
        id: candidate.id,
        category: candidate.category,
        rect,
        labelSpan: span(
          `— ${candidate.category}`,
          rect.x + Math.min(1, rect.width),
          rect.y,
          Math.max(0, rect.width - 1),
        ),
      });
    } else if (candidate.kind === "command") {
      visible.push(projectCommandRow(candidate, rect, selectedCommandId));
    } else {
      visible.push(projectStateRow(candidate, rect, selectedCommandId, retryCommandId));
    }
    y += preferredHeight;
    end = index + 1;
  }

  return {
    width,
    height,
    variant,
    phase,
    ...geometry,
    title: input.title?.trim() || "Command palette",
    queryText: input.query,
    queryPlaceholder: input.queryPlaceholder?.trim() || "Search commands…",
    commandCount: commands.length,
    contentRowCount: candidates.length,
    scrollTop,
    visibleStart: scrollTop,
    visibleEnd: end,
    rows: visible,
    rowIds: visible.map((row) => row.id),
    hasMoreBefore: scrollTop > 0,
    hasMoreAfter: end < candidates.length,
    retryCommandId,
  };
}

export function commandPaletteHitTest(
  projection: CommandPaletteProjection,
  x: number,
  y: number,
): CommandPaletteHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (!rectContains(projection.overlay, cellX, cellY)) return null;
  if (rectContains(projection.query, cellX, cellY)) return { kind: "query" };
  const row = projection.rows.find((candidate) => rectContains(candidate.rect, cellX, cellY));
  if (row?.kind === "command") {
    return { kind: "command", commandId: row.commandId, disabled: row.disabled };
  }
  if (row?.kind === "state" && row.state === "retry") {
    return { kind: "retry", commandId: projection.retryCommandId };
  }
  return { kind: "palette" };
}
