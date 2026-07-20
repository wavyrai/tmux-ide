import type { AgentStatus } from "../detect/classify.ts";
import type { FleetRollup } from "../team/home.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { clipTerminal } from "./missions-workspace.ts";
import { centerPad, isFirstRun, type HomeFleetProject, type HomeItem } from "./home-model.ts";
import { actionChipSpansFromRight, actionChipWidth, type Rect } from "./recipes.ts";

export type HomeSurfaceVariant = "compact" | "standard" | "wide";

export type HomeRowRole = "section" | "session" | "project" | "recent";
export type HomeActionId =
  | "open-folder"
  | "new-session"
  | "open-file"
  | "open-diff"
  | "new-agent"
  | "primary";

export interface HomeActionDescriptor {
  id: HomeActionId;
  label: string;
  disabled?: boolean;
  hovered?: boolean;
  description: string;
}

export interface HomeProjectedRow extends Rect {
  id: string;
  role: HomeRowRole;
  itemIndex: number;
  label: string;
  meta: string;
  status?: AgentStatus;
  selected: boolean;
  hovered: boolean;
  disabled: boolean;
  attention: boolean;
  overflowBefore: number;
  overflowAfter: number;
  actions: readonly HomeActionDescriptor[];
  actionSpans: readonly (HomeActionDescriptor & { start: number; width: number })[];
}

export interface HomeWelcomeProjection {
  rows: readonly { y: number; text: string; x: number; role: "title" | "action" | "hint" }[];
  action: Rect & { id: "open-folder"; label: string; hovered: boolean };
}

export interface HomeSurfaceProjection {
  width: number;
  height: number;
  variant: HomeSurfaceVariant;
  header: Rect;
  body: Rect;
  footer: Rect;
  firstRun: boolean;
  title: string;
  subtitle: string;
  stats: readonly { id: AgentStatus | "sessions" | "projects"; label: string; count: number }[];
  welcome: HomeWelcomeProjection | null;
  rows: readonly HomeProjectedRow[];
  detail: string;
  prompt:
    | { kind: "session"; label: string; value: string }
    | { kind: "path"; label: string; value: string }
    | null;
  footerHint: string;
  footerActions: readonly HomeActionDescriptor[];
  footerActionY: number;
  footerActionSpans: readonly (HomeActionDescriptor & { start: number; width: number })[];
}

export interface HomeSurfaceInput {
  width: number;
  height: number;
  projects: readonly HomeFleetProject[];
  items: readonly HomeItem[];
  selectedIndex: number;
  hovered: {
    region: "home" | "homechip" | "homeagentchip" | "welcomeopen" | "button";
    index: number;
  } | null;
  rollup: FleetRollup;
  detail: string;
  footerHint: string;
  sessionPrompt: string | null;
  pathPrompt: string | null;
  quitHint: string;
  welcomeLine: string;
  welcomeActionLabel: string;
  welcomeTip: string;
}

const HEADER_ROWS = 2;
const FOOTER_ROWS = 2;
const WELCOME_ROWS = 6;
const WELCOME_ACTION_ROW = 3;
const HOME_CHIP_AGENT = "[+ agent] ";
const HOME_CHIP_SESSION = "[± diff] ";
const HOME_CHIP_PROJECT = "[▸ launch] ";
const HOME_CHIP_RECENT = "[▸ open] ";

export function homeSurfaceVariant(width: number, height: number): HomeSurfaceVariant {
  if (width >= 160 && height >= 45) return "wide";
  if (width >= 96 && height >= 30) return "standard";
  return "compact";
}

export function homeContentRows(projection: Pick<HomeSurfaceProjection, "rows">): number {
  return projection.rows.length;
}

export function homeWelcomeOffset(projects: readonly HomeFleetProject[]): number {
  return isFirstRun(projects) ? WELCOME_ROWS : 0;
}

export function homeItemIndexAtProjection(
  projection: HomeSurfaceProjection,
  globalX: number,
  globalY: number,
  originX = 0,
  originY = 0,
): number {
  const x = globalX - originX;
  const y = globalY - originY;
  if (x < 0 || x >= projection.width || y < projection.body.y || y >= projection.footer.y) {
    return -1;
  }
  const row = projection.rows.find((candidate) => y >= candidate.y && y < candidate.y + 1);
  return row?.itemIndex ?? -1;
}

export function homeActionAtProjection(
  projection: HomeSurfaceProjection,
  globalX: number,
  globalY: number,
  originX = 0,
  originY = 0,
): {
  source: "welcome" | "footer" | "row";
  id: HomeActionId;
  itemIndex?: number;
  actionIndex?: number;
} | null {
  const x = globalX - originX;
  const y = globalY - originY;
  if (projection.welcome && y === projection.welcome.action.y) {
    const a = projection.welcome.action;
    if (x >= a.x && x < a.x + a.width) return { source: "welcome", id: "open-folder" };
  }
  if (y === projection.footerActionY) {
    const actionIndex = projection.footerActionSpans.findIndex(
      (span) => x >= span.start && x < span.start + span.width,
    );
    const hit = actionIndex >= 0 ? projection.footerActionSpans[actionIndex] : undefined;
    return hit ? { source: "footer", id: hit.id, actionIndex } : null;
  }
  const row = projection.rows.find((candidate) => y === candidate.y);
  if (!row) return null;
  const actionIndex = row.actionSpans.findIndex(
    (span) => x >= span.start && x < span.start + span.width,
  );
  const action = actionIndex >= 0 ? row.actionSpans[actionIndex] : undefined;
  return action ? { source: "row", id: action.id, itemIndex: row.itemIndex, actionIndex } : null;
}

export function projectHomeSurface(input: HomeSurfaceInput): HomeSurfaceProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = homeSurfaceVariant(width, height);
  const firstRun = isFirstRun(input.projects);
  const footerHeight = height >= 8 ? FOOTER_ROWS : 1;
  const headerHeight = Math.min(HEADER_ROWS, height);
  const footerY = Math.max(headerHeight, height - footerHeight);
  const body: Rect = {
    x: 0,
    y: headerHeight,
    width,
    height: Math.max(0, footerY - headerHeight),
  };
  const title = variant === "compact" ? "Home" : "tmux-ide Home";
  const subtitle =
    variant === "compact"
      ? `${input.rollup.sessions} sessions · ${input.rollup.projects} projects`
      : "Sessions, registered projects, and recent folders";
  const stats = [
    { id: "sessions" as const, label: "sessions", count: input.rollup.sessions },
    { id: "blocked" as const, label: "blocked", count: input.rollup.blocked },
    { id: "working" as const, label: "working", count: input.rollup.working },
    { id: "done" as const, label: "done", count: input.rollup.done },
    { id: "projects" as const, label: "projects", count: input.rollup.projects },
  ].filter((stat) => variant !== "compact" || stat.count > 0 || stat.id === "sessions");
  const welcome = firstRun ? projectWelcome(input, width, body) : null;
  const rowsStartY = body.y + (welcome ? WELCOME_ROWS : 0);
  const maxRows = Math.max(0, footerY - rowsStartY);
  const windowStart = homeWindowStart(input.items, input.selectedIndex, maxRows);
  const visibleItems = input.items.slice(windowStart, windowStart + maxRows);
  const rows = visibleItems.map((item, offset) =>
    projectHomeRow({
      item,
      itemIndex: windowStart + offset,
      y: rowsStartY + offset,
      width,
      variant,
      selected: windowStart + offset === input.selectedIndex,
      hovered: input.hovered,
      overflowBefore: windowStart,
      overflowAfter: Math.max(0, input.items.length - (windowStart + visibleItems.length)),
    }),
  );
  const footerActionDefs: HomeActionDescriptor[] = [
    {
      id: "open-folder",
      label: variant === "compact" ? "[f folder]" : "[f open folder]",
      description: "Open a folder",
    },
    {
      id: "new-session",
      label: variant === "compact" ? "[n session]" : "[n new session]",
      description: "Create a session here",
    },
    {
      id: "new-agent",
      label: variant === "compact" ? "[a agent]" : "[a new agent]",
      description: "Start an agent here",
    },
    { id: "open-file", label: "[o open]", description: "Open a file by path" },
    { id: "open-diff", label: "[d diff]", description: "Open selected project diff" },
  ];
  const footerActions: HomeActionDescriptor[] = footerActionDefs.map((action, index) => ({
    ...action,
    hovered: input.hovered?.region === "button" && input.hovered.index === index,
  }));
  const footerActionY = footerHeight > 1 ? footerY + 1 : footerY;
  const footerActionSpans = actionChipSpansFromRight(footerActions, width, 1);
  const prompt =
    input.sessionPrompt !== null
      ? ({ kind: "session", label: "new session", value: input.sessionPrompt } as const)
      : input.pathPrompt !== null
        ? ({ kind: "path", label: "open file", value: input.pathPrompt } as const)
        : null;
  const footerHint =
    variant === "compact"
      ? compactFooter(input.footerHint, input.quitHint, width)
      : clipTerminal(input.footerHint, width);
  return {
    width,
    height,
    variant,
    header: { x: 0, y: 0, width, height: headerHeight },
    body,
    footer: { x: 0, y: footerY, width, height: footerHeight },
    firstRun,
    title,
    subtitle,
    stats,
    welcome,
    rows,
    detail: clipTerminal(input.detail, width),
    prompt,
    footerHint,
    footerActions,
    footerActionY,
    footerActionSpans,
  };
}

function homeWindowStart(
  items: readonly HomeItem[],
  selectedIndex: number,
  capacity: number,
): number {
  if (capacity <= 0 || items.length <= capacity) return 0;
  const selected = Math.max(0, Math.min(items.length - 1, selectedIndex));
  if (selected < capacity) return 0;
  const maxStart = Math.max(0, items.length - capacity);
  return Math.min(maxStart, selected - capacity + 1);
}

function projectWelcome(input: HomeSurfaceInput, width: number, body: Rect): HomeWelcomeProjection {
  const line = clipTerminal(input.welcomeLine, width);
  const action = clipTerminal(input.welcomeActionLabel, width);
  const actionWidth = actionChipWidth(action);
  const actionX = centerPad(width, actionWidth);
  const hint = clipTerminal(input.welcomeTip, width);
  return {
    rows: [
      { y: body.y + 1, text: line, x: centerPad(width, terminalDisplayWidth(line)), role: "title" },
      {
        y: body.y + WELCOME_ACTION_ROW,
        text: action,
        x: actionX,
        role: "action",
      },
      {
        y: body.y + 5,
        text: hint,
        x: centerPad(width, terminalDisplayWidth(hint)),
        role: "hint",
      },
    ],
    action: {
      id: "open-folder",
      label: action,
      x: actionX,
      y: body.y + WELCOME_ACTION_ROW,
      width: actionWidth,
      height: 1,
      hovered: input.hovered?.region === "welcomeopen",
    },
  };
}

function projectHomeRow(input: {
  item: HomeItem;
  itemIndex: number;
  y: number;
  width: number;
  variant: HomeSurfaceVariant;
  selected: boolean;
  hovered: {
    region: "home" | "homechip" | "homeagentchip" | "welcomeopen" | "button";
    index: number;
  } | null;
  overflowBefore: number;
  overflowAfter: number;
}): HomeProjectedRow {
  const { item, itemIndex, width, variant } = input;
  if (item.kind === "header") {
    return {
      id: `section:${item.label}`,
      role: "section",
      itemIndex,
      x: 0,
      y: input.y,
      width,
      height: 1,
      label: item.label,
      meta: "",
      selected: false,
      hovered: false,
      disabled: true,
      attention: false,
      overflowBefore: input.overflowBefore,
      overflowAfter: input.overflowAfter,
      actions: [],
      actionSpans: [],
    };
  }
  const actions = homeRowActions(item);
  const hoveredActionId =
    input.hovered?.index === itemIndex
      ? input.hovered.region === "homeagentchip"
        ? "new-agent"
        : input.hovered.region === "homechip"
          ? "primary"
          : null
      : null;
  const actionsWithHover = actions.map((action) => ({
    ...action,
    hovered: action.id === hoveredActionId,
  }));
  const actionSpans = actionChipSpansFromRight(actionsWithHover, width, 0);
  const role = item.kind;
  const label =
    item.kind === "session" ? item.session : item.kind === "project" ? item.name : item.name;
  return {
    id:
      item.kind === "session"
        ? `session:${item.session}`
        : item.kind === "project"
          ? `project:${item.name}`
          : `recent:${item.dir}`,
    role,
    itemIndex,
    x: 0,
    y: input.y,
    width,
    height: 1,
    label: clipTerminal(label, labelBudget(width, actions, variant)),
    meta: homeRowMeta(item, variant),
    status: item.kind === "session" ? item.status : undefined,
    selected: input.selected,
    hovered:
      input.hovered?.index === itemIndex &&
      (input.hovered.region === "home" ||
        input.hovered.region === "homechip" ||
        input.hovered.region === "homeagentchip"),
    disabled: false,
    attention: item.kind === "session" && item.status === "blocked",
    overflowBefore: input.overflowBefore,
    overflowAfter: input.overflowAfter,
    actions: actionsWithHover,
    actionSpans,
  };
}

function homeRowActions(item: HomeItem): HomeActionDescriptor[] {
  if (item.kind === "header") return [];
  const out: HomeActionDescriptor[] = [];
  if (item.kind === "session" || item.kind === "project") {
    out.push({ id: "new-agent", label: HOME_CHIP_AGENT, description: "Start an agent here" });
  }
  if (item.kind === "session") {
    out.push({ id: "primary", label: HOME_CHIP_SESSION, description: "Open project diff" });
  } else if (item.kind === "project") {
    out.push({ id: "primary", label: HOME_CHIP_PROJECT, description: "Launch project" });
  } else if (item.kind === "recent") {
    out.push({ id: "primary", label: HOME_CHIP_RECENT, description: "Open recent folder" });
  }
  return out;
}

function labelBudget(
  width: number,
  actions: readonly HomeActionDescriptor[],
  variant: HomeSurfaceVariant,
): number {
  const actionWidth = actions.reduce((sum, action) => sum + actionChipWidth(action.label), 0);
  const metaReserve = variant === "compact" ? 8 : 20;
  return Math.max(4, width - actionWidth - metaReserve - 6);
}

function homeRowMeta(item: Exclude<HomeItem, { kind: "header" }>, variant: HomeSurfaceVariant) {
  if (item.kind === "session") {
    const windows = `${item.windows}w`;
    return variant === "compact"
      ? `${windows} · ${item.status}`
      : `${windows}${item.project === item.session ? "" : ` · ${item.project}`} · ${item.status}`;
  }
  if (item.kind === "project") return variant === "compact" ? "registered" : `${item.dir ?? ""}`;
  return variant === "compact" ? "recent" : item.dir;
}

function compactFooter(footerHint: string, quitHint: string, width: number): string {
  const base = `j/k enter · f folder · ${quitHint}`;
  if (terminalDisplayWidth(base) <= width) return base;
  return clipTerminal(footerHint, width);
}
