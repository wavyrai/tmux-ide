/**
 * The multiplexer verb table — one declaration of every tmux verb the product
 * offers, shared by every mouse surface.
 *
 * The m48 audit found seven of sixteen multiplexer verbs mouse-reachable, and
 * the four that were reachable through the canvas mutated only the app's own
 * layout document. The cause was structural: each surface invented its own verb
 * list, so a verb existed exactly where someone had remembered to add it. This
 * table is the fix. A context menu, the palette, pane chrome and the sidebar all
 * render FROM these entries; none of them may name a verb that is not here.
 *
 * What an entry is: identity, presentation, the scope of object it acts on, the
 * execution route that performs it, the facts a surface must gather to decide
 * whether it is offered, and whether it destroys something. What an entry is
 * NOT: a handler. Effects live in the process that owns them — the daemon for
 * tmux mutations, the renderer for view-local ones — exactly as
 * {@link ./commands.ts} already requires of command descriptors.
 *
 * The tmux key hint is declared but unfilled. Teaching the real binding on the
 * menu item is the reference behaviour worth stealing, but the keybinding
 * bridge that reads a user's actual configuration does not exist yet, and a
 * guessed default is worse than an absent one: a user whose prefix table has
 * been remapped would be taught a key that does nothing.
 */
import { z } from "zod";

import { ActionContractsZ, type ActionName } from "./actions-contract.ts";
import { AppWindowMutationCommandSchemaZ } from "./app-window-mutation.ts";

export const MULTIPLEXER_VERB_TABLE_VERSION = 1 as const;

export const MultiplexerVerbIdSchemaZ = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u, "verb id must be a dot-namespaced identifier");

/** The object a verb acts on. Surfaces use this to decide where a verb belongs. */
export const MultiplexerVerbScopeSchemaZ = z.enum(["session", "window", "pane"]);
export type MultiplexerVerbScope = z.infer<typeof MultiplexerVerbScopeSchemaZ>;

const ActionNameSchemaZ = z.enum(
  Object.keys(ActionContractsZ) as [ActionName, ...ActionName[]],
) satisfies z.ZodType<ActionName>;

const AppWindowCommandTypeSchemaZ = z.enum(
  AppWindowMutationCommandSchemaZ.options.map((option) => option.shape.type.value) as [
    string,
    ...string[],
  ],
);

/**
 * How a verb is performed.
 *
 * `daemon-action` verbs cross the owner-gated action dispatcher and change
 * tmux. `app-window` verbs rearrange the daemon-persisted AppWindow document
 * and deliberately do not touch tmux. `renderer` verbs never leave the client.
 *
 * Naming the route in the table is what stops a surface from wiring a verb to
 * whichever call was nearest: `pane.select` reaches tmux, `stack.activate` does
 * not, and the difference is now a field rather than folklore.
 */
export const MultiplexerVerbExecutionSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daemon-action"), action: ActionNameSchemaZ }).strict(),
  z.object({ kind: z.literal("app-window"), command: AppWindowCommandTypeSchemaZ }).strict(),
  z.object({ kind: z.literal("renderer") }).strict(),
]);
export type MultiplexerVerbExecution = z.infer<typeof MultiplexerVerbExecutionSchemaZ>;

/**
 * The facts a surface must supply before it can say whether a verb is offered.
 *
 * Declaring the inputs rather than shipping a closure keeps the table pure data
 * that crosses processes, and it tells a surface author exactly which fields to
 * gather — the omission that produces a menu item which looks live and refuses
 * on click.
 */
export const MultiplexerVerbAvailabilityInputSchemaZ = z.enum([
  "workspaceConnected",
  "sessionWindowCount",
  "windowPaneCount",
  "windowZoomed",
  "targetIsActivePane",
  "targetIsDockedStackMember",
]);
export type MultiplexerVerbAvailabilityInput = z.infer<
  typeof MultiplexerVerbAvailabilityInputSchemaZ
>;

export const MultiplexerVerbEntrySchemaZ = z
  .object({
    version: z.literal(MULTIPLEXER_VERB_TABLE_VERSION),
    id: MultiplexerVerbIdSchemaZ,
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(240),
    scope: MultiplexerVerbScopeSchemaZ,
    execution: MultiplexerVerbExecutionSchemaZ,
    availabilityInputs: z.array(MultiplexerVerbAvailabilityInputSchemaZ).readonly(),
    /** Destructive verbs must be confirmed before dispatch; no surface may skip it. */
    destructive: z.boolean(),
    /**
     * The user's real tmux binding, when the keybinding bridge can read it.
     * Null everywhere today — see the module comment on why a guess is worse.
     */
    tmuxKeyHint: z.string().min(1).max(40).nullable(),
  })
  .strict();
export type MultiplexerVerbEntry = z.infer<typeof MultiplexerVerbEntrySchemaZ>;

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const ENTRIES: readonly MultiplexerVerbEntry[] = [
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "session.new",
    label: "New session",
    description: "Open a project directory as a new tmux-backed workspace session.",
    scope: "session",
    execution: { kind: "daemon-action", action: "workspace.open" },
    availabilityInputs: [],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "session.kill",
    label: "Close session",
    description: "Kill the workspace's tmux session and every window and process inside it.",
    scope: "session",
    execution: { kind: "daemon-action", action: "workspace.session.kill" },
    availabilityInputs: ["workspaceConnected"],
    destructive: true,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "session.rename",
    label: "Rename session",
    description: "Give the workspace's tmux session a new name.",
    scope: "session",
    execution: { kind: "daemon-action", action: "workspace.rename" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "session.detach",
    label: "Detach from session",
    description: "Stop viewing the session here. The session and its processes keep running.",
    scope: "session",
    // Detaching is the client's own business: the session is untouched, so
    // there is nothing for the daemon to authorise. m49.2 gives it a surface.
    execution: { kind: "renderer" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "window.new",
    label: "New terminal or agent",
    description: "Create a tmux window in this session running a shell or a harness.",
    scope: "session",
    execution: { kind: "daemon-action", action: "workspace.pane.create" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "window.kill",
    label: "Close window",
    description: "Kill this tmux window and every pane in it. Refused for a session's last window.",
    scope: "window",
    execution: { kind: "daemon-action", action: "workspace.window.kill" },
    availabilityInputs: ["workspaceConnected", "sessionWindowCount"],
    destructive: true,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "window.rename",
    label: "Rename window",
    description: "Give this tmux window a new name.",
    scope: "window",
    execution: { kind: "daemon-action", action: "workspace.rename" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "window.zoom.toggle",
    label: "Zoom pane",
    description: "Toggle tmux's own pane zoom for this window. Not the canvas card's maximize.",
    scope: "window",
    execution: { kind: "daemon-action", action: "workspace.pane.zoom.toggle" },
    availabilityInputs: ["workspaceConnected", "windowPaneCount", "windowZoomed"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "pane.split.right",
    label: "Split right",
    description: "Split this pane vertically, placing a new shell pane to its right.",
    scope: "pane",
    execution: { kind: "daemon-action", action: "workspace.window.split" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "pane.split.down",
    label: "Split down",
    description: "Split this pane horizontally, placing a new shell pane below it.",
    scope: "pane",
    execution: { kind: "daemon-action", action: "workspace.window.split" },
    availabilityInputs: ["workspaceConnected"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "pane.kill",
    label: "Close pane",
    description:
      "Kill this pane and its process. Refused for the last pane of a session's last window.",
    scope: "pane",
    execution: { kind: "daemon-action", action: "workspace.pane.kill" },
    availabilityInputs: ["workspaceConnected", "windowPaneCount", "sessionWindowCount"],
    destructive: true,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "pane.select",
    label: "Focus pane",
    description: "Make this pane tmux's active pane, so an attached client's cursor follows.",
    scope: "pane",
    execution: { kind: "daemon-action", action: "workspace.pane.select" },
    availabilityInputs: ["workspaceConnected", "targetIsActivePane"],
    destructive: false,
    tmuxKeyHint: null,
  },
  {
    version: MULTIPLEXER_VERB_TABLE_VERSION,
    id: "stack.activate",
    label: "Show in stack",
    description: "Bring this window to the front of its docked stack. The app's layout only.",
    scope: "window",
    execution: { kind: "app-window", command: "stack.activate" },
    availabilityInputs: ["targetIsDockedStackMember"],
    destructive: false,
    tmuxKeyHint: null,
  },
];

/** Every multiplexer verb, in presentation order. Frozen; validated at load. */
export const MULTIPLEXER_VERB_TABLE: readonly MultiplexerVerbEntry[] = deepFreeze(
  ENTRIES.map((entry) => MultiplexerVerbEntrySchemaZ.parse(entry)),
);

export type MultiplexerVerbId = (typeof ENTRIES)[number]["id"];

const BY_ID: ReadonlyMap<string, MultiplexerVerbEntry> = new Map(
  MULTIPLEXER_VERB_TABLE.map((entry) => [entry.id, entry]),
);

export const MULTIPLEXER_VERB_IDS: readonly string[] = Object.freeze(
  MULTIPLEXER_VERB_TABLE.map((entry) => entry.id),
);

export function isMultiplexerVerbId(value: unknown): value is MultiplexerVerbId {
  return typeof value === "string" && BY_ID.has(value);
}

export function multiplexerVerb(id: MultiplexerVerbId): MultiplexerVerbEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new TypeError(`unknown multiplexer verb: ${id}`);
  return entry;
}

export function multiplexerVerbsForScope(
  scope: MultiplexerVerbScope,
): readonly MultiplexerVerbEntry[] {
  return MULTIPLEXER_VERB_TABLE.filter((entry) => entry.scope === scope);
}

/**
 * The facts a surface gathers about one target before offering verbs on it.
 *
 * Every field is optional because a surface legitimately knows less about some
 * targets than others — a fleet row knows the session but not the pane count.
 * A verb whose declared inputs are not all present is unavailable rather than
 * assumed available, which is the failure direction that cannot mislead.
 */
export interface MultiplexerVerbFacts {
  readonly workspaceConnected?: boolean;
  readonly sessionWindowCount?: number;
  readonly windowPaneCount?: number;
  readonly windowZoomed?: boolean;
  readonly targetIsActivePane?: boolean;
  readonly targetIsDockedStackMember?: boolean;
}

export type MultiplexerVerbAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

const AVAILABLE: MultiplexerVerbAvailability = Object.freeze({ available: true as const });

function unavailable(reason: string): MultiplexerVerbAvailability {
  return Object.freeze({ available: false as const, reason });
}

/**
 * Whether a verb is offered for a target, and if not, the reason to show.
 *
 * Surfaces render unavailable verbs disabled-with-reason rather than hiding
 * them: a person who cannot find "close pane" learns nothing, and a person who
 * sees it greyed out with "this is the session's last pane" learns the rule.
 */
export function multiplexerVerbAvailability(
  verb: MultiplexerVerbEntry,
  facts: MultiplexerVerbFacts,
): MultiplexerVerbAvailability {
  for (const input of verb.availabilityInputs) {
    if (facts[input] === undefined) return unavailable(`${input} is unknown`);
  }
  if (verb.availabilityInputs.includes("workspaceConnected") && !facts.workspaceConnected) {
    return unavailable("the workspace is not connected");
  }
  switch (verb.id) {
    case "window.kill":
      return facts.sessionWindowCount! > 1
        ? AVAILABLE
        : unavailable("this is the session's last window");
    case "pane.kill":
      return facts.windowPaneCount! > 1 || facts.sessionWindowCount! > 1
        ? AVAILABLE
        : unavailable("this is the session's last pane");
    case "window.zoom.toggle":
      // An unzoomed single-pane window has nothing to zoom; a zoomed one can
      // always be unzoomed, whatever tmux reports its pane count as.
      return facts.windowZoomed! || facts.windowPaneCount! > 1
        ? AVAILABLE
        : unavailable("this window has only one pane");
    case "pane.select":
      return facts.targetIsActivePane! ? unavailable("this pane is already active") : AVAILABLE;
    case "stack.activate":
      return facts.targetIsDockedStackMember!
        ? AVAILABLE
        : unavailable("this window is not in a docked stack");
    default:
      return AVAILABLE;
  }
}
