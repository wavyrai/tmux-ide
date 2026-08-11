import { describe, expect, it } from "vitest";

import {
  initialInteractionFeedState,
  interactionForPane,
  interactionPresenceIsFresh,
  interactionReceiptLabel,
  paneInteractionPresence,
  paneInteractionRelationshipLabel,
  reduceInteractionReceipt,
} from "./interaction-receipts.ts";

const base = {
  type: "interaction.receipt" as const,
  operationId: "10000000-0000-4000-8000-000000000001",
  origin: "sdk" as const,
  workspaceName: "workspace.alpha",
  sourceSemanticPaneId: null,
  target: { kind: "pane" as const, semanticPaneId: "pane.alpha" },
  operationKind: "workspace.pane.send" as const,
  summary: {
    operationKind: "workspace.pane.send" as const,
    characterCount: 84,
    byteCount: 84,
    submitted: true,
  },
  proof: null,
  at: "2026-08-10T10:00:00.000Z",
  resourceRevision: null,
};

describe("interaction receipt reducer", () => {
  it("keeps replay history without reviving stale visual presence", () => {
    const now = Date.parse("2026-08-10T10:00:04.000Z");
    expect(interactionPresenceIsFresh({ at: "2026-08-10T10:00:02.000Z" }, now)).toBe(true);
    expect(interactionPresenceIsFresh({ at: "2026-08-10T09:59:59.000Z" }, now)).toBe(false);
    expect(interactionPresenceIsFresh({ at: "not-a-date" }, now)).toBe(false);
  });
  it("advances one operation in place and projects pane feedback", () => {
    const accepted = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "accepted",
    });
    const observed = reduceInteractionReceipt(accepted, {
      ...base,
      sequence: 2,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });

    expect(observed.activity).toHaveLength(1);
    expect(observed.activity[0]?.phase).toBe("observed");
    expect(interactionForPane(observed, "pane.alpha")).toMatchObject({
      phase: "observed",
      label: "sdk observed · delivered 84 characters + Enter",
    });
  });

  it("ignores duplicate replay frames", () => {
    const current = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 3,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(
      reduceInteractionReceipt(current, {
        ...base,
        sequence: 3,
        phase: "observed",
        proof: {
          operationKind: "workspace.pane.send",
          observed: true,
          semanticPaneId: "pane.alpha",
        },
      }),
    ).toBe(current);
  });

  it("never derives activity copy from literal input", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
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
      summary: { operationKind: "workspace.pane.send", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
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
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.tests",
      },
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
      summary: { operationKind: "workspace.pane.read", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.read",
        observed: true,
        semanticPaneId: "pane.tests",
      },
      target: { kind: "pane", semanticPaneId: "pane.tests" },
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

  it("keeps observation, transfer, and focus as separate semantics", () => {
    const read = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      operationKind: "workspace.pane.read",
      phase: "observed",
      summary: { operationKind: "workspace.pane.read", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.read",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(paneInteractionPresence(interactionForPane(read, "pane.alpha")!)).toEqual({
      role: "read-target",
      kind: "read",
      endpoint: "target",
      treatment: "observation",
      tone: "info",
      badge: "READ",
    });

    const send = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.tests",
      },
    });
    expect(paneInteractionPresence(interactionForPane(send, "pane.editor")!)).toMatchObject({
      role: "send-source",
      treatment: "transfer",
      badge: "SENT",
    });
    expect(paneInteractionPresence(interactionForPane(send, "pane.tests")!)).toMatchObject({
      role: "send-target",
      badge: "RECEIVED",
    });
    expect(paneInteractionPresence(interactionForPane(send, "pane.tests")!)).not.toHaveProperty(
      "focused",
    );
  });

  it("keeps structural receipts in Activity without inventing pane communication", () => {
    const state = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      operationKind: "workspace.pane.resize",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      phase: "observed",
      summary: { operationKind: "workspace.pane.resize", axis: "cols", cells: 120 },
      proof: {
        operationKind: "workspace.pane.resize",
        outcome: "applied",
        semanticPaneId: "pane.tests",
        axis: "cols",
        cells: 118,
      },
    });

    expect(state.activity[0]).toMatchObject({
      operationKind: "workspace.pane.resize",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
    });
    expect(state.activity[0]?.summary).not.toHaveProperty("text");
    expect(state.panes).toEqual({});
  });

  it("uses request-neutral copy until a mutation is actually observed", () => {
    const closePane = {
      ...base,
      operationKind: "workspace.pane.kill" as const,
      summary: { operationKind: "workspace.pane.kill" as const },
    };
    expect(interactionReceiptLabel({ ...closePane, sequence: 1, phase: "accepted" })).toBe(
      "sdk accepted · close pane",
    );
    expect(interactionReceiptLabel({ ...closePane, sequence: 2, phase: "rejected" })).toBe(
      "sdk rejected · close pane",
    );
    expect(interactionReceiptLabel({ ...closePane, sequence: 3, phase: "timed-out" })).toBe(
      "sdk timed out · close pane",
    );
    expect(
      interactionReceiptLabel({
        ...closePane,
        sequence: 4,
        phase: "observed",
        proof: {
          operationKind: "workspace.pane.kill",
          outcome: "applied",
          semanticPaneId: "pane.alpha",
          windowClosed: false,
          remainingWindowCount: 2,
        },
      }),
    ).toBe("sdk observed · pane closed");

    expect(interactionReceiptLabel({ ...base, sequence: 5, phase: "accepted" })).toContain(
      "send 84 characters",
    );
    expect(interactionReceiptLabel({ ...base, sequence: 6, phase: "rejected" })).not.toMatch(
      /delivered|received/u,
    );
  });

  it("enforces immutable operation identity and one-way lifecycle transitions", () => {
    const accepted = reduceInteractionReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "accepted",
    });
    const withStaleProjection = {
      ...accepted,
      panes: Object.freeze({
        ...accepted.panes,
        "pane.stale": {
          ...accepted.panes["pane.alpha"]!,
          paneId: "pane.stale",
        },
      }),
    };
    const observed = reduceInteractionReceipt(withStaleProjection, {
      ...base,
      sequence: 2,
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(observed.activity[0]?.phase).toBe("observed");
    expect(observed.panes).not.toHaveProperty("pane.stale");
    expect(observed.panes).toHaveProperty("pane.editor");

    const regressed = reduceInteractionReceipt(observed, {
      ...base,
      sequence: 3,
      phase: "accepted",
    });
    expect(regressed.sequence).toBe(3);
    expect(regressed.activity[0]?.phase).toBe("observed");
    expect(regressed.panes["pane.alpha"]?.sequence).toBe(2);

    const mutated = reduceInteractionReceipt(regressed, {
      ...base,
      sequence: 4,
      phase: "observed",
      target: { kind: "pane", semanticPaneId: "pane.other" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.other",
      },
    });
    expect(mutated.sequence).toBe(4);
    expect(mutated.activity[0]?.target).toEqual({
      kind: "pane",
      semanticPaneId: "pane.alpha",
    });
    expect(mutated.panes).not.toHaveProperty("pane.other");
  });
});
