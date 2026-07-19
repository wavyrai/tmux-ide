import type {
  MissionAttemptSummary,
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionDetailView,
  MissionHistorySummary,
  MissionProgressSummary,
  MissionProofSummary,
  MissionTimelineEntry,
  TaskCardView,
} from "@tmux-ide/contracts";
import type { AgentRowInput } from "./agent-rows.ts";
import {
  MISSION_BOARD_COLUMNS,
  defaultMissionWorkspaceModel,
  type MissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";

const CREATED_AT = "2026-07-19T08:00:00.000Z";
const UPDATED_AT = "2026-07-19T08:05:00.000Z";
const FINISHED_AT = "2026-07-19T08:30:00.000Z";

export function progress(overrides: Partial<MissionProgressSummary> = {}): MissionProgressSummary {
  return {
    total: 6,
    planned: 1,
    running: 2,
    blocked: 1,
    review: 1,
    completed: 1,
    failed: 0,
    cancelled: 0,
    done: 1,
    ...overrides,
  };
}

export function proof(overrides: Partial<MissionProofSummary> = {}): MissionProofSummary {
  return {
    proofIds: [],
    hasProof: false,
    noProofReasons: [],
    notesCount: 0,
    tests: { suites: 0, passed: 0, failed: 0, skipped: 0, total: 0 },
    commits: [],
    diff: { summaries: [], urls: [], filesChanged: 0, insertions: 0, deletions: 0 },
    prs: [],
    artifacts: [],
    ...overrides,
  };
}

export function attempt(
  id: string,
  taskId: string,
  overrides: Partial<MissionAttemptSummary> = {},
): MissionAttemptSummary {
  return {
    id,
    taskId,
    status: "started",
    agent: "codex",
    harness: "tmux",
    model: "gpt-5",
    terminal: "%7",
    session: "m28-missions",
    startedAt: "2026-07-19T08:01:00.000Z",
    updatedAt: "2026-07-19T08:04:00.000Z",
    durationMs: null,
    proofIds: [],
    ...overrides,
  };
}

export function missionCard(
  id: string,
  column: MissionBoardColumn,
  overrides: Partial<MissionCardView> = {},
): MissionCardView {
  const status =
    column === "planned"
      ? "planned"
      : column === "running"
        ? "started"
        : column === "blocked"
          ? "blocked"
          : column === "review"
            ? "review"
            : "completed";
  return {
    version: 1,
    id,
    title: `Mission ${id}`,
    summary: `Objective for ${id}`,
    status,
    column,
    labels: ["m28"],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    finishedAt: column === "done" ? FINISHED_AT : undefined,
    durationMs: column === "done" ? 1_800_000 : null,
    progress: progress(),
    blockedBy: [],
    latestAttempt: null,
    proofSummary: proof(),
    refs: { missionId: id, taskIds: [], attemptIds: [], proofIds: [] },
    ...overrides,
  };
}

export function taskCard(id: string, overrides: Partial<TaskCardView> = {}): TaskCardView {
  return {
    version: 1,
    id,
    missionId: "mis_running",
    title: `Task ${id}`,
    summary: `Task objective for ${id}`,
    status: "started",
    column: "running",
    priority: 2,
    assignee: "codex",
    dependencies: [],
    blockedBy: [],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    durationMs: null,
    latestAttempt: null,
    proofSummary: proof(),
    refs: { missionId: "mis_running", taskId: id, attemptIds: [], proofIds: [] },
    ...overrides,
  };
}

export function missionRenderFixture(): {
  model: MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot;
  agents: AgentRowInput[];
} {
  const runningAttempt = attempt("att_running", "tsk_running");
  const submittedAttempt = attempt("att_submitted", "tsk_review", {
    status: "submitted",
    outcome: "submitted",
    terminal: "%9",
    session: "m28-review",
    finishedAt: FINISHED_AT,
    durationMs: 1_740_000,
  });
  const proofSummary = proof({
    proofIds: ["prf_running"],
    hasProof: true,
    notesCount: 1,
    tests: { suites: 2, passed: 12, failed: 0, skipped: 1, total: 13 },
    diff: { summaries: ["UI diff"], urls: [], filesChanged: 4, insertions: 120, deletions: 18 },
    prs: [{ number: 128, status: "open" }],
    artifacts: [{ name: "renderer snapshot", uri: "file://artifacts/mission.txt" }],
  });
  const runningMission = missionCard("mis_running", "running", {
    title: "M28 Missions dashboard polish with durable UI state",
    summary: "Responsive dashboard shows board, detail, proof, and live agent context.",
    progress: progress({ total: 6, running: 3, done: 2, completed: 2 }),
    latestAttempt: runningAttempt,
    proofSummary,
    refs: {
      missionId: "mis_running",
      taskIds: ["tsk_running", "tsk_review", "tsk_done"],
      attemptIds: ["att_running", "att_submitted"],
      proofIds: ["prf_running"],
    },
  });
  const taskRunning = taskCard("tsk_running", {
    title: "Implement renderer snapshots and interaction matrix",
    latestAttempt: runningAttempt,
    proofSummary,
    refs: {
      missionId: "mis_running",
      taskId: "tsk_running",
      attemptIds: ["att_running"],
      proofIds: ["prf_running"],
      terminal: "%7",
      session: "m28-missions",
      worktree: "packages/daemon/src/tui/mirror",
    },
  });
  const taskReview = taskCard("tsk_review", {
    title: "Review compiled smoke captures",
    status: "submitted",
    column: "review",
    priority: 1,
    latestAttempt: submittedAttempt,
    refs: {
      missionId: "mis_running",
      taskId: "tsk_review",
      attemptIds: ["att_submitted"],
      proofIds: [],
      terminal: "%9",
      session: "m28-review",
    },
  });
  const taskDone = taskCard("tsk_done", {
    title: "Keep previous Missions behavior green",
    status: "completed",
    column: "done",
    priority: 3,
    finishedAt: FINISHED_AT,
    durationMs: 900_000,
    refs: { missionId: "mis_running", taskId: "tsk_done", attemptIds: [], proofIds: [] },
  });
  const columns = Object.fromEntries(
    MISSION_BOARD_COLUMNS.map((column) => [
      column,
      [missionCard(`mis_${column}`, column, { title: `${column} lane mission` })],
    ]),
  ) as MissionBoardView["columns"];
  columns.running = [
    runningMission,
    missionCard("mis_running_extra", "running", {
      title: "Secondary running mission",
      progress: progress({ total: 3, running: 1, done: 0, completed: 0 }),
    }),
  ];
  columns.done = [missionCard("mis_done", "done", { title: "Completed mission archive" })];

  const board: MissionBoardView = {
    version: 1,
    columns,
    counts: {
      planned: columns.planned.length,
      running: columns.running.length,
      blocked: columns.blocked.length,
      review: columns.review.length,
      done: columns.done.length,
      total: MISSION_BOARD_COLUMNS.reduce((sum, column) => sum + columns[column].length, 0),
    },
  };
  const timeline: MissionTimelineEntry[] = [
    {
      version: 1,
      sequence: 1,
      timestamp: CREATED_AT,
      missionId: "mis_running",
      type: "mission.created",
      label: "Mission created",
      actor: { type: "user", id: "pm" },
      refs: { missionId: "mis_running" },
    },
    {
      version: 1,
      sequence: 2,
      timestamp: runningAttempt.startedAt,
      missionId: "mis_running",
      taskId: "tsk_running",
      attemptId: runningAttempt.id,
      type: "attempt.started",
      label: "Attempt started",
      actor: { type: "agent", id: "codex" },
      refs: {
        missionId: "mis_running",
        taskId: "tsk_running",
        attemptId: runningAttempt.id,
        terminal: "%7",
        session: "m28-missions",
        worktree: "packages/daemon/src/tui/mirror",
      },
    },
    {
      version: 1,
      sequence: 3,
      timestamp: UPDATED_AT,
      missionId: "mis_running",
      taskId: "tsk_running",
      proofId: "prf_running",
      type: "proof.recorded",
      label: "Proof recorded",
      actor: { type: "agent", id: "codex" },
      refs: {
        missionId: "mis_running",
        taskId: "tsk_running",
        proofId: "prf_running",
        terminal: "%7",
        session: "m28-missions",
      },
    },
  ];
  const detail: MissionDetailView = {
    version: 1,
    mission: runningMission,
    taskBoard: {
      columns: {
        planned: [],
        running: [taskRunning],
        blocked: [],
        review: [taskReview],
        done: [taskDone],
      },
      counts: { planned: 0, running: 1, blocked: 0, review: 1, done: 1, total: 3 },
    },
    attempts: [runningAttempt, submittedAttempt],
    proofSummary,
    progress: runningMission.progress,
    timeline,
  };
  const history: MissionHistorySummary[] = [
    {
      version: 1,
      mission: columns.done[0]!,
      outcome: "completed",
      startedAt: CREATED_AT,
      finishedAt: FINISHED_AT,
      durationMs: 1_800_000,
      taskTotals: progress({ total: 2, done: 2, completed: 2, planned: 0, running: 0 }),
      attemptTotals: {
        total: 2,
        submitted: 1,
        approved: 1,
        rejected: 0,
        failed: 0,
        interrupted: 0,
        running: 0,
      },
      proofSummary,
      lastEvent: timeline[2]!,
    },
  ];
  return {
    model: {
      ...defaultMissionWorkspaceModel("mis_running", "tsk_running"),
      selectedColumn: "running",
    },
    snapshot: {
      board,
      history,
      detail,
      project: {
        identityKey: "fixture-project",
        projectRoot: "/fixture/project/missions-polish",
      },
      loadedAt: "2026-07-19T08:06:00.000Z",
    },
    agents: [
      {
        paneId: "%7",
        windowIndex: 1,
        session: "m28-missions",
        kind: "codex",
        state: "working",
        since: 1_784_448_000,
        displayName: "Codex renderer",
      },
      {
        paneId: "%41",
        windowIndex: 2,
        session: "other-project",
        kind: "claude",
        state: "blocked",
        since: 1_784_448_000,
        displayName: "Unrelated agent",
      },
      {
        paneId: "%9",
        windowIndex: 1,
        session: "m28-review",
        kind: "codex",
        state: "done",
        since: 1_784_448_000,
        displayName: "Review agent",
      },
    ],
  };
}
