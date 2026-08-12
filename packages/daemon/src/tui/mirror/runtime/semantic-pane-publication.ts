import type { SemanticPaneReplicaChange } from "../semantic-pane-render-source.ts";

export interface SemanticPanePublication {
  readonly publishContentVersion: (version: number) => void;
  readonly publishStructure: () => void;
}

/**
 * Keep terminal pixels on their retained-surface lane. Only changes consumed by
 * geometry, chrome, scrollback, or input routing wake the structural projector.
 */
export function publishSemanticPaneChange(
  change: SemanticPaneReplicaChange,
  publication: SemanticPanePublication,
): void {
  publication.publishContentVersion(change.version);
  if (
    change.kind === "closed" ||
    change.renderKeyChanged ||
    change.scrollbackChanged ||
    change.runtimeFactsChanged
  ) {
    publication.publishStructure();
  }
}
