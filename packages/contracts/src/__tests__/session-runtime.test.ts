import { describe, expect, it } from "vitest";

import {
  SessionRuntimeControllerLeaseSchemaZ,
  SessionRuntimeControllerSnapshotSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
} from "../session-runtime.ts";
import { InteractionReceiptSchemaZ } from "../interaction-receipts.ts";

describe("session runtime architecture contract", () => {
  it("pins controller capabilities to one client, session, revision, and daemon generation", () => {
    const lease = {
      generation: "11111111-1111-4111-8111-111111111111",
      session: "alpha",
      clientId: "web:stable-client",
      token: "22222222-2222-4222-8222-222222222222",
      revision: 1,
    };
    expect(SessionRuntimeControllerLeaseSchemaZ.parse(lease)).toEqual(lease);
    expect(SessionRuntimeControllerLeaseSchemaZ.safeParse({ ...lease, revision: 0 }).success).toBe(
      false,
    );
    expect(
      SessionRuntimeControllerLeaseSchemaZ.safeParse({ ...lease, clientId: "%7\n" }).success,
    ).toBe(false);
    expect(
      SessionRuntimeControllerSnapshotSchemaZ.parse({
        generation: lease.generation,
        session: lease.session,
        controllerClientId: null,
        revision: 0,
      }),
    ).toMatchObject({ controllerClientId: null, revision: 0 });
  });

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

  it("publishes authenticated source identity only on the final observed receipt", () => {
    const base = {
      type: "interaction.receipt" as const,
      operationId: "2a50f1d4-6f57-4f02-8b10-b94bf24967ec",
      sequence: 1,
      origin: "sdk" as const,
      workspaceName: "project",
      semanticPaneId: "pane.tests",
      sourceSemanticPaneId: "pane.editor",
      operationKind: "workspace.pane.send" as const,
      summary: { characterCount: 4, byteCount: 4, submitted: true },
      at: "2026-08-11T10:00:00.000Z",
      resourceRevision: null,
    };
    expect(InteractionReceiptSchemaZ.safeParse({ ...base, phase: "observed" }).success).toBe(true);
    expect(InteractionReceiptSchemaZ.safeParse({ ...base, phase: "accepted" }).success).toBe(false);
    expect(
      InteractionReceiptSchemaZ.safeParse({ ...base, origin: "external", phase: "observed" })
        .success,
    ).toBe(false);
  });
});
