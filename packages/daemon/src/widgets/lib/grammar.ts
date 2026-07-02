/**
 * The ONE interaction grammar shared by every TUI surface — the sidebar,
 * explorer, changes, config, and the team cockpit/picker.
 *
 * Cohesion is muscle memory: `j`/`k` (+ arrows) move, `enter` activates, `/`
 * filters, `esc` closes the topmost thing (filter → detail → widget), `q`
 * quits, `?` toggles help. These keys mean the SAME thing everywhere, so a
 * widget never invents its own drift for a universal verb.
 *
 * Widgets call {@link matchGrammar} FIRST in their key handler and act on the
 * returned {@link GrammarAction}, falling through to their own widget-specific
 * keys only when it returns `null`. The escape precedence is factored into the
 * pure {@link dismiss} state-machine so "esc closes the filter before it quits"
 * is defined (and tested) in one place.
 *
 * This module is the SINGLE SOURCE for the grammar: the per-widget help
 * overlays and the cheat sheet both render their "in panels & sidebar" section
 * from {@link GRAMMAR_HELP}, so documentation can never drift from behaviour.
 *
 * Pure — no io, no solid, no opentui — so it unit-tests as a plain table.
 */

/** The universal verbs every surface understands. */
export type GrammarAction =
  | "navDown"
  | "navUp"
  | "activate"
  | "filter"
  | "help"
  | "dismiss"
  | "quit";

/** The subset of an @opentui key event the grammar needs. */
export interface GrammarKeyEvent {
  name: string;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Deterministic iteration order for {@link matchGrammar}. The grammar keys are
 * mutually exclusive (no key appears in two actions), so order only fixes the
 * lookup for readers/tests — it never changes a result.
 */
export const GRAMMAR_ACTION_ORDER: GrammarAction[] = [
  "navDown",
  "navUp",
  "activate",
  "filter",
  "help",
  "dismiss",
  "quit",
];

/**
 * The fixed key → action bindings. Unlike the team app's configurable
 * `DEFAULT_KEYMAP`, the GRAMMAR itself is not user-configurable — its whole
 * value is that it is the same everywhere. The team keymap's universal actions
 * (up/down/enter/filter/help/quit) agree with these by construction.
 */
export const GRAMMAR_KEYS: Record<GrammarAction, string[]> = {
  navDown: ["j", "down"],
  navUp: ["k", "up"],
  activate: ["return"],
  filter: ["/"],
  help: ["?"],
  dismiss: ["escape"],
  quit: ["q"],
};

/**
 * Human-facing rows for the help overlays and the cheat sheet — rendered
 * straight from this constant so the docs are sourced from the grammar itself.
 */
export const GRAMMAR_HELP: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "j / ↓", label: "move down" },
  { keys: "k / ↑", label: "move up" },
  { keys: "enter", label: "activate / open" },
  { keys: "/", label: "filter list" },
  { keys: "esc", label: "close filter → detail → widget" },
  { keys: "q", label: "quit" },
  { keys: "?", label: "toggle this help" },
];

/**
 * Map a key event to its {@link GrammarAction}, or `null` when the key is not
 * part of the grammar (so the caller falls through to its widget-specific
 * keys).
 *
 * `ctrl`/`alt`/`meta` combos are NEVER grammar — those namespaces belong to the
 * widgets (`ctrl+s` save, `ctrl+c` quit, the `M-…` dock popups). `shift` is
 * allowed through because `?` arrives as a shifted `/` on most layouts; no
 * widget binds a `shift+<grammar key>` combo, so letting it pass is safe.
 */
export function matchGrammar(evt: GrammarKeyEvent): GrammarAction | null {
  if (evt.ctrl || evt.alt || evt.meta) return null;
  for (const action of GRAMMAR_ACTION_ORDER) {
    if (GRAMMAR_KEYS[action].includes(evt.name)) return action;
  }
  return null;
}

/** Which layer an `esc` (or `q`) should close, given what is currently open. */
export type DismissTarget = "filter" | "detail" | "widget";

/** The open-overlay layers a surface can stack, topmost-wins. */
export interface OverlayState {
  /** A `/` filter prompt is open (typing narrows a list). */
  filterOpen?: boolean;
  /** A transient detail view is open (help overlay, field editor, preview). */
  detailOpen?: boolean;
}

/**
 * The escape precedence, as a pure function: esc closes the FILTER first, then
 * an open DETAIL, and only when nothing is layered does it fall through to the
 * WIDGET itself (quit / close the popup). Widgets call this to decide what a
 * bare `esc` (grammar `dismiss`) should do without re-deriving the order.
 */
export function dismiss(state: OverlayState): DismissTarget {
  if (state.filterOpen) return "filter";
  if (state.detailOpen) return "detail";
  return "widget";
}
