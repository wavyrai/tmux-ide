import { describe, expect, it } from "vitest";
import type { MissionEvent, MissionHistoryEntry, MissionProjectState } from "@tmux-ide/contracts";
import {
  MissionBoardViewSchemaZ,
  MissionDetailViewSchemaZ,
  MissionHistorySummarySchemaZ,
  MissionTimelineEntrySchemaZ,
} from "@tmux-ide/contracts";
import { replayMissionEvents } from "../mission-repository.ts";
import {
  MissionProjectionError,
  missionStatusToBoardColumn,
  projectMissionBoard,
  projectMissionDetail,
  projectMissionHistory,
  projectMissionTimeline,
  taskStatusToBoardColumn,
} from "../mission-projections.ts";

const actor = { type: "user" as const, id: "pm", displayName: "PM" };

function at(second: number): string {
  return `2026-01-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function entry(sequence: number, event: MissionEvent): MissionHistoryEntry {
  return entryAt(sequence, at(sequence), event);
}

function entryAt(sequence: number, timestamp: string, event: MissionEvent): MissionHistoryEntry {
  return { sequence, timestamp, event };
}

function runtime(history: MissionHistoryEntry[]) {
  return history.map((item) => ({
    version: 1 as const,
    sequence: item.sequence,
    timestamp: item.timestamp,
    payload: item.event,
  }));
}

function stateFrom(history: MissionHistoryEntry[]): MissionProjectState {
  return replayMissionEvents(runtime(history));
}

function richHistory(): MissionHistoryEntry[] {
  return [
    entry(1, {
      version: 1,
      type: "mission.created",
      missionId: "mis_alpha",
      title: "Alpha",
      objective: "Ship alpha",
      acceptanceCriteria: ["tests"],
      constraints: ["deterministic"],
      labels: ["m27", "ui"],
      source: { type: "user", id: "card-116" },
      actor,
    }),
    entry(2, { version: 1, type: "mission.started", missionId: "mis_alpha", actor }),
    entry(3, {
      version: 1,
      type: "task.added",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      title: "Setup",
      description: "Prepare contracts",
      priority: 2,
      dependencies: [],
      actor,
    }),
    entry(4, {
      version: 1,
      type: "task.added",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      title: "Finish",
      priority: 1,
      dependencies: ["tsk_setup"],
      actor,
    }),
    entry(5, {
      version: 1,
      type: "task.ready",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      actor,
    }),
    entry(6, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      assignee: "agent/a",
      actor,
    }),
    entry(7, {
      version: 1,
      type: "task.started",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      actor,
    }),
    entry(8, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      attemptId: "att_setup",
      agent: "agent/a",
      harness: "generic",
      model: "model/a",
      terminal: "term-1",
      session: "session-1",
      worktree: "worktrees/setup",
      actor,
    }),
    entry(9, {
      version: 1,
      type: "proof.recorded",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      attemptId: "att_setup",
      proofId: "prf_setup",
      proof: {
        tests: [{ name: "unit", status: "passed", passed: 3, total: 3 }],
        commits: [{ sha: "abcdef1" }],
        diff: {
          summary: "Contracts added",
          url: "https://example.test/diff",
          stats: { filesChanged: 2, insertions: 10, deletions: 1 },
        },
        pr: { number: 116, url: "https://example.test/pr/116", status: "open" },
        artifacts: [{ name: "log", uri: "artifact://setup", kind: "text" }],
        notes: "evidence",
      },
      actor,
    }),
    entry(10, {
      version: 1,
      type: "attempt.submitted",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      attemptId: "att_setup",
      proofId: "prf_setup",
      actor,
    }),
    entry(11, {
      version: 1,
      type: "attempt.approved",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      attemptId: "att_setup",
      proofId: "prf_setup",
      actor,
    }),
    entry(12, {
      version: 1,
      type: "task.submitted",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      proofId: "prf_setup",
      actor,
    }),
    entry(13, {
      version: 1,
      type: "task.completed",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      proofId: "prf_setup",
      actor,
    }),
    entry(14, {
      version: 1,
      type: "task.ready",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      actor,
    }),
    entry(15, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      assignee: "agent/a",
      actor,
    }),
    entry(16, {
      version: 1,
      type: "task.started",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      actor,
    }),
    entry(17, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_retry",
      agent: "agent/a",
      harness: "generic",
      actor,
    }),
    entry(18, {
      version: 1,
      type: "attempt.interrupted",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_retry",
      reason: "terminal closed",
      actor,
    }),
    entry(19, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_finish",
      agent: "agent/a",
      harness: "generic",
      terminal: "term-2",
      session: "session-1",
      worktree: "worktrees/finish",
      actor,
    }),
    entry(20, {
      version: 1,
      type: "proof.recorded",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_finish",
      proofId: "prf_finish",
      proof: {
        noProofReason: "Manual review accepted",
        commits: [{ sha: "1234567" }, { sha: "1234567" }],
        artifacts: [
          { name: "report", uri: "artifact://report" },
          { name: "report", uri: "artifact://report" },
        ],
      },
      actor,
    }),
    entry(21, {
      version: 1,
      type: "attempt.submitted",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_finish",
      proofId: "prf_finish",
      actor,
    }),
    entry(22, {
      version: 1,
      type: "attempt.approved",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_finish",
      proofId: "prf_finish",
      actor,
    }),
    entry(23, {
      version: 1,
      type: "task.submitted",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      proofId: "prf_finish",
      actor,
    }),
    entry(24, {
      version: 1,
      type: "task.completed",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      proofId: "prf_finish",
      actor,
    }),
    entry(25, { version: 1, type: "mission.review", missionId: "mis_alpha", actor }),
    entry(26, { version: 1, type: "mission.completed", missionId: "mis_alpha", actor }),
  ];
}

describe("mission projection mappings", () => {
  it("maps every mission and task status to fixed board columns", () => {
    expect(
      Object.fromEntries(
        [
          "created",
          "planned",
          "started",
          "blocked",
          "review",
          "completed",
          "failed",
          "cancelled",
        ].map((status) => [status, missionStatusToBoardColumn(status as never)]),
      ),
    ).toEqual({
      created: "planned",
      planned: "planned",
      started: "running",
      blocked: "blocked",
      review: "review",
      completed: "done",
      failed: "done",
      cancelled: "done",
    });
    expect(
      Object.fromEntries(
        [
          "added",
          "ready",
          "claimed",
          "started",
          "blocked",
          "submitted",
          "completed",
          "failed",
          "cancelled",
        ].map((status) => [status, taskStatusToBoardColumn(status as never)]),
      ),
    ).toEqual({
      added: "planned",
      ready: "planned",
      claimed: "running",
      started: "running",
      blocked: "blocked",
      submitted: "review",
      completed: "done",
      failed: "done",
      cancelled: "done",
    });
  });
});

describe("mission board projections", () => {
  it("sorts columns deterministically by mission creation time then id regardless of record order", () => {
    const first = richHistory();
    const extra = [
      entryAt(27, at(30), {
        version: 1,
        type: "mission.created",
        missionId: "mis_beta",
        title: "Beta",
        objective: "same timestamp",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        actor,
      }),
      entryAt(28, at(30), {
        version: 1,
        type: "mission.created",
        missionId: "mis_aaa",
        title: "AAA",
        objective: "same timestamp",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        actor,
      }),
    ];
    const state = stateFrom([...first, ...extra]);
    const shuffled: MissionProjectState = {
      sequence: state.sequence,
      missions: {
        mis_beta: state.missions.mis_beta!,
        mis_alpha: state.missions.mis_alpha!,
        mis_aaa: state.missions.mis_aaa!,
      },
    };

    const board = projectMissionBoard(shuffled, [...first, ...extra]);

    expect(MissionBoardViewSchemaZ.parse(board)).toEqual(board);
    expect(board.columns.planned.map((card) => card.id)).toEqual(["mis_aaa", "mis_beta"]);
    expect(board.columns.done.map((card) => card.id)).toEqual(["mis_alpha"]);
    expect(board.counts).toEqual({
      planned: 2,
      running: 0,
      blocked: 0,
      review: 0,
      done: 1,
      total: 3,
    });
  });

  it("derives dependency blockers and progress summaries from state", () => {
    const history = blockedDependencyHistory();
    const state = stateFrom(history);

    const detail = projectMissionDetail(state, history, "mis_alpha", {
      asOf: "2026-01-01T00:01:00.000Z",
    });

    expect(detail.progress).toMatchObject({ total: 2, running: 1, planned: 1, completed: 0 });
    expect(detail.progress.done).toBe(0);
    expect(detail.taskBoard.columns.planned[0]?.blockedBy).toEqual(["tsk_setup"]);
    expect(detail.mission.blockedBy).toEqual(["tsk_setup"]);
    expect(detail.mission.durationMs).toBe(58_000);
  });

  it("rejects board state/history mismatch with a stable typed projection error", () => {
    const history = richHistory();
    const state = stateFrom(history);
    const mismatch = structuredClone(state);
    mismatch.missions.mis_alpha!.title = "changed";

    expect(() => projectMissionBoard(mismatch, history)).toThrow(MissionProjectionError);
    try {
      projectMissionBoard(mismatch, history);
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_HISTORY_MISMATCH" });
    }
  });

  it("selects mission latest attempt by last attempt.started event across misleading task sort fields", () => {
    const history = latestAttemptOrderingHistory();
    const state = stateFrom(history);
    const board = projectMissionBoard(state, history);

    expect(board.columns.running[0]?.latestAttempt?.id).toBe("att_low");
    expect(board.columns.running[0]?.latestAttempt?.taskId).toBe("tsk_low");
  });

  it("orders task cards by priority descending, creation time, then id", () => {
    const history = taskOrderingHistory();
    const detail = projectMissionDetail(stateFrom(history), history, "mis_sort");

    expect(detail.taskBoard.columns.planned.map((task) => task.id)).toEqual([
      "tsk_high",
      "tsk_aaa",
      "tsk_bbb",
      "tsk_low",
    ]);
  });
});

describe("mission detail, proofs, and timeline projections", () => {
  it("selects latest attempts by task attemptIds, keeps retries, and aggregates proof facts with dedupe", () => {
    const history = richHistory();
    const state = stateFrom(history);
    const detail = projectMissionDetail(state, history, "mis_alpha");

    expect(MissionDetailViewSchemaZ.parse(detail)).toEqual(detail);
    expect(
      detail.taskBoard.columns.done.find((task) => task.id === "tsk_finish")?.latestAttempt?.id,
    ).toBe("att_finish");
    expect(detail.attempts.map((attempt) => attempt.id)).toEqual([
      "att_setup",
      "att_retry",
      "att_finish",
    ]);
    expect(detail.proofSummary.commits).toEqual(["1234567", "abcdef1"]);
    expect(detail.proofSummary.diff).toMatchObject({
      filesChanged: 2,
      insertions: 10,
      deletions: 1,
    });
    expect(detail.proofSummary.prs).toEqual([
      { number: 116, url: "https://example.test/pr/116", status: "open" },
    ]);
    expect(detail.proofSummary.artifacts).toEqual([
      { name: "log", uri: "artifact://setup", kind: "text" },
      { name: "report", uri: "artifact://report" },
    ]);
    expect(detail.proofSummary.noProofReasons).toEqual(["Manual review accepted"]);
  });

  it("projects task failed/cancelled and attempt rejected/failed/interrupted states compactly", () => {
    const history = terminalTaskAndAttemptHistory();
    const detail = projectMissionDetail(stateFrom(history), history, "mis_terminal");

    expect(detail.taskBoard.columns.done.map((task) => [task.id, task.status])).toEqual([
      ["tsk_cancel", "cancelled"],
      ["tsk_fail", "failed"],
      ["tsk_reject", "failed"],
      ["tsk_attempt_fail", "failed"],
      ["tsk_interrupt", "failed"],
    ]);
    expect(detail.attempts.map((attempt) => [attempt.id, attempt.status, attempt.outcome])).toEqual(
      [
        ["att_reject", "rejected", "rejected"],
        ["att_fail", "failed", "failed"],
        ["att_interrupt", "interrupted", "interrupted"],
      ],
    );
    expect(detail.progress).toMatchObject({
      total: 5,
      failed: 4,
      cancelled: 1,
      done: 5,
    });
    expect(detail.proofSummary.noProofReasons).toEqual(["rejected evidence"]);
  });

  it("accepts shuffled record-key insertion order when state and history are semantically equal", () => {
    const history = richHistory();
    const state = stateFrom(history);
    const mission = state.missions.mis_alpha!;
    const shuffled: MissionProjectState = {
      sequence: state.sequence,
      missions: {
        mis_alpha: {
          ...mission,
          tasks: {
            tsk_finish: mission.tasks.tsk_finish!,
            tsk_setup: mission.tasks.tsk_setup!,
          },
          attempts: {
            att_finish: mission.attempts.att_finish!,
            att_retry: mission.attempts.att_retry!,
            att_setup: mission.attempts.att_setup!,
          },
          proofs: {
            prf_finish: mission.proofs.prf_finish!,
            prf_setup: mission.proofs.prf_setup!,
          },
        },
      },
    };

    expect(projectMissionDetail(shuffled, history, "mis_alpha")).toEqual(
      projectMissionDetail(state, history, "mis_alpha"),
    );
  });

  it("filters timeline by mission, preserves sequence order, labels events, and carries actor/navigation refs", () => {
    const history = [
      ...richHistory(),
      entry(27, {
        version: 1,
        type: "mission.created",
        missionId: "mis_other",
        title: "Other",
        objective: "other",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        actor,
      }),
    ];
    const state = stateFrom(history);
    const timeline = projectMissionTimeline(state, history, "mis_alpha");

    expect(timeline).toHaveLength(26);
    expect(timeline[0]).toMatchObject({ sequence: 1, label: "Mission created", actor });
    expect(timeline.find((item) => item.attemptId === "att_setup")).toMatchObject({
      refs: { terminal: "term-1", session: "session-1", worktree: "worktrees/setup" },
    });
    for (const item of timeline) expect(MissionTimelineEntrySchemaZ.parse(item)).toEqual(item);
  });
});

describe("mission history projections", () => {
  it("summarizes completed, failed, and cancelled terminal outcomes with stored durations", () => {
    const history = [
      ...richHistory(),
      entry(27, {
        version: 1,
        type: "mission.created",
        missionId: "mis_failed",
        title: "Failed",
        objective: "fail",
        acceptanceCriteria: [],
        constraints: [],
        labels: ["x"],
        source: { type: "user" },
        actor,
      }),
      entry(28, { version: 1, type: "mission.started", missionId: "mis_failed", actor }),
      entry(29, {
        version: 1,
        type: "mission.failed",
        missionId: "mis_failed",
        reason: "nope",
        actor,
      }),
      entry(30, {
        version: 1,
        type: "mission.created",
        missionId: "mis_cancelled",
        title: "Cancelled",
        objective: "cancel",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        actor,
      }),
      entry(31, {
        version: 1,
        type: "mission.cancelled",
        missionId: "mis_cancelled",
        reason: "duplicate",
        actor,
      }),
    ];
    const summaries = projectMissionHistory(stateFrom(history), history);

    expect(summaries.map((summary) => summary.outcome)).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(summaries[0]?.durationMs).toBe(24_000);
    expect(summaries[0]?.taskTotals.done).toBe(2);
    expect(summaries[1]?.durationMs).toBe(1_000);
    expect(summaries[2]?.durationMs).toBeNull();
    expect(summaries[1]?.lastEvent?.reason).toBe("nope");
    for (const summary of summaries)
      expect(MissionHistorySummarySchemaZ.parse(summary)).toEqual(summary);
  });
});

describe("mission projection safety", () => {
  it("handles empty/minimal states and returns detached repeated-call stable values", () => {
    const empty: MissionProjectState = { sequence: 0, missions: {} };
    expect(projectMissionBoard(empty, [])).toEqual({
      version: 1,
      columns: { planned: [], running: [], blocked: [], review: [], done: [] },
      counts: { planned: 0, running: 0, blocked: 0, review: 0, done: 0, total: 0 },
    });

    const history = [richHistory()[0]!];
    const state = stateFrom(history);
    const before = JSON.stringify(state);
    const one = projectMissionBoard(state, history);
    const two = projectMissionBoard(state, history);
    expect(one).toEqual(two);
    one.columns.planned[0]!.title = "mutated";
    expect(projectMissionBoard(state, history).columns.planned[0]?.title).toBe("Alpha");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rejects corrupt state and state/history mismatch with stable typed projection errors", () => {
    const history = richHistory();
    const state = stateFrom(history);
    const mismatch = structuredClone(state);
    mismatch.missions.mis_alpha!.title = "changed";

    expect(() => projectMissionDetail(mismatch, history, "mis_alpha")).toThrow(
      MissionProjectionError,
    );
    try {
      projectMissionDetail(mismatch, history, "mis_alpha");
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_HISTORY_MISMATCH" });
    }

    const corrupt = structuredClone(state);
    corrupt.missions.mis_alpha!.tasks.tsk_finish!.dependencies = ["tsk_missing" as never];
    expect(() => projectMissionBoard(corrupt, history)).toThrow(MissionProjectionError);
  });

  it("rejects invalid history and as-of duration inputs with stable typed projection errors", () => {
    const state = stateFrom(blockedDependencyHistory());
    const invalidHistory = blockedDependencyHistory();
    invalidHistory[1] = { ...invalidHistory[1]!, sequence: 99 };
    expect(() => projectMissionDetail(state, invalidHistory, "mis_alpha")).toThrow(
      MissionProjectionError,
    );
    try {
      projectMissionDetail(state, invalidHistory, "mis_alpha");
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_PROJECTION_INVALID" });
    }

    const history = blockedDependencyHistory();
    expect(() => projectMissionBoard(state, history, { asOf: "2026-01-01T00:00:01.000Z" })).toThrow(
      MissionProjectionError,
    );
    try {
      projectMissionBoard(state, history, { asOf: "2026-01-01T00:00:01.000Z" });
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_PROJECTION_INVALID" });
    }
  });
});

function latestAttemptOrderingHistory(): MissionHistoryEntry[] {
  return [
    entry(1, {
      version: 1,
      type: "mission.created",
      missionId: "mis_order",
      title: "Order",
      objective: "Order attempts",
      acceptanceCriteria: [],
      constraints: [],
      labels: [],
      source: { type: "user" },
      actor,
    }),
    entry(2, { version: 1, type: "mission.started", missionId: "mis_order", actor }),
    entry(3, {
      version: 1,
      type: "task.added",
      missionId: "mis_order",
      taskId: "tsk_high",
      title: "High priority",
      priority: 99,
      dependencies: [],
      actor,
    }),
    entry(4, {
      version: 1,
      type: "task.added",
      missionId: "mis_order",
      taskId: "tsk_low",
      title: "Low priority",
      priority: 1,
      dependencies: [],
      actor,
    }),
    entry(5, { version: 1, type: "task.ready", missionId: "mis_order", taskId: "tsk_high", actor }),
    entry(6, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_order",
      taskId: "tsk_high",
      assignee: "agent/a",
      actor,
    }),
    entry(7, {
      version: 1,
      type: "task.started",
      missionId: "mis_order",
      taskId: "tsk_high",
      actor,
    }),
    entry(8, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_order",
      taskId: "tsk_high",
      attemptId: "att_high",
      agent: "agent/a",
      harness: "generic",
      actor,
    }),
    entry(9, { version: 1, type: "task.ready", missionId: "mis_order", taskId: "tsk_low", actor }),
    entry(10, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_order",
      taskId: "tsk_low",
      assignee: "agent/a",
      actor,
    }),
    entry(11, {
      version: 1,
      type: "task.started",
      missionId: "mis_order",
      taskId: "tsk_low",
      actor,
    }),
    entry(12, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_order",
      taskId: "tsk_low",
      attemptId: "att_low",
      agent: "agent/a",
      harness: "generic",
      actor,
    }),
    entry(13, {
      version: 1,
      type: "task.updated",
      missionId: "mis_order",
      taskId: "tsk_high",
      title: "High priority updated later",
      actor,
    }),
  ];
}

function taskOrderingHistory(): MissionHistoryEntry[] {
  return [
    entry(1, {
      version: 1,
      type: "mission.created",
      missionId: "mis_sort",
      title: "Sort",
      objective: "Sort tasks",
      acceptanceCriteria: [],
      constraints: [],
      labels: [],
      source: { type: "user" },
      actor,
    }),
    entry(2, {
      version: 1,
      type: "task.added",
      missionId: "mis_sort",
      taskId: "tsk_low",
      title: "Low",
      priority: 0,
      dependencies: [],
      actor,
    }),
    entryAt(3, at(3), {
      version: 1,
      type: "task.added",
      missionId: "mis_sort",
      taskId: "tsk_bbb",
      title: "B",
      priority: 1,
      dependencies: [],
      actor,
    }),
    entryAt(4, at(3), {
      version: 1,
      type: "task.added",
      missionId: "mis_sort",
      taskId: "tsk_aaa",
      title: "A",
      priority: 1,
      dependencies: [],
      actor,
    }),
    entry(5, {
      version: 1,
      type: "task.added",
      missionId: "mis_sort",
      taskId: "tsk_high",
      title: "High",
      priority: 2,
      dependencies: [],
      actor,
    }),
  ];
}

function terminalTaskAndAttemptHistory(): MissionHistoryEntry[] {
  return [
    entry(1, {
      version: 1,
      type: "mission.created",
      missionId: "mis_terminal",
      title: "Terminal",
      objective: "Terminal projections",
      acceptanceCriteria: [],
      constraints: [],
      labels: [],
      source: { type: "user" },
      actor,
    }),
    entry(2, { version: 1, type: "mission.started", missionId: "mis_terminal", actor }),
    ...terminalTaskEvents(3, "tsk_cancel", "task.cancelled"),
    ...terminalTaskEvents(5, "tsk_fail", "task.failed"),
    ...attemptTerminalEvents(7, "tsk_reject", "att_reject", "attempt.rejected", "prf_reject"),
    ...attemptTerminalEvents(16, "tsk_attempt_fail", "att_fail", "attempt.failed"),
    ...attemptTerminalEvents(23, "tsk_interrupt", "att_interrupt", "attempt.interrupted"),
  ];
}

function terminalTaskEvents(
  start: number,
  taskId: "tsk_cancel" | "tsk_fail",
  terminalType: "task.cancelled" | "task.failed",
): MissionHistoryEntry[] {
  return [
    entry(start, {
      version: 1,
      type: "task.added",
      missionId: "mis_terminal",
      taskId,
      title: taskId,
      priority: 0,
      dependencies: [],
      actor,
    }),
    entry(start + 1, { version: 1, type: terminalType, missionId: "mis_terminal", taskId, actor }),
  ];
}

function attemptTerminalEvents(
  start: number,
  taskId: "tsk_reject" | "tsk_attempt_fail" | "tsk_interrupt",
  attemptId: "att_reject" | "att_fail" | "att_interrupt",
  terminalType: "attempt.rejected" | "attempt.failed" | "attempt.interrupted",
  proofId?: "prf_reject",
): MissionHistoryEntry[] {
  const base: MissionHistoryEntry[] = [
    entry(start, {
      version: 1,
      type: "task.added",
      missionId: "mis_terminal",
      taskId,
      title: taskId,
      priority: 0,
      dependencies: [],
      actor,
    }),
    entry(start + 1, { version: 1, type: "task.ready", missionId: "mis_terminal", taskId, actor }),
    entry(start + 2, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_terminal",
      taskId,
      assignee: "agent/a",
      actor,
    }),
    entry(start + 3, {
      version: 1,
      type: "task.started",
      missionId: "mis_terminal",
      taskId,
      actor,
    }),
    entry(start + 4, {
      version: 1,
      type: "attempt.started",
      missionId: "mis_terminal",
      taskId,
      attemptId,
      agent: "agent/a",
      harness: "generic",
      actor,
    }),
  ];
  if (proofId) {
    base.push(
      entry(start + 5, {
        version: 1,
        type: "proof.recorded",
        missionId: "mis_terminal",
        taskId,
        attemptId,
        proofId,
        proof: { noProofReason: "rejected evidence" },
        actor,
      }),
      entry(start + 6, {
        version: 1,
        type: "attempt.submitted",
        missionId: "mis_terminal",
        taskId,
        attemptId,
        proofId,
        actor,
      }),
      entry(start + 7, {
        version: 1,
        type: terminalType,
        missionId: "mis_terminal",
        taskId,
        attemptId,
        actor,
      }),
      entry(start + 8, {
        version: 1,
        type: "task.failed",
        missionId: "mis_terminal",
        taskId,
        actor,
      }),
    );
    return base;
  }
  base.push(
    entry(start + 5, {
      version: 1,
      type: terminalType,
      missionId: "mis_terminal",
      taskId,
      attemptId,
      actor,
    }),
    entry(start + 6, { version: 1, type: "task.failed", missionId: "mis_terminal", taskId, actor }),
  );
  return base;
}

function blockedDependencyHistory(): MissionHistoryEntry[] {
  return [
    entry(1, {
      version: 1,
      type: "mission.created",
      missionId: "mis_alpha",
      title: "Alpha",
      objective: "Ship alpha",
      acceptanceCriteria: [],
      constraints: [],
      labels: [],
      source: { type: "user" },
      actor,
    }),
    entry(2, { version: 1, type: "mission.started", missionId: "mis_alpha", actor }),
    entry(3, {
      version: 1,
      type: "task.added",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      title: "Setup",
      priority: 2,
      dependencies: [],
      actor,
    }),
    entry(4, {
      version: 1,
      type: "task.added",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      title: "Finish",
      priority: 1,
      dependencies: ["tsk_setup"],
      actor,
    }),
    entry(5, {
      version: 1,
      type: "task.ready",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      actor,
    }),
    entry(6, {
      version: 1,
      type: "task.claimed",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      assignee: "agent/a",
      actor,
    }),
    entry(7, {
      version: 1,
      type: "task.started",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      actor,
    }),
  ];
}
