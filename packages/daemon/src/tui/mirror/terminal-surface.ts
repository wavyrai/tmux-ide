import { clipTerminal } from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { actionChipSpansFromRight, type Rect } from "./recipes.ts";

export type TerminalChromeVariant = "compact" | "standard" | "wide";
export type TerminalChromeActionId = "zoom" | "split" | "search" | "sync";

export interface TerminalChromeAction {
  id: TerminalChromeActionId;
  label: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  hovered?: boolean;
}

export interface TerminalChromeActionSpan extends TerminalChromeAction {
  start: number;
  width: number;
}

export interface TerminalPaneChromeInput {
  width: number;
  height: number;
  title: string;
  paneId: string;
  session: string;
  focused: boolean;
  attention?: boolean;
  scrollOffset?: number;
  scrollbackDepth?: number;
  selected?: boolean;
  zoomed?: boolean;
  sync?: boolean;
  search?: string | null;
  hoveredActionIndex?: number | null;
}

export interface TerminalPaneChromeProjection {
  width: number;
  height: number;
  variant: TerminalChromeVariant;
  header: Rect;
  body: Rect;
  footer: Rect;
  title: string;
  status: string;
  focused: boolean;
  attention: boolean;
  bodyRows: number;
  actions: readonly TerminalChromeActionSpan[];
}

export function terminalChromeVariant(width: number, height: number): TerminalChromeVariant {
  if (width >= 120 && height >= 32) return "wide";
  if (width >= 72 && height >= 18) return "standard";
  return "compact";
}

export function projectTerminalPaneChrome(
  input: TerminalPaneChromeInput,
): TerminalPaneChromeProjection {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const variant = terminalChromeVariant(width, height);
  const headerHeight = Math.min(1, height);
  const footerHeight = height >= 8 ? 1 : 0;
  const bodyY = headerHeight;
  const bodyHeight = Math.max(0, height - headerHeight - footerHeight);
  const actions = terminalActions(input, variant).map((action, index) => ({
    ...action,
    hovered: input.hoveredActionIndex === index,
  }));
  const actionSpans = actionChipSpansFromRight(actions, width, 1);
  const titleBudget = Math.max(4, (actionSpans[0]?.start ?? width) - 1);
  return {
    width,
    height,
    variant,
    header: { x: 0, y: 0, width, height: headerHeight },
    body: { x: 0, y: bodyY, width, height: bodyHeight },
    footer: { x: 0, y: height - footerHeight, width, height: footerHeight },
    title: clipTerminal(input.title || input.session, titleBudget),
    status: clipTerminal(statusText(input, variant), width),
    focused: input.focused,
    attention: input.attention === true,
    bodyRows: bodyHeight,
    actions: actionSpans,
  };
}

function terminalActions(
  input: TerminalPaneChromeInput,
  variant: TerminalChromeVariant,
): TerminalChromeAction[] {
  const zoomLabel = variant === "compact" ? "[Z]" : "[⛶ zoom]";
  const splitLabel = variant === "compact" ? "[+]" : "[+ split]";
  const out: TerminalChromeAction[] = [
    { id: "zoom", label: zoomLabel, description: "Toggle pane zoom", active: input.zoomed },
    { id: "split", label: splitLabel, description: "Split focused pane" },
  ];
  if (variant !== "compact") {
    out.push({
      id: "search",
      label: input.search ? "[/ search]" : "[/]",
      description: "Search scrollback",
      active: input.search !== null && input.search !== undefined,
    });
  }
  if (input.sync)
    out.push({ id: "sync", label: "[SYNC]", description: "Synchronize panes", active: true });
  return out;
}

function statusText(input: TerminalPaneChromeInput, variant: TerminalChromeVariant): string {
  const parts = [
    input.focused ? "focused" : "idle",
    input.attention ? "attention" : "",
    input.selected ? "select" : "",
    input.zoomed ? "zoomed" : "",
    input.scrollOffset && input.scrollOffset > 0
      ? `↑${input.scrollOffset}/${input.scrollbackDepth ?? "?"}`
      : "",
    variant === "compact" ? input.paneId : `${input.session} ${input.paneId}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function terminalChromeHitTest(
  projection: TerminalPaneChromeProjection,
  x: number,
  y: number,
):
  | { area: "header"; actionId?: TerminalChromeActionId; actionIndex?: number }
  | { area: "body" | "footer" }
  | null {
  if (x < 0 || y < 0 || x >= projection.width || y >= projection.height) return null;
  if (y < projection.header.height) {
    const actionIndex = projection.actions.findIndex(
      (span) => x >= span.start && x < span.start + span.width,
    );
    if (actionIndex >= 0) {
      return {
        area: "header",
        actionId: projection.actions[actionIndex]!.id,
        actionIndex,
      };
    }
    return { area: "header" };
  }
  if (projection.footer.height > 0 && y >= projection.footer.y) return { area: "footer" };
  return { area: "body" };
}

export function cells(text: string): number {
  return terminalDisplayWidth(text);
}
