import { describe, expect, it } from "vitest";

import {
  SessionRuntimeAuthorityLeaseSchemaZ,
  SessionRuntimeAuthoritySnapshotSchemaZ,
  SessionRuntimeControllerLeaseSchemaZ,
  SessionRuntimeControllerSnapshotSchemaZ,
  SessionRuntimeSemanticIntentSchemaZ,
  SessionRuntimeTerminalInputSchemaZ,
} from "../session-runtime.ts";
import { InteractionReceiptSchemaZ } from "../interaction-receipts.ts";

describe("session runtime architecture contract", () => {
  it("keeps terminal text and named keys as one closed canonical input union", () => {
    expect(SessionRuntimeTerminalInputSchemaZ.parse({ kind: "text", data: "paste界" })).toEqual({
      kind: "text",
      data: "paste界",
    });
    for (const key of ["Up", "Enter", "C-c"]) {
      expect(SessionRuntimeTerminalInputSchemaZ.parse({ kind: "key", data: key })).toEqual({
        kind: "key",
        data: key,
      });
    }
    expect(
      SessionRuntimeTerminalInputSchemaZ.safeParse({ kind: "text", data: "a\0b" }).success,
    ).toBe(false);
    expect(
      SessionRuntimeTerminalInputSchemaZ.safeParse({ kind: "key", data: "Enter; kill-server" })
        .success,
    ).toBe(false);
    expect(
      SessionRuntimeTerminalInputSchemaZ.safeParse({ kind: "key", data: "\u001b[A" }).success,
    ).toBe(false);
  });

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

  it("pins separated authority leases to one capability and generation", () => {
    const lease = {
      generation: "11111111-1111-4111-8111-111111111111",
      session: "alpha",
      clientId: "client:web",
      authority: "geometry" as const,
      token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revision: 3,
    };
    expect(SessionRuntimeAuthorityLeaseSchemaZ.parse(lease)).toEqual(lease);
    expect(
      SessionRuntimeAuthorityLeaseSchemaZ.safeParse({ ...lease, authority: "controller" }).success,
    ).toBe(false);
  });

  it("represents input, focus, and geometry owners independently", () => {
    const snapshot = SessionRuntimeAuthoritySnapshotSchemaZ.parse({
      generation: "11111111-1111-4111-8111-111111111111",
      session: "alpha",
      revision: 7,
      owners: { input: "client:web", focus: null, geometry: "client:tui" },
      nativeGeometryYieldUntilMs: 0,
      clients: [
        {
          clientId: "client:web",
          surface: "web",
          state: "foreground",
          connectedRevision: 1,
          activityRevision: 4,
        },
      ],
    });
    expect(snapshot.owners).toEqual({
      input: "client:web",
      focus: null,
      geometry: "client:tui",
    });
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
          target: { kind: "pane", semanticPaneId: "pane.editor" },
          sourceSemanticPaneId: null,
          operationKind: "workspace.pane.read",
          summary: { operationKind: "workspace.pane.read", observedOnly: true },
          proof:
            phase === "observed"
              ? {
                  operationKind: "workspace.pane.read",
                  observed: true,
                  semanticPaneId: "pane.editor",
                }
              : null,
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
      target: { kind: "pane" as const, semanticPaneId: "pane.tests" },
      sourceSemanticPaneId: "pane.editor",
      operationKind: "workspace.pane.send" as const,
      summary: {
        operationKind: "workspace.pane.send" as const,
        characterCount: 4,
        byteCount: 4,
        submitted: true,
      },
      proof: {
        operationKind: "workspace.pane.send" as const,
        observed: true as const,
        semanticPaneId: "pane.tests",
      },
      at: "2026-08-11T10:00:00.000Z",
      resourceRevision: null,
    };
    expect(InteractionReceiptSchemaZ.safeParse({ ...base, phase: "observed" }).success).toBe(true);
    expect(
      InteractionReceiptSchemaZ.safeParse({ ...base, phase: "accepted", proof: null }).success,
    ).toBe(false);
    expect(
      InteractionReceiptSchemaZ.safeParse({ ...base, origin: "external", phase: "observed" })
        .success,
    ).toBe(false);
  });

  it("contracts every structural verb with a semantic target and privacy-safe proof", () => {
    const receipt = InteractionReceiptSchemaZ.parse({
      type: "interaction.receipt",
      operationId: "3a50f1d4-6f57-4f02-8b10-b94bf24967ec",
      sequence: 2,
      phase: "observed",
      origin: "gui",
      workspaceName: "project",
      sourceSemanticPaneId: null,
      target: { kind: "pane", semanticPaneId: "pane.editor" },
      operationKind: "workspace.pane.resize",
      summary: { operationKind: "workspace.pane.resize", axis: "cols", cells: 120 },
      proof: {
        operationKind: "workspace.pane.resize",
        outcome: "applied",
        semanticPaneId: "pane.editor",
        axis: "cols",
        cells: 118,
      },
      at: "2026-08-11T10:00:00.000Z",
      resourceRevision: 4,
    });
    expect(receipt.proof).toMatchObject({ cells: 118 });
    expect(JSON.stringify(receipt)).not.toMatch(/text|name|path|runtime/u);
    expect(
      InteractionReceiptSchemaZ.safeParse({
        ...receipt,
        target: { kind: "session" },
      }).success,
    ).toBe(false);
  });

  it.each([
    [
      "workspace.window.split",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.window.split", direction: "right" },
      {
        operationKind: "workspace.window.split",
        outcome: "applied",
        direction: "right",
        semanticPaneId: "pane.created",
      },
    ],
    [
      "workspace.window.kill",
      { kind: "window", target: { by: "pane", semanticPaneId: "pane.editor" } },
      { operationKind: "workspace.window.kill" },
      { operationKind: "workspace.window.kill", outcome: "applied", remainingWindowCount: 2 },
    ],
    [
      "workspace.pane.kill",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.kill" },
      {
        operationKind: "workspace.pane.kill",
        outcome: "applied",
        semanticPaneId: "pane.editor",
        windowClosed: false,
        remainingWindowCount: 2,
      },
    ],
    [
      "workspace.session.kill",
      { kind: "session" },
      { operationKind: "workspace.session.kill" },
      { operationKind: "workspace.session.kill", outcome: "applied" },
    ],
    [
      "workspace.rename",
      { kind: "window", target: { by: "window", semanticWindowId: "window.editor" } },
      { operationKind: "workspace.rename", scope: "window" },
      { operationKind: "workspace.rename", outcome: "applied", scope: "window" },
    ],
    [
      "workspace.pane.zoom.toggle",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.zoom.toggle", desired: "zoomed" },
      {
        operationKind: "workspace.pane.zoom.toggle",
        outcome: "applied",
        semanticPaneId: "pane.editor",
        zoomed: true,
      },
    ],
    [
      "workspace.pane.select",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.select" },
      {
        operationKind: "workspace.pane.select",
        outcome: "unchanged",
        semanticPaneId: "pane.editor",
      },
    ],
    [
      "workspace.pane.send",
      { kind: "pane", semanticPaneId: "pane.editor" },
      {
        operationKind: "workspace.pane.send",
        characterCount: 4,
        byteCount: 4,
        submitted: true,
      },
      {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.editor",
      },
    ],
    [
      "workspace.pane.swap",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.swap", targetSemanticPaneId: "pane.tests" },
      {
        operationKind: "workspace.pane.swap",
        outcome: "applied",
        sourceSemanticPaneId: "pane.editor",
        targetSemanticPaneId: "pane.tests",
      },
    ],
    [
      "workspace.pane.resize",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.resize", axis: "cols", cells: 120 },
      {
        operationKind: "workspace.pane.resize",
        outcome: "applied",
        semanticPaneId: "pane.editor",
        axis: "cols",
        cells: 118,
      },
    ],
    [
      "workspace.pane.read",
      { kind: "pane", semanticPaneId: "pane.editor" },
      { operationKind: "workspace.pane.read", observedOnly: true },
      {
        operationKind: "workspace.pane.read",
        observed: true,
        semanticPaneId: "pane.editor",
      },
    ],
  ] as const)("accepts %s target, summary, and proof", (operationKind, target, summary, proof) => {
    expect(
      InteractionReceiptSchemaZ.safeParse({
        type: "interaction.receipt",
        operationId: "4a50f1d4-6f57-4f02-8b10-b94bf24967ec",
        sequence: 3,
        phase: "observed",
        origin: "gui",
        workspaceName: "project",
        sourceSemanticPaneId: null,
        target,
        operationKind,
        summary,
        proof,
        at: "2026-08-11T10:00:00.000Z",
        resourceRevision: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects cross-verb semantic proof mismatches while allowing clamped resize cells", () => {
    const resize = {
      type: "interaction.receipt" as const,
      operationId: "5a50f1d4-6f57-4f02-8b10-b94bf24967ec",
      sequence: 4,
      phase: "observed" as const,
      origin: "gui" as const,
      workspaceName: "project",
      sourceSemanticPaneId: null,
      target: { kind: "pane" as const, semanticPaneId: "pane.editor" },
      operationKind: "workspace.pane.resize" as const,
      summary: {
        operationKind: "workspace.pane.resize" as const,
        axis: "cols" as const,
        cells: 120,
      },
      proof: {
        operationKind: "workspace.pane.resize" as const,
        outcome: "applied" as const,
        semanticPaneId: "pane.editor",
        axis: "cols" as const,
        cells: 80,
      },
      at: "2026-08-11T10:00:00.000Z",
      resourceRevision: 4,
    };
    expect(InteractionReceiptSchemaZ.safeParse(resize).success).toBe(true);
    expect(
      InteractionReceiptSchemaZ.safeParse({
        ...resize,
        proof: { ...resize.proof, semanticPaneId: "pane.other" },
      }).success,
    ).toBe(false);
    expect(
      InteractionReceiptSchemaZ.safeParse({
        ...resize,
        proof: { ...resize.proof, axis: "rows" },
      }).success,
    ).toBe(false);

    const split = {
      ...resize,
      operationKind: "workspace.window.split" as const,
      summary: { operationKind: "workspace.window.split" as const, direction: "right" as const },
      proof: {
        operationKind: "workspace.window.split" as const,
        outcome: "applied" as const,
        direction: "down" as const,
        semanticPaneId: "pane.created",
      },
    };
    expect(InteractionReceiptSchemaZ.safeParse(split).success).toBe(false);

    const rename = {
      ...resize,
      target: {
        kind: "window" as const,
        target: { by: "pane" as const, semanticPaneId: "pane.editor" },
      },
      operationKind: "workspace.rename" as const,
      summary: { operationKind: "workspace.rename" as const, scope: "window" as const },
      proof: {
        operationKind: "workspace.rename" as const,
        outcome: "applied" as const,
        scope: "session" as const,
      },
    };
    expect(InteractionReceiptSchemaZ.safeParse(rename).success).toBe(false);

    const swap = {
      ...resize,
      operationKind: "workspace.pane.swap" as const,
      summary: {
        operationKind: "workspace.pane.swap" as const,
        targetSemanticPaneId: "pane.tests",
      },
      proof: {
        operationKind: "workspace.pane.swap" as const,
        outcome: "applied" as const,
        sourceSemanticPaneId: "pane.editor",
        targetSemanticPaneId: "pane.other",
      },
    };
    expect(InteractionReceiptSchemaZ.safeParse(swap).success).toBe(false);

    const zoom = {
      ...resize,
      operationKind: "workspace.pane.zoom.toggle" as const,
      summary: {
        operationKind: "workspace.pane.zoom.toggle" as const,
        desired: "zoomed" as const,
      },
      proof: {
        operationKind: "workspace.pane.zoom.toggle" as const,
        outcome: "applied" as const,
        semanticPaneId: "pane.editor",
        zoomed: false,
      },
    };
    expect(InteractionReceiptSchemaZ.safeParse(zoom).success).toBe(false);
    expect(
      InteractionReceiptSchemaZ.safeParse({
        ...zoom,
        summary: { ...zoom.summary, desired: "toggle" },
      }).success,
    ).toBe(true);
  });

  it("requires presence-only summaries for external pane observations", () => {
    const external = {
      type: "interaction.receipt" as const,
      operationId: "6a50f1d4-6f57-4f02-8b10-b94bf24967ec",
      sequence: 5,
      phase: "observed" as const,
      origin: "external" as const,
      workspaceName: "project",
      sourceSemanticPaneId: null,
      target: { kind: "pane" as const, semanticPaneId: "pane.editor" },
      operationKind: "workspace.pane.send" as const,
      summary: {
        operationKind: "workspace.pane.send" as const,
        characterCount: 4,
        byteCount: 4,
        submitted: true,
      },
      proof: {
        operationKind: "workspace.pane.send" as const,
        observed: true as const,
        semanticPaneId: "pane.editor",
      },
      at: "2026-08-11T10:00:00.000Z",
      resourceRevision: null,
    };
    expect(InteractionReceiptSchemaZ.safeParse(external).success).toBe(false);
    expect(
      InteractionReceiptSchemaZ.safeParse({
        ...external,
        summary: { operationKind: "workspace.pane.send", observedOnly: true },
      }).success,
    ).toBe(true);
  });
});
