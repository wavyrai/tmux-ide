import { describe, expect, it } from "vitest";
import type {
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionDetailView,
  MissionProgressSummary,
  MissionProofSummary,
  TaskCardView,
} from "@tmux-ide/contracts";
import type { AgentRowInput } from "./agent-rows.ts";
import {
  MISSION_BOARD_COLUMNS,
  defaultMissionWorkspaceModel,
  missionWorkspaceHitTest,
  reconcileMissionWorkspaceModel,
} from "./missions-workspace.ts";
import {
  missionDashboardHitTest,
  missionDashboardInspectorGeometry,
  missionDashboardMainSize,
  missionDashboardProjection,
  type MissionDashboardProjection,
} from "./missions-dashboard.ts";
import { terminalDisplayWidth } from "./panel-host.ts";

function progress(overrides: Partial<MissionProgressSummary> = {}): MissionProgressSummary {
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

function proof(overrides: Partial<MissionProofSummary> = {}): MissionProofSummary {
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

function card(
  id: string,
  column: MissionBoardColumn,
  overrides: Partial<MissionCardView> = {},
): MissionCardView {
  return {
    version: 1,
    id,
    title: `Mission ${id}`,
    summary: `summary ${id}`,
    status:
      column === "planned"
        ? "planned"
        : column === "running"
          ? "started"
          : column === "blocked"
            ? "blocked"
            : column === "review"
              ? "review"
              : "completed",
    column,
    labels: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    durationMs: null,
    progress: progress(),
    blockedBy: [],
    latestAttempt: null,
    proofSummary: proof(),
    refs: { missionId: id, taskIds: [], attemptIds: [], proofIds: [] },
    ...overrides,
  };
}

function task(id: string, overrides: Partial<TaskCardView> = {}): TaskCardView {
  return {
    version: 1,
    id,
    missionId: "mis_running",
    title: `Task ${id}`,
    summary: `summary ${id}`,
    status: "started",
    column: "running",
    priority: 2,
    dependencies: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    durationMs: null,
    latestAttempt: null,
    proofSummary: proof(),
    refs: { missionId: "mis_running", taskId: id, attemptIds: [], proofIds: [] },
    ...overrides,
  };
}

function board(): MissionBoardView {
  const columns = Object.fromEntries(
    MISSION_BOARD_COLUMNS.map((column) => [
      column,
      [card(`mis_${column}`, column, column === "running" ? { id: "mis_running" } : {})],
    ]),
  ) as MissionBoardView["columns"];
  return {
    version: 1,
    columns,
    counts: {
      planned: 1,
      running: 1,
      blocked: 1,
      review: 1,
      done: 1,
      total: 5,
    },
  };
}

function snapshot(): Parameters<typeof missionDashboardProjection>[3] {
  const attempt = {
    id: "att_running",
    taskId: "tsk_running",
    status: "running" as const,
    agent: "codex",
    harness: "harness",
    model: "gpt-5",
    terminal: "%7",
    session: "demo-session",
    startedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    durationMs: null,
    proofIds: [],
  };
  const runningMission = card("mis_running", "running", {
    latestAttempt: attempt,
    refs: {
      missionId: "mis_running",
      taskIds: ["tsk_running"],
      attemptIds: ["att_running"],
      proofIds: [],
    },
  });
  const taskOne = task("tsk_running", {
    latestAttempt: attempt,
    refs: {
      missionId: "mis_running",
      taskId: "tsk_running",
      attemptIds: ["att_running"],
      proofIds: [],
      terminal: "%7",
      session: "demo-session",
    },
  });
  const b = board();
  b.columns.running = [runningMission];
  return {
    board: b,
    history: [
      {
        version: 1,
        mission: card("mis_done", "done"),
        outcome: "completed",
        finishedAt: "2026-01-01T00:10:00.000Z",
        durationMs: 600_000,
        taskTotals: progress({ total: 1, done: 1, completed: 1, planned: 0, running: 0 }),
        attemptTotals: {
          total: 1,
          submitted: 1,
          approved: 0,
          rejected: 0,
          failed: 0,
          interrupted: 0,
          running: 0,
        },
        proofSummary: proof(),
        lastEvent: null,
      },
    ],
    detail: {
      version: 1,
      mission: runningMission,
      taskBoard: {
        columns: {
          planned: [],
          running: [taskOne],
          blocked: [],
          review: [],
          done: [],
        },
        counts: { planned: 0, running: 1, blocked: 0, review: 0, done: 0, total: 1 },
      },
      attempts: [attempt],
      proofSummary: proof(),
      progress: progress(),
      timeline: [
        {
          version: 1,
          sequence: 3,
          timestamp: "2026-01-01T00:00:03.000Z",
          missionId: "mis_running",
          taskId: "tsk_running",
          attemptId: "att_running",
          type: "attempt.started",
          label: "Attempt started",
          actor: { type: "user", id: "pm" },
          refs: {
            missionId: "mis_running",
            taskId: "tsk_running",
            attemptId: "att_running",
            terminal: "%7",
            session: "demo-session",
          },
        },
      ],
    } satisfies MissionDetailView,
    project: { identityKey: "project", projectRoot: "/repo/demo" },
    loadedAt: "2026-07-19T00:00:00.000Z",
  };
}

function agents(): AgentRowInput[] {
  return [
    {
      paneId: "%8",
      windowIndex: 0,
      session: "other-session",
      kind: "codex",
      state: "blocked",
      since: 1,
      displayName: "unrelated-codex",
    },
    {
      paneId: "%7",
      windowIndex: 1,
      session: "demo-session",
      kind: "codex",
      state: "working",
      since: 2,
      displayName: "runner",
    },
    {
      paneId: "%9",
      windowIndex: 2,
      session: "demo-session",
      kind: "claude",
      state: "idle",
      since: 3,
    },
  ];
}

function assertProjectionBounds(projection: MissionDashboardProjection) {
  expect(projection.main.x).toBe(0);
  expect(projection.main.y).toBe(0);
  expect(projection.main.width).toBeGreaterThan(0);
  expect(projection.main.height).toBe(projection.height);
  if (projection.inspector) {
    expect(projection.inspector.x).toBe(projection.main.width + 1);
    expect(projection.main.width + 1 + projection.inspector.width).toBe(projection.width);
    expect(projection.inspector.height).toBe(projection.height);
    const bodyWidth = Math.max(1, projection.inspector.width - 2);
    expect(projection.inspector.rows.length).toBeLessThanOrEqual(projection.inspector.bodyRows);
    expect(
      projection.inspector.borderRows +
        projection.inspector.titleRows +
        projection.inspector.rows.length,
    ).toBeLessThanOrEqual(projection.inspector.height);
    for (const row of projection.inspector.rows) {
      expect(terminalDisplayWidth(`${row.label}: ${row.value}`)).toBeLessThanOrEqual(bodyWidth);
    }
  } else {
    expect(projection.main.width).toBe(projection.width);
  }
  for (const column of projection.main.layout.board.columns) {
    expect(column.x).toBeGreaterThanOrEqual(0);
    expect(column.x + column.width).toBeLessThanOrEqual(projection.main.width);
    expect(column.height).toBeGreaterThanOrEqual(1);
  }
}

describe("missions dashboard projection", () => {
  it("projects narrow, medium, and wide regions with bounded main plus inspector widths", () => {
    const model = defaultMissionWorkspaceModel("mis_running", "tsk_running");
    const snap = snapshot();
    const narrow = missionDashboardProjection(80, 24, model, snap);
    const medium = missionDashboardProjection(120, 40, model, snap);
    const wide = missionDashboardProjection(200, 60, model, snap);

    expect(narrow.variant).toBe("narrow");
    expect(narrow.inspector).toBeNull();
    expect(medium.variant).toBe("medium");
    expect(medium.inspector?.variant).toBe("medium");
    expect(wide.variant).toBe("wide");
    expect(wide.inspector?.variant).toBe("wide");
    expect(missionDashboardMainSize(120, 40).mainWidth).toBe(medium.main.width);
    expect(missionDashboardMainSize(200, 60).mainWidth).toBe(wide.main.width);
    assertProjectionBounds(narrow);
    assertProjectionBounds(medium);
    assertProjectionBounds(wide);
  });

  it("projects exact bordered inspector title and body rows at short heights", () => {
    expect(missionDashboardInspectorGeometry(24, 1)).toEqual({
      borderRows: 0,
      titleRows: 1,
      bodyRows: 0,
    });
    expect(missionDashboardInspectorGeometry(24, 2)).toEqual({
      borderRows: 2,
      titleRows: 0,
      bodyRows: 0,
    });
    expect(missionDashboardInspectorGeometry(24, 3)).toEqual({
      borderRows: 2,
      titleRows: 1,
      bodyRows: 0,
    });
    expect(missionDashboardInspectorGeometry(24, 4)).toEqual({
      borderRows: 2,
      titleRows: 1,
      bodyRows: 1,
    });

    for (const height of [1, 2, 3, 4, 24]) {
      const projection = missionDashboardProjection(
        120,
        height,
        defaultMissionWorkspaceModel("mis_running", "tsk_running"),
        snapshot(),
      );
      const inspector = projection.inspector!;
      expect(inspector.rows.length).toBeLessThanOrEqual(inspector.bodyRows);
      expect(
        inspector.borderRows + inspector.titleRows + inspector.rows.length,
      ).toBeLessThanOrEqual(inspector.height);
      expect(inspector.bodyRows).toBeGreaterThanOrEqual(0);
      expect(inspector.titleRows).toBeGreaterThanOrEqual(0);
    }
  });

  it("shows selected mission task facts and prioritizes pane/session matched agents", () => {
    const model = defaultMissionWorkspaceModel("mis_running", "tsk_running");
    const projection = missionDashboardProjection(200, 60, model, snapshot(), {
      agents: agents(),
    });

    expect(projection.inspector?.rows.map((row) => `${row.label}:${row.value}`)).toContain(
      "task:tsk_running · started · p2",
    );
    expect(projection.inspector?.agents.map((agent) => [agent.display, agent.rank])).toEqual([
      ["runner", "pane"],
      ["claude", "session"],
    ]);
  });

  it("uses kind/display fallback only when exact pane and session matches are absent", () => {
    const snap = snapshot();
    snap.detail!.attempts[0] = {
      ...snap.detail!.attempts[0]!,
      terminal: "%404",
      session: "missing-session",
    };
    snap.detail!.mission = {
      ...snap.detail!.mission,
      latestAttempt: snap.detail!.attempts[0]!,
    };
    snap.detail!.taskBoard.columns.running[0] = {
      ...snap.detail!.taskBoard.columns.running[0]!,
      latestAttempt: snap.detail!.attempts[0]!,
    };
    const projection = missionDashboardProjection(
      200,
      60,
      defaultMissionWorkspaceModel("mis_running", "tsk_running"),
      snap,
      { agents: agents() },
    );

    expect(projection.inspector?.agents.map((agent) => [agent.display, agent.rank])).toEqual([
      ["unrelated-codex", "kind"],
      ["runner", "kind"],
    ]);
  });

  it("does not invent task context when persisted selectedTaskId is null or stale", () => {
    const noTask = missionDashboardProjection(
      200,
      60,
      defaultMissionWorkspaceModel("mis_running", null),
      snapshot(),
    );
    const staleTask = missionDashboardProjection(
      200,
      60,
      defaultMissionWorkspaceModel("mis_running", "tsk_missing"),
      snapshot(),
    );

    expect(noTask.inspector?.rows.find((row) => row.key === "task")?.value).toBe(
      "no task selected",
    );
    expect(staleTask.inspector?.rows.find((row) => row.key === "task")?.value).toBe(
      "no task selected",
    );
  });

  it("degrades explicitly at medium and narrow widths without duplicate selection state", () => {
    const model = defaultMissionWorkspaceModel("mis_running", "tsk_running");
    const medium = missionDashboardProjection(120, 24, model, snapshot());
    const narrow = missionDashboardProjection(80, 24, model, snapshot());

    expect(medium.inspector?.rows.some((row) => row.key === "mission")).toBe(true);
    expect(medium.inspector?.rows.some((row) => row.key === "task")).toBe(true);
    expect(narrow.inspector).toBeNull();
    assertProjectionBounds(medium);
    assertProjectionBounds(narrow);
  });

  it("routes mission hit tests through main-region coordinates and leaves inspector inert", () => {
    const model = defaultMissionWorkspaceModel("mis_running");
    const projection = missionDashboardProjection(200, 40, model, snapshot());
    const firstCard = projection.main.layout.board.columns[1]!.cards[0]!;

    expect(
      missionDashboardHitTest(projection, firstCard.x + projection.main.x, firstCard.y),
    ).toEqual(missionWorkspaceHitTest(projection.main.layout, firstCard.x, firstCard.y));
    expect(
      missionDashboardHitTest(projection, projection.inspector!.x + 2, projection.inspector!.y + 2),
    ).toBeNull();
  });

  it("reconciles selected board columns against the dashboard main width at medium sizes", () => {
    const snap = snapshot();
    const fullCanvasModel = reconcileMissionWorkspaceModel(
      {
        ...defaultMissionWorkspaceModel("mis_done"),
        selectedColumn: "done",
      },
      snap,
      { width: 120, height: 24 },
    );
    const dashboardSize = missionDashboardMainSize(120, 24);
    const dashboardModel = reconcileMissionWorkspaceModel(
      {
        ...defaultMissionWorkspaceModel("mis_done"),
        selectedColumn: "done",
      },
      snap,
      { width: dashboardSize.mainWidth, height: dashboardSize.height },
    );

    expect(dashboardSize.mainWidth).toBe(95);
    expect(
      missionDashboardProjection(120, 24, dashboardModel, snap).main.layout.board.visibleColumns,
    ).toContain("done");
    expect(fullCanvasModel.horizontalOffset).toBe(0);
    expect(dashboardModel.horizontalOffset).toBeGreaterThan(0);
  });
});
