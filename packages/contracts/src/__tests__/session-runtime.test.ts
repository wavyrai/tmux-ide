import { describe, expect, it } from "vitest";

import { SessionRuntimeSemanticIntentSchemaZ } from "../session-runtime.ts";
import { InteractionReceiptSchemaZ } from "../interaction-receipts.ts";

describe("session runtime architecture contract", () => {
  it("accepts semantic intents and refuses raw tmux addresses", () => {
    const intent = {
      verb: "workspace.pane.read",
      workspaceName: "project",
      semanticPaneId: "pane.editor",
      origin: "tui",
    };
    expect(SessionRuntimeSemanticIntentSchemaZ.parse(intent)).toEqual(intent);
    expect(SessionRuntimeSemanticIntentSchemaZ.safeParse({ ...intent, paneId: "%7" }).success).toBe(
      false,
    );
    expect(
      SessionRuntimeSemanticIntentSchemaZ.safeParse({
        verb: "workspace.window.split",
        workspaceName: "project",
        semanticPaneId: "pane.editor",
        direction: "right",
      }).success,
    ).toBe(true);
  });

  it.each(["accepted", "observed", "rejected", "timed-out"] as const)(
    "models the %s receipt phase",
    (phase) => {
      expect(
        InteractionReceiptSchemaZ.parse({
          type: "interaction.receipt",
          operationId: "2a50f1d4-6f57-4f02-8b10-b94bf24967ec",
          sequence: 1,
          phase,
          origin: "tui",
          workspaceName: "project",
          semanticPaneId: "pane.editor",
          sourceSemanticPaneId: null,
          operationKind: "workspace.pane.read",
          summary: { observedOnly: true },
          at: "2026-08-11T10:00:00.000Z",
          resourceRevision: null,
        }).phase,
      ).toBe(phase);
    },
  );
});
