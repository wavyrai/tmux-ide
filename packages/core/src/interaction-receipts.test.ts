import { describe, expect, it } from "vitest";

import {
  initialInteractionFeedState,
  interactionForPane,
  paneInteractionRelationshipLabel,
  reduceInteractionReceipt,
} from "./interaction-receipts.ts";

const base = {
  type: "interaction.receipt" as const,
  operationId: "10000000-0000-4000-8000-000000000001",
  origin: "sdk" as const,
  workspaceName: "workspace.alpha",
  sourceSemanticPaneId: null,
  semanticPaneId: "pane.alpha",
  operationKind: "workspace.pane.send" as const,
  summary: { characterCount: 84, byteCount: 84, submitted: true },
  at: "2026-08-10T10:00:00.000Z",
  resourceRevision: null,
};

describe("interaction receipt reducer", () => {
  it("advances one operation in place and projects pane feedback", () => {
    const accepted = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "accepted",
    });
    const applied = reduceInteractionReceipt(accepted, {
      ...base,
      sequence: 2,
      phase: "applied",
    });

    expect(applied.activity).toHaveLength(1);
    expect(applied.activity[0]?.phase).toBe("applied");
    expect(interactionForPane(applied, "pane.alpha")).toMatchObject({
      phase: "applied",
      label: "sdk applied · delivered 84 characters + Enter",
    });
  });

  it("ignores duplicate replay frames", () => {
    const current = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 3,
      phase: "applied",
    });
    expect(reduceInteractionReceipt(current, { ...base, sequence: 3, phase: "applied" })).toBe(
      current,
    );
  });

  it("never derives activity copy from literal input", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "applied",
    });
    expect(JSON.stringify(state)).not.toContain("prompt");
    expect(JSON.stringify(state)).toContain("84 characters");
  });

  it("projects metadata-only external observation without invented counts", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      origin: "external",
      phase: "observed",
      summary: { observedOnly: true },
    });
    expect(interactionForPane(state, "pane.alpha")?.label).toBe(
      "external observed · input observed",
    );
    expect(JSON.stringify(state)).not.toMatch(/characterCount|byteCount|submitted/u);
  });

  it("projects one authenticated pane relationship onto both endpoints", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "applied",
      sourceSemanticPaneId: "pane.editor",
      semanticPaneId: "pane.tests",
    });

    expect(interactionForPane(state, "pane.editor")).toMatchObject({
      direction: "outgoing",
      sourcePaneId: "pane.editor",
      destinationPaneId: "pane.tests",
    });
    expect(interactionForPane(state, "pane.tests")).toMatchObject({
      direction: "incoming",
      sourcePaneId: "pane.editor",
      destinationPaneId: "pane.tests",
    });
    expect(
      paneInteractionRelationshipLabel(
        interactionForPane(state, "pane.tests")!,
        (paneId) => ({ "pane.editor": "Editor", "pane.tests": "Tests" })[paneId] ?? paneId,
      ),
    ).toBe("Editor → Tests");
  });

  it("labels raw tmux traffic as external without inventing a source", () => {
    expect(
      paneInteractionRelationshipLabel({
        origin: "external",
        sourcePaneId: null,
        destinationPaneId: "pane.tests",
      }),
    ).toBe("External input → pane.tests");
  });

  it("projects pane reads without retaining captured terminal content", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      origin: "external",
      operationKind: "workspace.pane.read",
      phase: "observed",
      summary: { observedOnly: true },
      semanticPaneId: "pane.tests",
    });
    const interaction = interactionForPane(state, "pane.tests")!;
    expect(interaction).toMatchObject({
      operationKind: "workspace.pane.read",
      direction: "incoming",
      sourcePaneId: null,
    });
    expect(paneInteractionRelationshipLabel(interaction, () => "Tests")).toBe(
      "External reader reads Tests",
    );
    expect(JSON.stringify(state)).not.toContain("content");
  });
});
