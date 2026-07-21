/**
 * The sidebar — the fleet nav column. Extracted from app.tsx (M26) as a PURE
 * PRESENTATIONAL component: it renders, it does not fetch, resolve, or route.
 *
 * Everything it needs arrives as props, which is what lets TWO hosts render the
 * same component:
 *
 *   - the terminal app (app.tsx) — OpenTUI's native renderer, over tmux
 *   - the web (docs/tui-web)     — a solid-js universal renderer over DOM
 *
 * Consequently: NO node imports, NO tmux, NO app state. The only pointer surface
 * is `onMouse` on the root box, carrying CELL coordinates — the same contract in
 * both hosts (the web host synthesizes cells from DOM events), so the router
 * (`sidebarHit`) is shared too rather than reimplemented per host.
 *
 * Row order is the CALLER's: pass agents already sorted (app's `fleetAgents`
 * memo applies `sortAgentRows`). Sorting here would double-sort and let the two
 * hosts silently disagree with the palette's jump list, which reads the same memo.
 *
 * The y-accounting this render implies — title, rule, session rows, gap, agents
 * header, agent rows — is reversed by `sidebarHit` in agent-rows.ts. The two MUST
 * move together; that's why AGENTS_GAP_ROWS is shared rather than a literal here.
 */
import { For, Show } from "solid-js";
import { STATUS_GLYPH } from "./status-grammar.ts";
import {
  AGENTS_ADD_CHIP,
  AGENTS_EMPTY_LINE,
  AGENTS_GAP_ROWS,
  agentAgeLabel,
  agentDisplayKind,
  agentRowLabel,
  agentsHeaderLabel,
  type AgentRowInput,
} from "./agent-rows.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { ShellChromeVariant } from "./shell-chrome.ts";

/** A session row: the fleet's name + its rolled-up status. */
export interface SidebarSession {
  name: string;
  status: AgentStatus;
}

/** The hover regions the sidebar owns. A subset of app.tsx's HoverRegion — kept
 *  structural so the host's wider union assigns without a cast. */
export type SidebarHoverRegion =
  | "sidebar"
  | "sidebaragent"
  | "agentshdr"
  | "agentschip"
  | "sidebtn";

/** The pointer event shape (structurally OpenTUI's MouseEvent; app.tsx's
 *  RouteEvent assigns to it). Cell coordinates, not pixels. */
export interface SidebarMouseEvent {
  type: string;
  x: number;
  y: number;
}

export interface SidebarProps {
  theme: SemanticThemeSnapshot;
  /** Column width in cells. */
  width: number;
  variant?: ShellChromeVariant;
  sessions: SidebarSession[];
  /** Pre-sorted, attention-first (see the note above). */
  agents: AgentRowInput[];
  /** The session whose workspace is open — renders as the active row. */
  current: string;
  /** Epoch SECONDS, injected so the age readout is testable and the component
   *  stays clock-free. */
  nowSec: number;
  isHovered: (region: SidebarHoverRegion, index: number) => boolean;
  /** M25.1 attention flash, by pane id. */
  flashed: (paneId: string) => boolean;
  /** The footer hint's three runs — the middle one is the clickable chip whose
   *  cells the router hit-tests (SIDEBAR_HINT_SPAN). Passed in because the quit
   *  hint differs by host. */
  hint: { pre: string; btn: string; post: string };
  onMouse?: (e: SidebarMouseEvent) => void;
}

export function Sidebar(props: SidebarProps) {
  const theme = () => props.theme;
  const statusColor = (status: AgentStatus) => {
    if (status === "blocked") return theme().roles.statusTone.warning;
    if (status === "working") return theme().roles.statusTone.info;
    if (status === "done") return theme().roles.statusTone.success;
    return theme().roles.statusTone.neutral;
  };
  return (
    <box
      width={props.width}
      flexDirection="column"
      backgroundColor={theme().roles.surfaces.panel}
      paddingLeft={1}
      overflow="hidden"
      onMouse={(e: SidebarMouseEvent) => props.onMouse?.(e)}
    >
      <text fg={theme().roles.text.link} attributes={1}>
        {props.variant === "compact" ? "tmux" : "tmux-ide"}
      </text>
      <text fg={theme().roles.text.muted}>{"─".repeat(props.width - 2)}</text>
      <box flexDirection="column">
        <For each={props.sessions}>
          {(s, i) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={
                s.name === props.current
                  ? theme().roles.selection.selection
                  : props.isHovered("sidebar", i())
                    ? theme().roles.selection.hover
                    : theme().roles.surfaces.panel
              }
            >
              <text fg={statusColor(s.status)}>{STATUS_GLYPH[s.status]}</text>
              <text
                fg={
                  s.name === props.current ? theme().roles.text.primary : theme().roles.text.muted
                }
              >
                {s.name.slice(0, Math.max(1, props.width - (props.variant === "compact" ? 3 : 5)))}
              </text>
            </box>
          )}
        </For>
      </box>
      {/* AGENTS section (M22.2): the fleet's agents at a glance, one row per
        agent, sorted attention-first, each a JUMP target (click → its
        session/window/pane). REUSES the session rows' glyph + state-color
        grammar. Hover reveals the state age. */}
      <box flexDirection="column" marginTop={AGENTS_GAP_ROWS}>
        {/* Header row (M24.1): label + a right-aligned [+ agent] chip. The row
          body opens the TEAM dialog, the chip spawns; the router x-tests
          `agentsChipSpans` — the flexGrow spacer lays the chip on exactly those
          cells. The empty state keeps a chip twin so spawning is discoverable
          before any agent runs. */}
        <box
          flexDirection="row"
          backgroundColor={
            props.isHovered("agentshdr", 0)
              ? theme().roles.selection.hover
              : theme().roles.surfaces.panel
          }
        >
          <text fg={theme().roles.text.muted} attributes={1}>
            {agentsHeaderLabel(
              props.agents.length,
              Math.max(1, props.width - AGENTS_ADD_CHIP.length - 2),
            )}
          </text>
          <box flexGrow={1} />
          <text
            fg={theme().roles.text.muted}
            bg={
              props.isHovered("agentschip", 0)
                ? theme().roles.selection.hover
                : theme().roles.surfaces.panel
            }
          >
            {AGENTS_ADD_CHIP}
          </text>
        </box>
        <Show
          when={props.agents.length > 0}
          fallback={
            <box flexDirection="row">
              <text fg={theme().roles.text.muted}>
                {AGENTS_EMPTY_LINE.slice(0, Math.max(1, props.width - AGENTS_ADD_CHIP.length - 2))}
              </text>
              <box flexGrow={1} />
              <text
                fg={theme().roles.text.muted}
                bg={
                  props.isHovered("agentschip", 1)
                    ? theme().roles.selection.hover
                    : theme().roles.surfaces.panel
                }
              >
                {AGENTS_ADD_CHIP}
              </text>
            </box>
          }
        >
          <For each={props.agents}>
            {(a, i) => {
              const hovered = () => props.isHovered("sidebaragent", i());
              const ageShown = () =>
                hovered() ? agentAgeLabel(a.state, a.since, props.nowSec) : null;
              const labelBudget = () => {
                const age = ageShown();
                return props.width - 5 - (age ? age.length + 1 : 0);
              };
              // Blocked is the attention state: bold, matching the statusline's
              // grammar (`blocked` reads bold there too).
              const attn = () => (a.state === "blocked" ? 1 : 0);
              const flashed = () => props.flashed(a.paneId);
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  backgroundColor={
                    flashed()
                      ? theme().derived.attentionSurface
                      : hovered()
                        ? theme().roles.selection.hover
                        : theme().roles.surfaces.panel
                  }
                >
                  <text fg={statusColor(a.state)} attributes={attn()}>
                    {STATUS_GLYPH[a.state]}
                  </text>
                  <text
                    fg={
                      a.state === "blocked"
                        ? theme().roles.statusTone.warning
                        : theme().roles.text.muted
                    }
                    attributes={attn()}
                  >
                    {agentRowLabel(agentDisplayKind(a), a.session, labelBudget())}
                  </text>
                  <Show when={ageShown()}>
                    <box flexGrow={1} />
                    <text fg={theme().roles.text.muted}>{ageShown()}</text>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </box>
      <box flexGrow={1} />
      {/* Footer hint — its middle segment is a CHIP (M21.9): the router
        hit-tests SIDEBAR_HINT_SPAN on the last screen row, and these three runs
        render the exact same cells. */}
      <box width={props.width} flexDirection="row" overflow="hidden">
        <text fg={theme().roles.text.muted}>{props.hint.pre}</text>
        <text
          fg={theme().roles.text.muted}
          bg={
            props.isHovered("sidebtn", 0)
              ? theme().roles.selection.hover
              : theme().roles.surfaces.panel
          }
        >
          {props.hint.btn}
        </text>
        <text fg={theme().roles.text.muted}>{props.hint.post}</text>
      </box>
    </box>
  );
}
