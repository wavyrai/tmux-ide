import { describe, expect, it } from "vitest";
import { DaemonEventClientFrameSchemaZ, DaemonEventServerFrameSchemaZ } from "../daemon-events.ts";

describe("daemon event contracts", () => {
  it("accepts strict privacy-safe interaction receipts and rejects literal input", () => {
    const receipt = {
      type: "interaction.receipt",
      sequence: 8,
      operationId: "10000000-0000-4000-8000-000000000001",
      origin: "sdk",
      workspaceName: "workspace.alpha",
      sourceSemanticPaneId: null,
      target: { kind: "pane", semanticPaneId: "pane.editor" },
      operationKind: "workspace.pane.send",
      phase: "observed",
      summary: {
        operationKind: "workspace.pane.send",
        characterCount: 14,
        byteCount: 14,
        submitted: true,
      },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.editor",
      },
      at: "2026-08-10T10:00:00.000Z",
      resourceRevision: null,
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(receipt)).toEqual(receipt);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, text: "private prompt" }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        summary: { ...receipt.summary, prefix: "private" },
      }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        origin: "external",
        operationKind: "workspace.pane.read",
        phase: "observed",
        summary: { operationKind: "workspace.pane.read", observedOnly: true },
        proof: {
          operationKind: "workspace.pane.read",
          observed: true,
          semanticPaneId: "pane.editor",
        },
      }).success,
    ).toBe(true);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        operationKind: "workspace.pane.read",
        summary: receipt.summary,
        proof: {
          operationKind: "workspace.pane.read",
          observed: true,
          semanticPaneId: "pane.editor",
        },
      }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        origin: "external",
        phase: "observed",
        summary: { operationKind: "workspace.pane.send", observedOnly: true },
      }).success,
    ).toBe(true);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        origin: "external",
        sourceSemanticPaneId: "pane.source",
        phase: "observed",
        summary: { observedOnly: true },
      }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        sourceSemanticPaneId: "pane.source",
        phase: "accepted",
      }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        summary: { observedOnly: true, characterCount: 14 },
      }).success,
    ).toBe(false);
  });
  const daemon = {
    protocolVersion: 1,
    productVersion: "2.8.0",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-21T00:00:00.000Z",
  } as const;

  it("accepts every client frame and rejects missing or extra fields", () => {
    expect(
      DaemonEventClientFrameSchemaZ.parse({ type: "subscribe", sessions: ["tmux-ide"] }),
    ).toEqual({ type: "subscribe", sessions: ["tmux-ide"] });
    expect(
      DaemonEventClientFrameSchemaZ.parse({
        type: "subscribe",
        sessions: ["tmux-ide"],
        afterSequence: 41,
      }),
    ).toEqual({ type: "subscribe", sessions: ["tmux-ide"], afterSequence: 41 });
    expect(
      DaemonEventClientFrameSchemaZ.safeParse({ type: "unsubscribe", sessions: [] }).success,
    ).toBe(true);
    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "ping" }).success).toBe(true);

    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "subscribe" }).success).toBe(false);
    expect(
      DaemonEventClientFrameSchemaZ.safeParse({
        type: "subscribe",
        sessions: [],
        afterSequence: -1,
      }).success,
    ).toBe(false);
    expect(
      DaemonEventClientFrameSchemaZ.safeParse({
        type: "subscribe",
        sessions: [],
        typo: true,
      }).success,
    ).toBe(false);
    expect(DaemonEventClientFrameSchemaZ.safeParse({ type: "ping", sessions: [] }).success).toBe(
      false,
    );
  });

  it("strictly parses replayable resource invalidations and gap recovery", () => {
    const changed = {
      type: "resource.changed",
      sequence: 42,
      workspaceName: "tmux-ide",
      resource: "application-shell",
      revision: 8,
      causeOperationId: "10000000-0000-4000-8000-000000000001",
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(changed)).toEqual(changed);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...changed, sequence: 0 }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ ...changed, resource: "everything" }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ ...changed, causeOperationId: null }).success,
    ).toBe(true);

    const gap = {
      type: "snapshot-required",
      afterSequence: 1,
      oldestAvailableSequence: 20,
      currentSequence: 42,
      reason: "journal-gap",
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(gap)).toEqual(gap);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...gap, reason: "unknown" }).success).toBe(
      false,
    );
  });

  it("strictly parses snapshots and protocol errors", () => {
    const snapshot = {
      type: "snapshot",
      sessionName: "tmux-ide",
      data: {
        project: {
          session: "tmux-ide",
          dir: "/repo/tmux-ide",
          panes: [],
        },
      },
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(snapshot)).toEqual(snapshot);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...snapshot, unexpected: true }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...snapshot,
        data: { project: { ...snapshot.data.project, unexpected: true } },
      }).success,
    ).toBe(false);

    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      }).success,
    ).toBe(true);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "protocol.error",
        code: "unknown",
        message: "nope",
      }).success,
    ).toBe(false);
  });

  it("keeps every historical server discriminator parseable", () => {
    const frames = [
      { type: "hello", daemon, sessions: [] },
      { type: "sessions.changed" },
      { type: "projects.changed" },
      { type: "init.output", jobId: "job-1", chunk: "working", done: false },
      { type: "init.error", jobId: "job-1", message: "failed" },
      { type: "pong" },
      { type: "action.complete", name: "project.launch", result: { ok: true } },
      { type: "config.changed", sessionName: "tmux-ide" },
      { type: "terminals.changed", sessionName: "tmux-ide" },
      { type: "agent-status.changed", sessionName: "tmux-ide" },
      {
        type: "agent.turn-completed",
        sessionName: "tmux-ide",
        agentId: "agent.0123456789abcdef0123",
        fromStatus: "working",
        toStatus: "done",
        at: "2026-07-23T12:00:00.000Z",
      },
      {
        type: "workspace.promotion-completed",
        workspaceName: "tmux-ide",
        outcome: "promoted",
        at: "2026-07-23T12:00:00.000Z",
      },
      {
        type: "workspace.added",
        workspace: {
          name: "tmux-ide",
          sessionName: "tmux-ide",
          projectDir: "/repo/tmux-ide",
          ideConfigPath: null,
          addedAt: "2026-07-21T12:00:00.000Z",
        },
      },
      { type: "workspace.removed", name: "tmux-ide" },
    ];

    for (const frame of frames) {
      expect(DaemonEventServerFrameSchemaZ.safeParse(frame).success, frame.type).toBe(true);
    }
  });

  it("requires a strict non-secret daemon generation on hello", () => {
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ type: "hello", daemon, sessions: [] }).success,
    ).toBe(true);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ type: "hello", sessions: [] }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "hello",
        daemon: { ...daemon, authToken: "must-not-cross-wire" },
        sessions: [],
      }).success,
    ).toBe(false);
  });

  it("strictly parses agent.turn-completed and rejects unsafe or unbounded shapes", () => {
    const receipt = {
      type: "agent.turn-completed",
      sessionName: "tmux-ide",
      agentId: "agent.0123456789abcdef0123",
      fromStatus: "working",
      toStatus: "idle",
      at: "2026-07-23T12:00:00.000Z",
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(receipt)).toEqual(receipt);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, agentId: null }).success).toBe(
      true,
    );

    // A raw tmux pane id, a raw durable stamp, or any non-digest value is
    // rejected — only the minted `agent.<digest>` identity crosses the wire.
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, agentId: "%1" }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        ...receipt,
        agentId: "pane.promoted.0123456789abcdef0123",
      }).success,
    ).toBe(false);
    // Completion is bounded to a finished turn: from working, to done|idle.
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, fromStatus: "blocked" }).success,
    ).toBe(false);
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, toStatus: "blocked" }).success,
    ).toBe(false);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, at: "yesterday" }).success).toBe(
      false,
    );
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, unexpected: true }).success).toBe(
      false,
    );
  });

  it("strictly parses workspace.promotion-completed", () => {
    const receipt = {
      type: "workspace.promotion-completed",
      workspaceName: "tmux-ide",
      outcome: "replayed",
      at: "2026-07-23T12:00:00.000Z",
    } as const;
    expect(DaemonEventServerFrameSchemaZ.parse(receipt)).toEqual(receipt);
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, outcome: "failed" }).success).toBe(
      false,
    );
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, workspaceName: "" }).success).toBe(
      false,
    );
    expect(DaemonEventServerFrameSchemaZ.safeParse({ ...receipt, unexpected: true }).success).toBe(
      false,
    );
  });

  it("strictly parses agent-status.changed and rejects missing or extra fields", () => {
    expect(
      DaemonEventServerFrameSchemaZ.parse({
        type: "agent-status.changed",
        sessionName: "tmux-ide",
      }),
    ).toEqual({ type: "agent-status.changed", sessionName: "tmux-ide" });
    expect(DaemonEventServerFrameSchemaZ.safeParse({ type: "agent-status.changed" }).success).toBe(
      false,
    );
    expect(
      DaemonEventServerFrameSchemaZ.safeParse({
        type: "agent-status.changed",
        sessionName: "tmux-ide",
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
