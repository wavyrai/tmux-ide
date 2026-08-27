import {
  WorkspaceMultiplexerMutationResultSchemaZ,
  type InteractionProof,
  type InteractionSafeSummary,
  type InteractionTarget,
  type SessionRuntimeSemanticIntent,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";

export interface SessionRuntimeInteractionFacts {
  readonly target: InteractionTarget;
  readonly summary: InteractionSafeSummary;
}

/** Privacy-safe request facts. Literal input and authored names never leave the mutation request. */
export function sessionRuntimeInteractionFacts(
  intent: SessionRuntimeSemanticIntent,
): SessionRuntimeInteractionFacts {
  switch (intent.verb) {
    case "workspace.window.split":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb, direction: intent.direction },
      };
    case "workspace.window.kill":
      return {
        target: { kind: "window", target: intent.target },
        summary: { operationKind: intent.verb },
      };
    case "workspace.pane.kill":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb },
      };
    case "workspace.session.kill":
      return { target: { kind: "session" }, summary: { operationKind: intent.verb } };
    case "workspace.rename":
      if (intent.scope === "session")
        return {
          target: { kind: "session" },
          summary: { operationKind: intent.verb, scope: intent.scope },
        };
      if (intent.scope === "pane")
        return {
          target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
          summary: { operationKind: intent.verb, scope: intent.scope },
        };
      return {
        target: { kind: "window", target: intent.target },
        summary: { operationKind: intent.verb, scope: intent.scope },
      };
    case "workspace.pane.zoom.toggle":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb, desired: intent.desired },
      };
    case "workspace.pane.select":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb },
      };
    case "workspace.pane.send":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: {
          operationKind: intent.verb,
          characterCount: Array.from(intent.text).length,
          byteCount: Buffer.byteLength(intent.text, "utf8"),
          submitted: intent.submit,
        },
      };
    case "workspace.pane.swap":
      return {
        target: { kind: "pane", semanticPaneId: intent.sourceSemanticPaneId },
        summary: {
          operationKind: intent.verb,
          targetSemanticPaneId: intent.targetSemanticPaneId,
        },
      };
    case "workspace.pane.resize":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb, axis: intent.axis, cells: intent.cells },
      };
    case "workspace.pane.read":
      return {
        target: { kind: "pane", semanticPaneId: intent.semanticPaneId },
        summary: { operationKind: intent.verb, observedOnly: true },
      };
  }
}

/** Convert verified lower-authority results into the receipt contract's bounded proof vocabulary. */
export function sessionRuntimeObservedProof(
  intent: SessionRuntimeSemanticIntent,
  rawResult: WorkspaceMultiplexerMutationResult | void,
): InteractionProof {
  if (intent.verb === "workspace.pane.read") {
    if (rawResult !== undefined) throw new TypeError("Pane read returned an unexpected result");
    return { operationKind: intent.verb, observed: true, semanticPaneId: intent.semanticPaneId };
  }
  const result = WorkspaceMultiplexerMutationResultSchemaZ.parse(rawResult);
  if (result.verb !== intent.verb)
    throw new TypeError("Mutation result verb does not match intent");
  switch (result.verb) {
    case "workspace.window.split":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        direction: result.direction,
        semanticPaneId: result.semanticPaneId,
      };
    case "workspace.window.kill":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        remainingWindowCount: result.remainingWindowCount,
      };
    case "workspace.pane.kill":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        semanticPaneId: (
          intent as Extract<SessionRuntimeSemanticIntent, { verb: "workspace.pane.kill" }>
        ).semanticPaneId,
        windowClosed: result.windowClosed,
        remainingWindowCount: result.remainingWindowCount,
      };
    case "workspace.session.kill":
      return { operationKind: result.verb, outcome: result.outcome };
    case "workspace.rename":
      return { operationKind: result.verb, outcome: result.outcome, scope: result.scope };
    case "workspace.pane.zoom.toggle":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        semanticPaneId: result.semanticPaneId,
        zoomed: result.zoomed,
      };
    case "workspace.pane.select":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        semanticPaneId: result.semanticPaneId,
      };
    case "workspace.pane.send":
      return { operationKind: result.verb, observed: true, semanticPaneId: result.semanticPaneId };
    case "workspace.pane.swap":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        sourceSemanticPaneId: result.sourceSemanticPaneId,
        targetSemanticPaneId: result.targetSemanticPaneId,
      };
    case "workspace.pane.resize":
      return {
        operationKind: result.verb,
        outcome: result.outcome,
        semanticPaneId: result.semanticPaneId,
        axis: result.axis,
        cells: result.cells,
      };
  }
}

export function sessionRuntimeIntentNeedsTmuxObservation(
  intent: SessionRuntimeSemanticIntent,
): intent is Extract<
  SessionRuntimeSemanticIntent,
  { verb: "workspace.pane.send" | "workspace.pane.read" }
> {
  return intent.verb === "workspace.pane.send" || intent.verb === "workspace.pane.read";
}
