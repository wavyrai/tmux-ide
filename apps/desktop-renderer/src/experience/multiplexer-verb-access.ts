/**
 * The renderer's one way to reach a multiplexer verb.
 *
 * Surfaces — context menus, pane chrome, the palette, the sidebar — arrive in
 * m49.2. This is what they will all call, and it exists first so that none of
 * them has to decide for itself what a verb is, when to offer it, or which
 * daemon route runs it. Those answers live in the contracts table; everything
 * here is the small amount of glue that turns a click on a target into the
 * invocation that table describes.
 *
 * The intent builder is pure and separately tested, because it is the step that
 * can be quietly wrong: a verb dispatched against the wrong scope's identity
 * produces a well-formed request that acts on something the user did not point
 * at.
 */
import {
  MULTIPLEXER_VERB_TABLE,
  multiplexerVerb,
  multiplexerVerbAvailability,
  type MultiplexerVerbAvailability,
  type MultiplexerVerbEntry,
  type MultiplexerVerbFacts,
  type MultiplexerVerbId,
  type MultiplexerVerbInvocation,
  type MultiplexerVerbScope,
  type WorkspaceMultiplexerHostResult,
  type WorkspaceMultiplexerIntent,
} from "@tmux-ide/contracts";

/**
 * What a surface knows about the thing the user clicked.
 *
 * Every field is optional because surfaces legitimately address different
 * scopes — a fleet row names a workspace and nothing else. A verb whose scope
 * needs an identity the target does not carry cannot be built, and
 * {@link multiplexerVerbIntent} answers null rather than guessing one.
 */
export interface MultiplexerVerbTarget {
  readonly workspaceName: string;
  readonly semanticPaneId?: string;
  readonly semanticWindowId?: string;
}

/** Extra input a verb needs beyond its target, such as a new name. */
export interface MultiplexerVerbArguments {
  readonly name?: string;
  readonly displayTitle?: string;
  readonly desiredZoom?: "toggle" | "zoomed" | "unzoomed";
  /** One axis and the size in cells the border drag settled on. */
  readonly resize?: { readonly axis: "cols" | "rows"; readonly cells: number };
}

/**
 * Build the daemon intent for one verb against one target.
 *
 * PURE. Returns null when the verb is not a daemon action (stack.activate goes
 * through the AppWindow command path, detach never leaves the client) or when
 * the target lacks the identity the verb's scope requires.
 */
export function multiplexerVerbIntent(
  verbId: MultiplexerVerbId,
  target: MultiplexerVerbTarget,
  args: MultiplexerVerbArguments = {},
): WorkspaceMultiplexerIntent | null {
  const workspaceName = target.workspaceName;
  const windowTarget = target.semanticWindowId
    ? ({ by: "window", semanticWindowId: target.semanticWindowId } as const)
    : target.semanticPaneId
      ? ({ by: "pane", semanticPaneId: target.semanticPaneId } as const)
      : null;

  switch (verbId) {
    case "pane.split.right":
    case "pane.split.down":
      if (!target.semanticPaneId) return null;
      return {
        verb: "workspace.window.split",
        workspaceName,
        semanticPaneId: target.semanticPaneId,
        direction: verbId === "pane.split.right" ? "right" : "down",
        ...(args.displayTitle ? { displayTitle: args.displayTitle } : {}),
      };
    case "pane.kill":
      if (!target.semanticPaneId) return null;
      return { verb: "workspace.pane.kill", workspaceName, semanticPaneId: target.semanticPaneId };
    case "pane.select":
      if (!target.semanticPaneId) return null;
      return {
        verb: "workspace.pane.select",
        workspaceName,
        semanticPaneId: target.semanticPaneId,
      };
    case "window.zoom.toggle":
      if (!target.semanticPaneId) return null;
      return {
        verb: "workspace.pane.zoom.toggle",
        workspaceName,
        semanticPaneId: target.semanticPaneId,
        desired: args.desiredZoom ?? "toggle",
      };
    case "pane.resize":
      if (!target.semanticPaneId || !args.resize) return null;
      return {
        verb: "workspace.pane.resize",
        workspaceName,
        semanticPaneId: target.semanticPaneId,
        axis: args.resize.axis,
        cells: args.resize.cells,
      };
    case "window.kill":
      if (!windowTarget) return null;
      return { verb: "workspace.window.kill", workspaceName, target: windowTarget };
    case "window.rename":
      if (!windowTarget || !args.name) return null;
      return {
        verb: "workspace.rename",
        scope: "window",
        workspaceName,
        target: windowTarget,
        name: args.name,
      };
    case "session.rename":
      if (!args.name) return null;
      return { verb: "workspace.rename", scope: "session", workspaceName, name: args.name };
    case "session.kill":
      return { verb: "workspace.session.kill", workspaceName };
    default:
      // session.new and window.new have their own creation flows; session.detach
      // and stack.activate never reach this route.
      return null;
  }
}

/** The invocation the `invokeVerb` resource carries, or null if unbuildable. */
export function multiplexerVerbInvocation(
  verbId: MultiplexerVerbId,
  target: MultiplexerVerbTarget,
  args: MultiplexerVerbArguments = {},
): MultiplexerVerbInvocation | null {
  const intent = multiplexerVerbIntent(verbId, target, args);
  return intent ? { verbId, intent } : null;
}

/** One verb as a surface renders it: the entry plus whether it is offered here. */
export interface MultiplexerVerbOffer {
  readonly verb: MultiplexerVerbEntry;
  readonly availability: MultiplexerVerbAvailability;
}

export interface MultiplexerVerbAccess {
  readonly verbs: readonly MultiplexerVerbEntry[];
  /**
   * Every verb for one scope with its availability resolved. Unavailable verbs
   * are returned, not filtered: a surface renders them disabled with the reason
   * so the rule is learnable rather than invisible.
   */
  offers(scope: MultiplexerVerbScope, facts: MultiplexerVerbFacts): readonly MultiplexerVerbOffer[];
  invoke(
    verbId: MultiplexerVerbId,
    target: MultiplexerVerbTarget,
    args?: MultiplexerVerbArguments,
  ): Promise<WorkspaceMultiplexerHostResult>;
}

export interface MultiplexerVerbHost {
  readonly daemon: {
    invokeVerb(request: MultiplexerVerbInvocation): Promise<WorkspaceMultiplexerHostResult>;
  };
}

/**
 * The accessor every future mouse surface uses.
 *
 * Deliberately not a Solid context: the table is a frozen module constant and
 * carries no reactive state, so a provider would add a lifetime for nothing.
 */
export function useVerbTable(host: MultiplexerVerbHost): MultiplexerVerbAccess {
  return {
    verbs: MULTIPLEXER_VERB_TABLE,
    offers: (scope, facts) =>
      MULTIPLEXER_VERB_TABLE.filter((verb) => verb.scope === scope).map((verb) => ({
        verb,
        availability: multiplexerVerbAvailability(verb, facts),
      })),
    invoke: async (verbId, target, args) => {
      const invocation = multiplexerVerbInvocation(verbId, target, args);
      if (!invocation) {
        return {
          status: "error",
          error: {
            code: "invalid-request",
            reason: `${multiplexerVerb(verbId).label} cannot be run against this target`,
          },
        };
      }
      return host.daemon.invokeVerb(invocation);
    },
  };
}
