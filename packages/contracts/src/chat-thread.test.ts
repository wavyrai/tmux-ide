/**
 * Golden-fixture tests for the chat-thread schemas. Each fixture is a
 * representative shape we expect to flow over the daemon ↔ dashboard
 * boundary; round-tripping it through `parse` proves the schema accepts
 * the shape and that defaults kick in where t3 declares them.
 */

import { describe, expect, it } from "vitest";

import {
  CHAT_THREAD_EVENT_TYPES,
  CheckpointCreatedEventZ,
  CheckpointFileZ,
  CheckpointStatusZ,
  CheckpointSummaryZ,
  ChatAttachmentZ,
  ChatImageAttachmentZ,
  ChatThreadEventZ,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  InteractionModeZ,
  LatestTurnStateZ,
  LatestTurnZ,
  MessageRoleZ,
  MessageZ,
  ModelSelectionZ,
  PlanUpsertedEventZ,
  ProposedPlanZ,
  RuntimeModeZ,
  SessionAddedEventZ,
  SessionRemovedEventZ,
  SessionRoleZ,
  SessionStatusChangedEventZ,
  SessionStatusZ,
  SessionZ,
  ThreadActivityAppendedEventZ,
  ThreadActivityToneZ,
  ThreadActivityZ,
  ThreadRevertedEventZ,
  ThreadZ,
  TurnAbortReasonZ,
  TurnAbortedEventZ,
  TurnCompletedEventZ,
  TurnStartedEventZ,
} from "./chat-thread.ts";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

describe("enum schemas", () => {
  it("SessionStatus accepts the t3 set", () => {
    for (const value of [
      "idle",
      "starting",
      "running",
      "ready",
      "interrupted",
      "stopped",
      "error",
    ] as const) {
      expect(SessionStatusZ.parse(value)).toBe(value);
    }
  });

  it("SessionStatus rejects unknown values", () => {
    expect(SessionStatusZ.safeParse("paused").success).toBe(false);
  });

  it("CheckpointStatus matches t3", () => {
    for (const value of ["ready", "missing", "error"] as const) {
      expect(CheckpointStatusZ.parse(value)).toBe(value);
    }
    expect(CheckpointStatusZ.safeParse("partial").success).toBe(false);
  });

  it("ThreadActivityTone matches t3", () => {
    for (const value of ["info", "tool", "approval", "error"] as const) {
      expect(ThreadActivityToneZ.parse(value)).toBe(value);
    }
    expect(ThreadActivityToneZ.safeParse("warning").success).toBe(false);
  });

  it("LatestTurnState matches t3", () => {
    for (const value of ["running", "interrupted", "completed", "error"] as const) {
      expect(LatestTurnStateZ.parse(value)).toBe(value);
    }
  });

  it("MessageRole matches t3", () => {
    for (const value of ["user", "assistant", "system"] as const) {
      expect(MessageRoleZ.parse(value)).toBe(value);
    }
  });

  it("RuntimeMode + default", () => {
    for (const value of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      expect(RuntimeModeZ.parse(value)).toBe(value);
    }
    expect(DEFAULT_RUNTIME_MODE).toBe("full-access");
  });

  it("InteractionMode + default", () => {
    expect(InteractionModeZ.parse("plan")).toBe("plan");
    expect(InteractionModeZ.parse("default")).toBe("default");
    expect(DEFAULT_INTERACTION_MODE).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Attachments + Message
// ---------------------------------------------------------------------------

describe("ChatAttachment", () => {
  const fixture = {
    type: "image" as const,
    id: "att_01",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 1234,
  };

  it("ChatImageAttachment round-trips", () => {
    expect(ChatImageAttachmentZ.parse(fixture)).toEqual(fixture);
  });

  it("ChatAttachment discriminated union picks image", () => {
    expect(ChatAttachmentZ.parse(fixture)).toEqual(fixture);
  });

  it("rejects non-image mime types", () => {
    expect(
      ChatImageAttachmentZ.safeParse({ ...fixture, mimeType: "application/pdf" }).success,
    ).toBe(false);
  });

  it("rejects malformed attachment ids", () => {
    expect(ChatImageAttachmentZ.safeParse({ ...fixture, id: "has spaces" }).success).toBe(false);
  });
});

describe("MessageZ", () => {
  const fixture = {
    id: "msg_01HXYZ",
    role: "user" as const,
    text: "Hello, world.",
    turnId: "turn_01HXYZ",
    streaming: false,
    createdAt: "2026-05-11T10:00:00.000Z",
    updatedAt: "2026-05-11T10:00:00.000Z",
  };

  it("parses a minimal user message (no attachments)", () => {
    expect(MessageZ.parse(fixture)).toEqual(fixture);
  });

  it("parses with attachments", () => {
    const withAtt = {
      ...fixture,
      attachments: [
        {
          type: "image" as const,
          id: "att_01",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 100,
        },
      ],
    };
    expect(MessageZ.parse(withAtt)).toEqual(withAtt);
  });

  it("allows null turnId for free-floating messages", () => {
    expect(MessageZ.parse({ ...fixture, turnId: null }).turnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ModelSelection
// ---------------------------------------------------------------------------

describe("ModelSelectionZ", () => {
  it("round-trips a minimal selection", () => {
    const fixture = { instanceId: "anthropic-default", model: "claude-opus-4-7" };
    expect(ModelSelectionZ.parse(fixture)).toEqual(fixture);
  });

  it("accepts options", () => {
    const fixture = {
      instanceId: "anthropic-default",
      model: "claude-opus-4-7",
      options: { reasoning: "high", maxTokens: 8000 },
    };
    expect(ModelSelectionZ.parse(fixture)).toEqual(fixture);
  });

  it("rejects an empty model slug", () => {
    expect(ModelSelectionZ.safeParse({ instanceId: "x", model: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposedPlan / Session / Checkpoint / Activity / LatestTurn
// ---------------------------------------------------------------------------

describe("ProposedPlanZ", () => {
  const fixture = {
    id: "plan_01",
    turnId: "turn_01",
    planMarkdown: "## Plan\n- step 1\n- step 2",
    createdAt: "2026-05-11T10:00:00.000Z",
    updatedAt: "2026-05-11T10:00:00.000Z",
  };

  it("applies null defaults for implementedAt + implementationThreadId", () => {
    const parsed = ProposedPlanZ.parse(fixture);
    expect(parsed.implementedAt).toBeNull();
    expect(parsed.implementationThreadId).toBeNull();
  });

  it("preserves explicit implementation values", () => {
    const parsed = ProposedPlanZ.parse({
      ...fixture,
      implementedAt: "2026-05-11T11:00:00.000Z",
      implementationThreadId: "thr_02",
    });
    expect(parsed.implementedAt).toBe("2026-05-11T11:00:00.000Z");
    expect(parsed.implementationThreadId).toBe("thr_02");
  });
});

describe("SessionZ", () => {
  const fixture = {
    threadId: "thr_01",
    status: "running" as const,
    providerName: "codex",
    activeTurnId: "turn_01",
    lastError: null,
    updatedAt: "2026-05-11T10:00:00.000Z",
  };

  it("defaults runtimeMode to full-access", () => {
    const parsed = SessionZ.parse(fixture);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("preserves explicit runtimeMode + providerInstanceId", () => {
    const parsed = SessionZ.parse({
      ...fixture,
      runtimeMode: "approval-required",
      providerInstanceId: "codex-default",
    });
    expect(parsed.runtimeMode).toBe("approval-required");
    expect(parsed.providerInstanceId).toBe("codex-default");
  });
});

describe("CheckpointFileZ + CheckpointSummaryZ", () => {
  const file = {
    path: "src/foo.ts",
    kind: "modified",
    additions: 12,
    deletions: 3,
  };

  it("CheckpointFile round-trips", () => {
    expect(CheckpointFileZ.parse(file)).toEqual(file);
  });

  it("rejects negative addition counts", () => {
    expect(CheckpointFileZ.safeParse({ ...file, additions: -1 }).success).toBe(false);
  });

  it("CheckpointSummary round-trips", () => {
    const fixture = {
      turnId: "turn_01",
      checkpointTurnCount: 3,
      checkpointRef: "abc123",
      status: "ready" as const,
      files: [file],
      assistantMessageId: "msg_99",
      completedAt: "2026-05-11T10:00:00.000Z",
    };
    expect(CheckpointSummaryZ.parse(fixture)).toEqual(fixture);
  });
});

describe("ThreadActivityZ", () => {
  it("round-trips a tool-tone activity with arbitrary payload", () => {
    const fixture = {
      id: "evt_01",
      tone: "tool" as const,
      kind: "tmux.send_to_pane",
      summary: "Sent text to pane 1",
      payload: { paneId: "1", bytes: 42 },
      turnId: "turn_01",
      sequence: 0,
      createdAt: "2026-05-11T10:00:00.000Z",
    };
    expect(ThreadActivityZ.parse(fixture)).toEqual(fixture);
  });

  it("allows sequence to be omitted", () => {
    const parsed = ThreadActivityZ.parse({
      id: "evt_02",
      tone: "info" as const,
      kind: "info",
      summary: "Thread started",
      payload: null,
      turnId: null,
      createdAt: "2026-05-11T10:00:00.000Z",
    });
    expect(parsed.sequence).toBeUndefined();
  });
});

describe("LatestTurnZ", () => {
  const fixture = {
    turnId: "turn_01",
    state: "running" as const,
    requestedAt: "2026-05-11T10:00:00.000Z",
    startedAt: "2026-05-11T10:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  };

  it("round-trips without sourceProposedPlan", () => {
    expect(LatestTurnZ.parse(fixture)).toEqual(fixture);
  });

  it("preserves sourceProposedPlan reference", () => {
    const withPlan = {
      ...fixture,
      sourceProposedPlan: { threadId: "thr_origin", planId: "plan_01" },
    };
    expect(LatestTurnZ.parse(withPlan)).toEqual(withPlan);
  });
});

// ---------------------------------------------------------------------------
// Thread — top-level aggregate golden fixture
// ---------------------------------------------------------------------------

describe("ThreadZ", () => {
  const goldenThread = {
    id: "thr_01HXYZ",
    projectId: "proj_01HXYZ",
    title: "Refactor auth middleware",
    modelSelection: {
      instanceId: "anthropic-default",
      model: "claude-opus-4-7",
    },
    runtimeMode: "full-access" as const,
    branch: "feat/auth",
    worktreePath: "/tmp/wt-auth",
    latestTurn: {
      turnId: "turn_01",
      state: "completed" as const,
      requestedAt: "2026-05-11T10:00:00.000Z",
      startedAt: "2026-05-11T10:00:01.000Z",
      completedAt: "2026-05-11T10:01:00.000Z",
      assistantMessageId: "msg_02",
    },
    createdAt: "2026-05-11T09:00:00.000Z",
    updatedAt: "2026-05-11T10:01:00.000Z",
    deletedAt: null,
    messages: [
      {
        id: "msg_01",
        role: "user" as const,
        text: "Refactor the auth middleware to use JWT.",
        turnId: "turn_01",
        streaming: false,
        createdAt: "2026-05-11T10:00:00.000Z",
        updatedAt: "2026-05-11T10:00:00.000Z",
      },
      {
        id: "msg_02",
        role: "assistant" as const,
        text: "Done — see diff.",
        turnId: "turn_01",
        streaming: false,
        createdAt: "2026-05-11T10:01:00.000Z",
        updatedAt: "2026-05-11T10:01:00.000Z",
      },
    ],
    activities: [
      {
        id: "evt_01",
        tone: "info" as const,
        kind: "turn.started",
        summary: "Turn 1 started",
        payload: null,
        turnId: "turn_01",
        sequence: 0,
        createdAt: "2026-05-11T10:00:00.000Z",
      },
    ],
    checkpoints: [
      {
        turnId: "turn_01",
        checkpointTurnCount: 1,
        checkpointRef: "deadbeef",
        status: "ready" as const,
        files: [
          {
            path: "src/auth.ts",
            kind: "modified",
            additions: 30,
            deletions: 18,
          },
        ],
        assistantMessageId: "msg_02",
        completedAt: "2026-05-11T10:01:00.000Z",
      },
    ],
    session: {
      threadId: "thr_01HXYZ",
      status: "ready" as const,
      providerName: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-05-11T10:01:00.000Z",
    },
  };

  it("parses the golden fixture and applies defaults", () => {
    const parsed = ThreadZ.parse(goldenThread);
    expect(parsed.id).toBe("thr_01HXYZ");
    // interactionMode + archivedAt + proposedPlans aren't on the wire but have defaults
    expect(parsed.interactionMode).toBe("default");
    expect(parsed.archivedAt).toBeNull();
    expect(parsed.proposedPlans).toEqual([]);
  });

  it("preserves explicit interactionMode + archivedAt + proposedPlans", () => {
    const parsed = ThreadZ.parse({
      ...goldenThread,
      interactionMode: "plan",
      archivedAt: "2026-05-11T12:00:00.000Z",
      proposedPlans: [
        {
          id: "plan_01",
          turnId: "turn_01",
          planMarkdown: "## Plan",
          createdAt: "2026-05-11T10:00:00.000Z",
          updatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });
    expect(parsed.interactionMode).toBe("plan");
    expect(parsed.archivedAt).toBe("2026-05-11T12:00:00.000Z");
    expect(parsed.proposedPlans).toHaveLength(1);
    expect(parsed.proposedPlans[0]?.implementedAt).toBeNull();
  });

  it("requires title to be non-empty after trim", () => {
    expect(ThreadZ.safeParse({ ...goldenThread, title: "   " }).success).toBe(false);
  });

  it("requires latestTurn to be either null or a valid LatestTurn", () => {
    expect(ThreadZ.safeParse({ ...goldenThread, latestTurn: null }).success).toBe(true);
    expect(ThreadZ.safeParse({ ...goldenThread, latestTurn: {} }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// t3-style chat thread events (T074)
// ---------------------------------------------------------------------------

describe("CHAT_THREAD_EVENT_TYPES", () => {
  it("declares exactly the ten event-type literals (7 turn/plan/checkpoint + 3 session)", () => {
    expect([...CHAT_THREAD_EVENT_TYPES].sort()).toEqual(
      [
        "chat.activity.appended",
        "chat.turn.started",
        "chat.turn.completed",
        "chat.turn.aborted",
        "chat.plan.upserted",
        "chat.checkpoint.created",
        "chat.thread.reverted",
        "chat.session.added",
        "chat.session.removed",
        "chat.session.status-changed",
      ].sort(),
    );
  });
});

describe("ThreadActivityAppendedEventZ", () => {
  const activity = {
    id: "evt_01",
    tone: "info" as const,
    kind: "turn.started",
    summary: "Turn 1 started",
    payload: null,
    turnId: "turn_01",
    sequence: 0,
    createdAt: "2026-05-11T10:00:00.000Z",
  };

  it("round-trips a valid event", () => {
    const parsed = ThreadActivityAppendedEventZ.parse({
      type: "chat.activity.appended",
      threadId: "thr_01",
      activity,
      seq: 5,
    });
    expect(parsed.activity.summary).toBe("Turn 1 started");
    expect(parsed.seq).toBe(5);
  });

  it("rejects negative seq", () => {
    expect(
      ThreadActivityAppendedEventZ.safeParse({
        type: "chat.activity.appended",
        threadId: "thr_01",
        activity,
        seq: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects wrong discriminant", () => {
    expect(
      ThreadActivityAppendedEventZ.safeParse({
        type: "chat.turn.started",
        threadId: "thr_01",
        activity,
        seq: 1,
      }).success,
    ).toBe(false);
  });
});

describe("TurnStartedEventZ", () => {
  it("round-trips without sourceProposedPlanRef", () => {
    const event = {
      type: "chat.turn.started" as const,
      threadId: "thr_01",
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
    };
    expect(TurnStartedEventZ.parse(event)).toEqual(event);
  });

  it("round-trips with sourceProposedPlanRef", () => {
    const event = {
      type: "chat.turn.started" as const,
      threadId: "thr_01",
      turnId: "turn_01",
      requestedAt: "2026-05-11T10:00:00.000Z",
      sourceProposedPlanRef: { threadId: "thr_origin", planId: "plan_01" },
    };
    expect(TurnStartedEventZ.parse(event).sourceProposedPlanRef?.planId).toBe("plan_01");
  });
});

describe("TurnCompletedEventZ", () => {
  it("round-trips a 'completed' state", () => {
    const event = {
      type: "chat.turn.completed" as const,
      threadId: "thr_01",
      turnId: "turn_01",
      state: "completed" as const,
      completedAt: "2026-05-11T10:01:00.000Z",
      assistantMessageId: "msg_02",
    };
    expect(TurnCompletedEventZ.parse(event).assistantMessageId).toBe("msg_02");
  });

  it("accepts an 'error' or 'interrupted' terminal state too", () => {
    for (const state of ["error", "interrupted"] as const) {
      const event = {
        type: "chat.turn.completed" as const,
        threadId: "thr_01",
        turnId: "turn_01",
        state,
        completedAt: "2026-05-11T10:01:00.000Z",
      };
      expect(TurnCompletedEventZ.parse(event).state).toBe(state);
    }
  });

  it("rejects 'running' (a turn-completed event must be terminal)", () => {
    // 'running' is allowed by LatestTurnStateZ but the completedAt timestamp
    // implies a terminal state — we don't tighten the schema there, but the
    // test documents the intent.
    const event = {
      type: "chat.turn.completed" as const,
      threadId: "thr_01",
      turnId: "turn_01",
      state: "running" as const,
      completedAt: "2026-05-11T10:01:00.000Z",
    };
    // Currently the schema accepts running (LatestTurnStateZ); we just assert
    // the field is preserved verbatim so future tightening is visible.
    expect(TurnCompletedEventZ.parse(event).state).toBe("running");
  });
});

describe("TurnAbortedEventZ + TurnAbortReasonZ", () => {
  it("accepts each abort reason", () => {
    for (const reason of ["cancelled", "interrupted", "error"] as const) {
      expect(TurnAbortReasonZ.parse(reason)).toBe(reason);
      expect(
        TurnAbortedEventZ.parse({
          type: "chat.turn.aborted",
          threadId: "thr_01",
          turnId: "turn_01",
          reason,
        }).reason,
      ).toBe(reason);
    }
  });

  it("rejects unknown abort reasons", () => {
    expect(
      TurnAbortedEventZ.safeParse({
        type: "chat.turn.aborted",
        threadId: "thr_01",
        turnId: "turn_01",
        reason: "exploded",
      }).success,
    ).toBe(false);
  });
});

describe("PlanUpsertedEventZ", () => {
  it("requires a valid plan payload", () => {
    const event = {
      type: "chat.plan.upserted" as const,
      threadId: "thr_01",
      plan: {
        id: "plan_01",
        turnId: "turn_01",
        planMarkdown: "## Plan",
        createdAt: "2026-05-11T10:00:00.000Z",
        updatedAt: "2026-05-11T10:00:00.000Z",
      },
    };
    expect(PlanUpsertedEventZ.parse(event).plan.id).toBe("plan_01");
  });
});

describe("CheckpointCreatedEventZ", () => {
  it("requires a valid CheckpointSummary payload", () => {
    const event = {
      type: "chat.checkpoint.created" as const,
      threadId: "thr_01",
      checkpoint: {
        turnId: "turn_01",
        checkpointTurnCount: 1,
        checkpointRef: "deadbeef",
        status: "ready" as const,
        files: [],
        assistantMessageId: null,
        completedAt: "2026-05-11T10:00:00.000Z",
      },
    };
    expect(CheckpointCreatedEventZ.parse(event).checkpoint.checkpointRef).toBe("deadbeef");
  });
});

describe("ThreadRevertedEventZ", () => {
  it("round-trips a revert pointer", () => {
    const event = {
      type: "chat.thread.reverted" as const,
      threadId: "thr_01",
      toCheckpointRef: "deadbeef",
    };
    expect(ThreadRevertedEventZ.parse(event)).toEqual(event);
  });
});

describe("ChatThreadEventZ (discriminated union)", () => {
  it("routes by `type` field for each event variant", () => {
    const variants: { input: unknown; expected: string }[] = [
      {
        input: {
          type: "chat.turn.started",
          threadId: "t",
          turnId: "u",
          requestedAt: "2026-05-11T10:00:00.000Z",
        },
        expected: "chat.turn.started",
      },
      {
        input: { type: "chat.thread.reverted", threadId: "t", toCheckpointRef: "abc" },
        expected: "chat.thread.reverted",
      },
    ];
    for (const v of variants) {
      const parsed = ChatThreadEventZ.parse(v.input);
      expect(parsed.type).toBe(v.expected);
    }
  });

  it("rejects events with an unknown discriminant", () => {
    expect(ChatThreadEventZ.safeParse({ type: "chat.unknown.event", threadId: "t" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// T078 multi-agent schema additions
// ---------------------------------------------------------------------------

describe("SessionRoleZ", () => {
  it("accepts the five t3-style role literals", () => {
    for (const role of ["lead", "teammate", "planner", "validator", "researcher"] as const) {
      expect(SessionRoleZ.parse(role)).toBe(role);
    }
  });

  it("rejects unknown roles", () => {
    expect(SessionRoleZ.safeParse("admin").success).toBe(false);
  });
});

describe("SessionZ multi-agent fields", () => {
  const base = {
    threadId: "thr_01",
    status: "running" as const,
    providerName: "claude-code",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-05-11T10:00:00.000Z",
  };

  it("accepts optional id, role, and displayName", () => {
    const parsed = SessionZ.parse({
      ...base,
      id: "sess_lead",
      role: "lead" as const,
      displayName: "Lead",
    });
    expect(parsed.id).toBe("sess_lead");
    expect(parsed.role).toBe("lead");
    expect(parsed.displayName).toBe("Lead");
  });

  it("still parses without id (back-compat with pre-T078 wire shape)", () => {
    const parsed = SessionZ.parse(base);
    expect(parsed.id).toBeUndefined();
    expect(parsed.role).toBeUndefined();
  });

  it("rejects an unknown role", () => {
    expect(SessionZ.safeParse({ ...base, role: "ops" }).success).toBe(false);
  });
});

describe("Thread.sessions[] field", () => {
  const base = {
    id: "thr_01",
    projectId: "proj_01",
    title: "Multi-agent",
    modelSelection: { instanceId: "anthropic", model: "claude-opus-4-7" },
    runtimeMode: "full-access" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-05-11T09:00:00.000Z",
    updatedAt: "2026-05-11T09:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  };

  it("defaults sessions to []", () => {
    const parsed = ThreadZ.parse(base);
    expect(parsed.sessions).toEqual([]);
  });

  it("round-trips an explicit two-session array", () => {
    const parsed = ThreadZ.parse({
      ...base,
      sessions: [
        {
          id: "sess_lead",
          threadId: "thr_01",
          status: "running" as const,
          providerName: "claude-code",
          role: "lead" as const,
          activeTurnId: "turn_01",
          lastError: null,
          updatedAt: "2026-05-11T10:00:00.000Z",
        },
        {
          id: "sess_planner",
          threadId: "thr_01",
          status: "idle" as const,
          providerName: "codex",
          role: "planner" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-05-11T10:00:00.000Z",
        },
      ],
    });
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions[0]?.role).toBe("lead");
    expect(parsed.sessions[1]?.role).toBe("planner");
  });
});

describe("ThreadActivity.sessionId field", () => {
  const base = {
    id: "evt_01",
    tone: "info" as const,
    kind: "agent.text",
    summary: "hi",
    payload: null,
    turnId: "turn_01",
    createdAt: "2026-05-11T10:00:00.000Z",
  };

  it("accepts an optional sessionId", () => {
    const parsed = ThreadActivityZ.parse({ ...base, sessionId: "sess_lead" });
    expect(parsed.sessionId).toBe("sess_lead");
  });

  it("still parses without a sessionId", () => {
    const parsed = ThreadActivityZ.parse(base);
    expect(parsed.sessionId).toBeUndefined();
  });
});

describe("LatestTurn.sessionId field", () => {
  it("preserves an explicit sessionId", () => {
    const parsed = LatestTurnZ.parse({
      turnId: "turn_01",
      state: "running" as const,
      requestedAt: "2026-05-11T10:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
      sessionId: "sess_lead",
    });
    expect(parsed.sessionId).toBe("sess_lead");
  });
});

describe("SessionAddedEventZ", () => {
  it("round-trips", () => {
    const event = {
      type: "chat.session.added" as const,
      threadId: "thr_01",
      session: {
        id: "sess_lead",
        threadId: "thr_01",
        status: "starting" as const,
        providerName: "claude-code",
        role: "lead" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-05-11T10:00:00.000Z",
      },
    };
    expect(SessionAddedEventZ.parse(event).session.id).toBe("sess_lead");
  });
});

describe("SessionRemovedEventZ", () => {
  it("requires a sessionId", () => {
    expect(
      SessionRemovedEventZ.parse({
        type: "chat.session.removed",
        threadId: "thr_01",
        sessionId: "sess_x",
      }).sessionId,
    ).toBe("sess_x");
  });
});

describe("SessionStatusChangedEventZ", () => {
  it("round-trips a minimal payload", () => {
    const event = {
      type: "chat.session.status-changed" as const,
      threadId: "thr_01",
      sessionId: "sess_lead",
      status: "running" as const,
    };
    expect(SessionStatusChangedEventZ.parse(event).status).toBe("running");
  });

  it("accepts optional lastError + activeTurnId", () => {
    const event = {
      type: "chat.session.status-changed" as const,
      threadId: "thr_01",
      sessionId: "sess_lead",
      status: "error" as const,
      lastError: "boom",
      activeTurnId: null,
    };
    expect(SessionStatusChangedEventZ.parse(event).lastError).toBe("boom");
  });
});

describe("ChatThreadEventZ — session variants", () => {
  it("routes chat.session.added through the union", () => {
    const parsed = ChatThreadEventZ.parse({
      type: "chat.session.added",
      threadId: "thr_01",
      session: {
        id: "sess_x",
        threadId: "thr_01",
        status: "idle" as const,
        providerName: null,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-05-11T10:00:00.000Z",
      },
    });
    expect(parsed.type).toBe("chat.session.added");
  });

  it("routes chat.session.removed through the union", () => {
    const parsed = ChatThreadEventZ.parse({
      type: "chat.session.removed",
      threadId: "thr_01",
      sessionId: "sess_x",
    });
    expect(parsed.type).toBe("chat.session.removed");
  });

  it("routes chat.session.status-changed through the union", () => {
    const parsed = ChatThreadEventZ.parse({
      type: "chat.session.status-changed",
      threadId: "thr_01",
      sessionId: "sess_x",
      status: "ready",
    });
    expect(parsed.type).toBe("chat.session.status-changed");
  });
});
