/**
 * Pure model helpers for the cockpit's HOME screen — the surface bare
 * `tmux-ide` opens when there's no single-project config to launch.
 *
 * The `.tsx` renders these plain-data shapes: the header's fleet rollup counts,
 * the empty-fleet hero actions, the in-app panel keys (e/g/,), and the footer
 * hint line. Keeping them here (io-free, opentui-free) means the header/footer/
 * empty-state logic unit-tests as tables, and the panel keys + footer stay
 * sourced from the grammar and the panel registry so they can't drift from the
 * chrome binds or the widget set.
 */
import type { AgentStatus } from "../detect/classify.ts";
import type { TeamProject } from "./projects.ts";
import { GRAMMAR_KEYS } from "../../widgets/lib/grammar.ts";
import { PANEL_POPUPS, type PanelPopup } from "../chrome/panels.ts";

/** Live-session status tallies across the whole fleet, for the home header. */
export interface FleetRollup {
  blocked: number;
  working: number;
  done: number;
  idle: number;
  unknown: number;
  /** Total live sessions counted. */
  sessions: number;
  /** Total projects (registered + ad-hoc) in the fleet. */
  projects: number;
}

/**
 * PURE — tally every live session's status across the fleet. Counts SESSIONS
 * (the unit a person acts on), not panes: a project with three sessions
 * contributes three to the rollup.
 */
export function fleetRollup(projects: TeamProject[]): FleetRollup {
  const r: FleetRollup = {
    blocked: 0,
    working: 0,
    done: 0,
    idle: 0,
    unknown: 0,
    sessions: 0,
    projects: projects.length,
  };
  for (const p of projects) {
    for (const s of p.sessions) {
      r[s.status] += 1;
      r.sessions += 1;
    }
  }
  return r;
}

/** A header rollup chip: a status and its count, colored by the status token. */
export interface RollupChip {
  status: AgentStatus;
  count: number;
}

/** The rollup chips shown in the header, in severity order — the meaningful
 *  agent states (blocked/working/done) plus idle to round out the total. */
export const ROLLUP_ORDER: AgentStatus[] = ["blocked", "working", "done", "idle"];

/** PURE — the ordered header chips for a rollup. */
export function rollupChips(r: FleetRollup): RollupChip[] {
  return ROLLUP_ORDER.map((status) => ({ status, count: r[status] }));
}

/**
 * PURE — true when the fleet has nothing to show: no registered projects and no
 * live sessions (ad-hoc projects only exist for live sessions, and registered
 * projects always appear, so an empty list means a truly empty fleet). The home
 * screen swaps to the hero box in this state.
 */
export function isFleetEmpty(projects: TeamProject[]): boolean {
  return projects.length === 0;
}

/** An empty-fleet hero call-to-action: the key and what it does. */
export interface HeroAction {
  key: string;
  label: string;
}

/** PURE — the empty-fleet hero's action rows. `l` opens the add-a-project-dir
 *  prompt (the entry point to get a launchable project into the fleet). */
export function emptyFleetActions(): HeroAction[] {
  return [
    { key: "n", label: "new session" },
    { key: "l", label: "launch a project dir" },
    { key: "q", label: "quit" },
  ];
}

/**
 * The cockpit's IN-APP panel keys — plain letters matched against a bare
 * keypress in the home handler, distinct from the tmux root-table `M-e`/`M-g`/
 * `M-,` chrome binds. `,` opens config to echo its `M-,` bind.
 */
export const HOME_PANEL_KEYS: Record<string, PanelPopup["widget"]> = {
  e: "explorer",
  g: "changes",
  ",": "config",
};

/** PURE — the panel a home keypress opens, or null when it isn't a panel key. */
export function panelForKey(name: string): PanelPopup["widget"] | null {
  return HOME_PANEL_KEYS[name] ?? null;
}

/** PURE — the in-app key that opens `widget`, or "" when unbound. */
export function keyForPanel(widget: PanelPopup["widget"]): string {
  const found = Object.entries(HOME_PANEL_KEYS).find(([, w]) => w === widget);
  return found ? found[0] : "";
}

/** One footer / help hint: the key glyph(s) and the verb. */
export interface FooterHint {
  keys: string;
  label: string;
}

/**
 * PURE — the panel hints, DERIVED from the panel registry + the in-app keys so
 * adding a panel or re-keying it updates the footer and help automatically.
 * `use` picks the label source: the terse `widget` name for the footer, the
 * registry `label` (e.g. "⊞ Files") for the roomier help overlay.
 */
export function panelHints(use: "widget" | "label" = "widget"): FooterHint[] {
  return PANEL_POPUPS.map((p) => ({
    keys: keyForPanel(p.widget),
    label: use === "label" ? p.label : p.widget,
  }));
}

/**
 * PURE — the home footer hint line. The universal verbs' KEY glyphs come from
 * {@link GRAMMAR_KEYS} (so the footer can't advertise a key the grammar doesn't
 * bind), interleaved with the cockpit's own session + panel keys. Rendered as a
 * single flex row by the `.tsx`.
 */
export function homeFooterHints(): FooterHint[] {
  return [
    { keys: "↑↓", label: "nav" },
    { keys: "↵", label: "attach/launch" },
    { keys: "n", label: "new" },
    { keys: "l", label: "launch" },
    ...panelHints("widget"),
    { keys: GRAMMAR_KEYS.filter[0]!, label: "filter" },
    { keys: GRAMMAR_KEYS.help[0]!, label: "help" },
    { keys: GRAMMAR_KEYS.quit[0]!, label: "quit" },
  ];
}

/**
 * PURE — the compact PICKER popup's footer hints. The picker ends in a
 * switch-client + close, so it advertises that. The discoverable universal verbs
 * (filter / help / dismiss) come from {@link GRAMMAR_KEYS} so the footer can't
 * advertise a key the grammar doesn't bind — in particular `? help`, which
 * surfaces the full keybindings overlay from inside the popup.
 */
export function pickerFooterHints(): FooterHint[] {
  return [
    { keys: "↵", label: "switch" },
    { keys: "l", label: "launch" },
    { keys: GRAMMAR_KEYS.filter[0]!, label: "find" },
    { keys: GRAMMAR_KEYS.help[0]!, label: "help" },
    { keys: "esc", label: "close" },
  ];
}
