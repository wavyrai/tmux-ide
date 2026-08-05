/**
 * The verb table as menu sections.
 *
 * PURE. Every mouse surface that offers multiplexer verbs — the window card,
 * bare canvas, a fleet session row — builds its menu here, so the same verb has
 * the same label, the same reason when it is unavailable, and the same place in
 * the reading order wherever it is met. The alternative is what the m48 audit
 * found: each surface inventing its own list, and a verb existing exactly where
 * someone remembered to add it.
 *
 * Two honesty rules are enforced structurally rather than by convention.
 *
 * 1. Unavailable verbs are RETURNED, disabled, carrying the availability
 *    engine's reason. Nothing filters them out.
 * 2. Verbs that rearrange the app's own canvas and never reach tmux are grouped
 *    into their own section, with a note that says so and a per-item qualifier.
 *    This is m48 gap 1 — a user arranging cards for five minutes, then attaching
 *    over ssh to an untouched tmux layout — made visible at the point of use,
 *    which is the only place it can stop being a surprise.
 */
import {
  multiplexerVerb,
  multiplexerVerbAvailability,
  type MultiplexerVerbEntry,
  type MultiplexerVerbFacts,
  type MultiplexerVerbId,
} from "@tmux-ide/contracts";

import type { ContextMenuItem, ContextMenuSection } from "../ui-system/index.ts";

/** App-layout item ids. Namespaced away from verb ids, which are dot-scoped verbs. */
export const APP_LAYOUT_MENU_IDS = Object.freeze({
  placement: "app-layout:placement",
  maximize: "app-layout:maximize",
  /** Suffixed with the destination stack id. */
  dockIntoPrefix: "app-layout:dock-into:",
} as const);

/** Renderer-local surface actions that are not multiplexer verbs. */
export const SURFACE_MENU_IDS = Object.freeze({
  openSession: "surface:open-session",
  renameWindowInline: "surface:rename-window",
  renameSessionInline: "surface:rename-session",
} as const);

export function dockIntoStackMenuId(stackId: string): string {
  return `${APP_LAYOUT_MENU_IDS.dockIntoPrefix}${stackId}`;
}

export function stackIdFromDockIntoMenuId(itemId: string): string | null {
  return itemId.startsWith(APP_LAYOUT_MENU_IDS.dockIntoPrefix)
    ? itemId.slice(APP_LAYOUT_MENU_IDS.dockIntoPrefix.length)
    : null;
}

/**
 * The qualifier printed after any item that does not reach tmux.
 *
 * Short on purpose: it has to fit beside a label without turning the menu into
 * prose, and the section note carries the full sentence.
 */
export const APP_LAYOUT_QUALIFIER = "app layout";

const APP_LAYOUT_NOTE =
  "Arranges cards on this canvas only. The tmux layout is unchanged, and an ssh client sees the original.";

/**
 * App shortcuts for verbs the desktop app itself binds today.
 *
 * Empty, and deliberately so. The menu teaches real bindings or none: the
 * keybinding bridge that reads a user's tmux configuration does not exist yet
 * (see the verb table's module comment), and the app has bound no key of its
 * own to a multiplexer verb. An invented hint would teach a key that does
 * nothing. Entries added here appear in every menu that offers the verb.
 */
export const APP_VERB_KEY_HINTS: ReadonlyMap<MultiplexerVerbId, string> = new Map();

function keyHintFor(verb: MultiplexerVerbEntry): string | null {
  return verb.tmuxKeyHint ?? APP_VERB_KEY_HINTS.get(verb.id as MultiplexerVerbId) ?? null;
}

/**
 * One verb as a menu item.
 *
 * `overrideReason` exists for the facts a surface knows and the availability
 * engine cannot: a fleet row for a session that is not open as a workspace has
 * no workspace name to address, so its verbs are refused with a reason the
 * table could never have computed.
 */
export function verbMenuItem(
  verbId: MultiplexerVerbId,
  facts: MultiplexerVerbFacts,
  overrideReason?: string | null,
): ContextMenuItem {
  const verb = multiplexerVerb(verbId);
  const availability = multiplexerVerbAvailability(verb, facts);
  const reason = overrideReason ?? (availability.available ? null : availability.reason);
  return {
    id: verb.id,
    label: verb.label,
    description: verb.description,
    disabledReason: reason,
    destructive: verb.destructive,
    keyHint: keyHintFor(verb),
    qualifier: verb.execution.kind === "app-window" ? APP_LAYOUT_QUALIFIER : null,
  };
}

function appLayoutItem(input: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly disabledReason: string | null;
}): ContextMenuItem {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    disabledReason: input.disabledReason,
    destructive: false,
    keyHint: null,
    qualifier: APP_LAYOUT_QUALIFIER,
  };
}

/** A stack the canvas can dock a window into, named by its visible member. */
export interface DockStackTarget {
  readonly stackId: string;
  readonly label: string;
}

export interface WindowCardMenuInput {
  readonly facts: MultiplexerVerbFacts;
  readonly placement: "docked" | "floating";
  readonly maximized: boolean;
  /** False when the host cannot durably execute AppWindow commands. */
  readonly appLayoutAvailable: boolean;
  readonly appLayoutUnavailableReason?: string;
  /** Stacks other than this window's own. Empty when the canvas has none. */
  readonly dockTargets: readonly DockStackTarget[];
}

/**
 * The menu for a window card: what tmux can do to the pane, what it can do to
 * the window, and — kept visibly apart — what the canvas can do to the card.
 */
export function windowCardMenuSections(input: WindowCardMenuInput): readonly ContextMenuSection[] {
  const layoutReason = input.appLayoutAvailable
    ? null
    : (input.appLayoutUnavailableReason ?? "Window mutations are unavailable in this host");
  const docked = input.placement === "docked";
  return [
    {
      id: "pane",
      label: "This pane",
      items: [
        verbMenuItem("pane.select", input.facts),
        verbMenuItem("pane.split.right", input.facts),
        verbMenuItem("pane.split.down", input.facts),
        verbMenuItem("pane.kill", input.facts),
      ],
    },
    {
      id: "window",
      label: "This window",
      items: [
        verbMenuItem("window.rename", input.facts),
        verbMenuItem("window.zoom.toggle", input.facts),
        verbMenuItem("window.kill", input.facts),
      ],
    },
    {
      id: "session",
      label: "This session",
      items: [verbMenuItem("window.new", input.facts)],
    },
    {
      id: "arrange",
      label: "Arrange",
      note: APP_LAYOUT_NOTE,
      items: [
        appLayoutItem({
          id: APP_LAYOUT_MENU_IDS.placement,
          label: docked ? "Float this window" : "Dock this window",
          description: docked
            ? "Lift the card off the dock and place it freely on the canvas"
            : "Return the card to the dock",
          disabledReason: layoutReason,
        }),
        appLayoutItem({
          id: APP_LAYOUT_MENU_IDS.maximize,
          label: input.maximized ? "Restore card size" : "Maximize card",
          description: input.maximized
            ? "Return the floating card to its previous size"
            : "Fill the canvas with this floating card",
          disabledReason:
            layoutReason ?? (docked ? "Float this window before maximizing its card" : null),
        }),
        ...input.dockTargets.map((target) =>
          appLayoutItem({
            id: dockIntoStackMenuId(target.stackId),
            label: `Dock into ${target.label}`,
            description: `Add this window to the stack showing ${target.label}, as a tab`,
            disabledReason: layoutReason,
          }),
        ),
        verbMenuItem("stack.activate", input.facts),
      ],
    },
  ];
}

export interface CanvasMenuInput {
  readonly facts: MultiplexerVerbFacts;
}

/** The menu for bare canvas: where creation starts, and the session's own verbs. */
export function canvasMenuSections(input: CanvasMenuInput): readonly ContextMenuSection[] {
  return [
    {
      id: "create",
      label: "Create",
      items: [verbMenuItem("window.new", input.facts), verbMenuItem("session.new", input.facts)],
    },
    {
      id: "session",
      label: "This session",
      items: [
        verbMenuItem("session.rename", input.facts),
        verbMenuItem("session.detach", input.facts),
        verbMenuItem("session.kill", input.facts),
      ],
    },
  ];
}

export interface SessionRowMenuInput {
  readonly facts: MultiplexerVerbFacts;
  /** True when this row IS the open workspace, so its verbs have a name to address. */
  readonly open: boolean;
  readonly label: string;
}

const NOT_OPEN_REASON = "Open this session as a workspace first";

/**
 * The menu for a fleet session row.
 *
 * A row for a session the app has not opened carries no workspace name, so its
 * verbs cannot be addressed at all. They are still listed, refused with the one
 * thing the user can do about it, which is the item directly above them.
 */
export function sessionRowMenuSections(input: SessionRowMenuInput): readonly ContextMenuSection[] {
  const notOpen = input.open ? null : NOT_OPEN_REASON;
  return [
    {
      id: "workspace",
      label: input.label,
      items: [
        {
          id: SURFACE_MENU_IDS.openSession,
          label: "Open as workspace",
          description: "Register this session with the app and open it here",
          disabledReason: input.open ? "This session is already open" : null,
          destructive: false,
          keyHint: null,
          qualifier: null,
        },
        verbMenuItem("session.rename", input.facts, notOpen),
        verbMenuItem("session.detach", input.facts, notOpen),
        verbMenuItem("session.kill", input.facts, notOpen),
      ],
    },
  ];
}
