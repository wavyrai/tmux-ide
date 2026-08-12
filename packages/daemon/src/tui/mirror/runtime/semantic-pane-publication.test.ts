import { describe, expect, it, vi } from "vitest";

import type { SemanticPaneReplicaChange } from "../semantic-pane-render-source.ts";
import { publishSemanticPaneChange } from "./semantic-pane-publication.ts";

const applied = (
  overrides: Partial<Extract<SemanticPaneReplicaChange, { kind: "applied" }>> = {},
): Extract<SemanticPaneReplicaChange, { kind: "applied" }> => ({
  kind: "applied",
  rows: [4],
  cursorChanged: true,
  renderKeyChanged: false,
  scrollbackChanged: false,
  runtimeFactsChanged: false,
  renderKey: "pane.editor:incarnation",
  version: 7,
  ...overrides,
});

describe("semantic pane publication", () => {
  it("invalidates content exactly once without rebuilding structure for an ordinary row packet", () => {
    const publishContentVersion = vi.fn();
    const publishStructure = vi.fn();

    publishSemanticPaneChange(applied(), { publishContentVersion, publishStructure });

    expect(publishContentVersion).toHaveBeenCalledOnce();
    expect(publishContentVersion).toHaveBeenCalledWith(7);
    expect(publishStructure).not.toHaveBeenCalled();
  });

  it.each([
    ["render identity", applied({ renderKeyChanged: true })],
    ["scrollback depth", applied({ scrollbackChanged: true })],
    ["runtime facts", applied({ runtimeFactsChanged: true })],
    ["closed replica", { kind: "closed", version: 8 } satisfies SemanticPaneReplicaChange],
  ])("publishes structure when %s changes", (_label, change) => {
    const publishContentVersion = vi.fn();
    const publishStructure = vi.fn();

    publishSemanticPaneChange(change, { publishContentVersion, publishStructure });

    expect(publishContentVersion).toHaveBeenCalledOnce();
    expect(publishStructure).toHaveBeenCalledOnce();
  });
});
