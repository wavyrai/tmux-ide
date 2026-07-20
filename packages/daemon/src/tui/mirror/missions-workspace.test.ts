import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionDetailView,
  MissionHistorySummary,
  MissionProgressSummary,
  MissionProofSummary,
  TaskCardView,
} from "@tmux-ide/contracts";
import type { ProjectResolution } from "../../lib/project-resolver.ts";
import { createProjectRuntimeRepository } from "../../lib/project-runtime-repository.ts";
import {
  MISSION_BOARD_COLUMNS,
  MISSION_COLUMN_LABELS,
  MISSION_FOOTER_ROWS,
  MISSION_HEADER_ROWS,
  MissionWorkspaceLoader,
  applyMissionWorkspaceHit,
  clipTerminal,
  cycleMissionDensity,
  closeMissionDetail,
  defaultMissionWorkspaceModel,
  invalidatedMissionWorkspaceLoadState,
  missionCardLines,
  missionDetailAttemptLines,
  missionDetailProofLines,
  missionDetailTaskLines,
  missionDetailTimelineLines,
  missionHistoryLines,
  missionSelectionFromWorkspaceState,
  missionTmuxPanePreflightMatches,
  missionTmuxPreflightCommands,
  missionModelFromWorkspaceState,
  missionWorkspaceHitTest,
  missionWorkspaceLayout,
  pinnedPrimaryLine,
  moveMissionSelection,
  openMissionDetail,
  readMissionWorkspace,
  reconcileMissionWorkspaceModel,
  resolveMissionDeepLink,
  scrollMissionWorkspace,
  setMissionDetailSection,
  setMissionWorkspaceMode,
  toggleMissionColumnCollapse,
  toggleMissionColumnZoom,
  workspaceStateWithMissionModel,
  workspaceStateWithMissionSelection,
} from "./missions-workspace.ts";
import {
  absoluteProjectPath,
  defaultWorkspaceUiState,
  serializeWorkspaceUiState,
} from "./workspace-ui-state.ts";
import { terminalDisplayWidth } from "./panel-host.ts";

function progress(overrides: Partial<MissionProgressSummary> = {}): MissionProgressSummary {
  return {
    total: 4,
    planned: 1,
    running: 1,
    blocked: 0,
    review: 0,
    completed: 2,
    failed: 0,
    cancelled: 0,
    done: 2,
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
  title = id,
  overrides: Partial<MissionCardView> = {},
): MissionCardView {
  return {
    version: 1,
    id,
    title,
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

function board(columns: Partial<Record<MissionBoardColumn, MissionCardView[]>>): MissionBoardView {
  const full = Object.fromEntries(
    MISSION_BOARD_COLUMNS.map((column) => [column, columns[column] ?? []]),
  ) as MissionBoardView["columns"];
  return {
    version: 1,
    columns: full,
    counts: {
      planned: full.planned.length,
      running: full.running.length,
      blocked: full.blocked.length,
      review: full.review.length,
      done: full.done.length,
      total: MISSION_BOARD_COLUMNS.reduce((sum, column) => sum + full[column].length, 0),
    },
  };
}

function history(
  id: string,
  outcome: MissionHistorySummary["outcome"] = "completed",
): MissionHistorySummary {
  const mission = card(id, "done", `History ${id}`);
  return {
    version: 1,
    mission,
    outcome,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z",
    durationMs: 300_000,
    taskTotals: progress({ total: 2, done: 2, completed: 2, planned: 0, running: 0 }),
    attemptTotals: {
      total: 3,
      submitted: 1,
      approved: 1,
      rejected: 1,
      failed: 0,
      interrupted: 0,
      running: 0,
    },
    proofSummary: proof({
      proofIds: ["prf_one"],
      hasProof: true,
      tests: { suites: 1, passed: 9, failed: 0, skipped: 1, total: 10 },
      diff: {
        summaries: ["changed files"],
        urls: [],
        filesChanged: 3,
        insertions: 10,
        deletions: 2,
      },
      prs: [{ number: 122, status: "merged" }],
    }),
    lastEvent: {
      version: 1,
      sequence: 9,
      timestamp: "2026-01-01T00:05:00.000Z",
      missionId: id,
      type: "mission.completed",
      label: "Mission completed",
      actor: { type: "user", id: "pm" },
      refs: { missionId: id },
    },
  };
}

function task(
  id: string,
  column: MissionBoardColumn,
  overrides: Partial<TaskCardView> = {},
): TaskCardView {
  return {
    version: 1,
    id,
    missionId: "mis_detail",
    title: `Task ${id}`,
    summary: `summary ${id}`,
    status:
      column === "planned"
        ? "ready"
        : column === "running"
          ? "started"
          : column === "blocked"
            ? "blocked"
            : column === "review"
              ? "submitted"
              : "completed",
    column,
    priority: 1,
    dependencies: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    durationMs: null,
    latestAttempt: null,
    proofSummary: proof(),
    refs: { missionId: "mis_detail", taskId: id, attemptIds: [], proofIds: [] },
    ...overrides,
  };
}

function detail(overrides: Partial<MissionDetailView> = {}): MissionDetailView {
  const setup = task("tsk_setup", "planned", {
    latestAttempt: {
      id: "att_setup",
      taskId: "tsk_setup",
      status: "approved",
      outcome: "approved",
      agent: "worker",
      harness: "codex",
      model: "gpt-5",
      terminal: "%7",
      session: "proj",
      worktree: "apps/api",
      startedAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      finishedAt: "2026-01-01T00:02:00.000Z",
      durationMs: 60_000,
      proofIds: ["prf_one"],
    },
    proofSummary: proof({
      proofIds: ["prf_one"],
      hasProof: true,
      tests: { suites: 1, passed: 4, failed: 0, skipped: 0, total: 4 },
      diff: {
        summaries: ["apps/api/index.ts"],
        urls: [],
        filesChanged: 1,
        insertions: 5,
        deletions: 1,
      },
      artifacts: [{ name: "source", uri: "apps/api/index.ts" }],
    }),
    refs: {
      missionId: "mis_detail",
      taskId: "tsk_setup",
      attemptIds: ["att_setup"],
      proofIds: ["prf_one"],
      terminal: "%7",
      session: "proj",
      worktree: "apps/api",
    },
  });
  const finish = task("tsk_finish", "done", { priority: 2 });
  return {
    version: 1,
    mission: card("mis_detail", "running", "Mission detail", {
      latestAttempt: setup.latestAttempt,
      progress: progress({ total: 2, running: 1, completed: 1, done: 1, planned: 0 }),
      proofSummary: setup.proofSummary,
      refs: {
        missionId: "mis_detail",
        taskIds: ["tsk_setup", "tsk_finish"],
        attemptIds: ["att_setup"],
        proofIds: ["prf_one"],
      },
    }),
    taskBoard: {
      columns: {
        planned: [setup],
        running: [],
        blocked: [],
        review: [],
        done: [finish],
      },
      counts: { planned: 1, running: 0, blocked: 0, review: 0, done: 1, total: 2 },
    },
    attempts: [setup.latestAttempt!],
    proofSummary: setup.proofSummary,
    progress: progress({ total: 2, running: 1, completed: 1, done: 1, planned: 0 }),
    timeline: [
      {
        version: 1,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        missionId: "mis_detail",
        type: "mission.created",
        label: "Mission created",
        actor: { type: "user", id: "pm" },
        refs: { missionId: "mis_detail" },
      },
      {
        version: 1,
        sequence: 2,
        timestamp: "2026-01-01T00:01:00.000Z",
        missionId: "mis_detail",
        taskId: "tsk_setup",
        attemptId: "att_setup",
        proofId: "prf_one",
        type: "attempt.approved",
        label: "Attempt approved",
        actor: { type: "agent", id: "worker" },
        reason: "tests passed",
        refs: {
          missionId: "mis_detail",
          taskId: "tsk_setup",
          attemptId: "att_setup",
          proofId: "prf_one",
          terminal: "%7",
          session: "proj",
          worktree: "apps/api",
        },
      },
    ],
    ...overrides,
  };
}

function snapshot(
  boardView = board({}),
  historyView: MissionHistorySummary[] = [],
  detailView: MissionDetailView | null = null,
) {
  return {
    board: boardView,
    history: historyView,
    detail: detailView,
    project: { identityKey: "git-abc", projectRoot: "/repo" },
    loadedAt: "2026-01-01T00:00:00.000Z",
  };
}

function resolution(projectRoot: string): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: `git-${"c".repeat(64)}`,
    identitySource: "git-common-dir",
    identityAnchor: join(projectRoot, ".git"),
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
  };
}

describe("missions workspace loader/model", () => {
  it("loads missing mission history as an empty detached snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-missions-"));
    try {
      const repository = createProjectRuntimeRepository(resolution(root), {
        home: join(root, ".state"),
      });
      const loaded = readMissionWorkspace(
        repository,
        null,
        () => new Date("2026-01-01T00:00:00.000Z"),
      );
      expect(loaded.board.counts.total).toBe(0);
      expect(loaded.history).toEqual([]);
      expect(loaded.project.identityKey).toBe(repository.metadata.identityKey);
      loaded.history.push(history("mis_later"));
      expect(readMissionWorkspace(repository).history).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps loading/error/empty/ready states generation-safe across project changes", () => {
    const loader = new MissionWorkspaceLoader();
    const slow = loader.begin("project-a");
    const fast = loader.begin("project-b");
    expect(loader.accept(slow.generation, "project-a", snapshot())).toBeNull();
    const empty = loader.accept(fast.generation, "project-b", snapshot());
    expect(empty?.status).toBe("empty");
    const readyStart = loader.begin("project-b");
    const ready = loader.accept(
      readyStart.generation,
      "project-b",
      snapshot(board({ planned: [card("mis_a", "planned")] })),
    );
    expect(ready?.status).toBe("ready");
    expect(loader.reject(slow.generation, "project-a", new Error("bad"))).toBeNull();
    expect(loader.reject(readyStart.generation, "project-b", new Error("corrupt"))).toMatchObject({
      status: "error",
      message: "corrupt",
    });
    const prior = {
      ...snapshot(board({ planned: [card("mis_prior", "planned")] })),
      project: { identityKey: "project-b", projectRoot: "/repo" },
    };
    const refreshing = loader.begin("project-b", prior);
    expect(refreshing).toMatchObject({ status: "refreshing", snapshot: prior });
    const otherProjectPrior = {
      ...prior,
      project: { identityKey: "project-a", projectRoot: "/repo-a" },
    };
    expect(loader.begin("project-b", otherProjectPrior).status).toBe("loading");
    loader.cancel();
    expect(loader.accept(refreshing.generation, "project-b", snapshot())).toBeNull();
    expect(invalidatedMissionWorkspaceLoadState()).toEqual({
      status: "loading",
      generation: 0,
      projectKey: null,
    });
  });

  it("consumes projected board column labels/counts/order without re-sorting", () => {
    const view = board({
      planned: [card("mis_two", "planned"), card("mis_one", "planned")],
      blocked: [card("mis_blocked", "blocked")],
    });
    expect(MISSION_BOARD_COLUMNS.map((column) => MISSION_COLUMN_LABELS[column])).toEqual([
      "Planned",
      "Running",
      "Blocked",
      "Review",
      "Done",
    ]);
    expect(view.columns.planned.map((item) => item.id)).toEqual(["mis_two", "mis_one"]);
    expect(view.counts).toMatchObject({ planned: 2, running: 0, blocked: 1, total: 3 });
  });

  it("restores selection by mission id and reconciles removal, terminal transition, and empty data", () => {
    const active = snapshot(
      board({ planned: [card("mis_a", "planned")], running: [card("mis_b", "running")] }),
    );
    const restored = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel(), active, {
      persistedMissionId: "mis_b",
    });
    expect(restored.selectedMissionId).toBe("mis_b");
    expect(restored.selectedColumn).toBe("running");

    const removed = reconcileMissionWorkspaceModel(
      restored,
      snapshot(board({ blocked: [card("mis_c", "blocked")] })),
    );
    expect(removed.selectedMissionId).toBe("mis_c");
    expect(removed.selectedColumn).toBe("blocked");

    const terminal = setMissionWorkspaceMode(
      restored,
      snapshot(board({}), [history("mis_b"), history("mis_done_2")]),
      "history",
    );
    expect(terminal.selectedMissionId).toBe("mis_b");

    const empty = reconcileMissionWorkspaceModel(terminal, snapshot(board({}), []));
    expect(empty.selectedMissionId).toBeNull();
  });

  it("moves selection while skipping empty columns, preserving nearest row, and following horizontal viewport", () => {
    const view = snapshot(
      board({
        planned: [card("mis_p0", "planned"), card("mis_p1", "planned")],
        blocked: [card("mis_b0", "blocked")],
        done: [card("mis_d0", "done"), card("mis_d1", "done"), card("mis_d2", "done")],
      }),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel(), view, {
      persistedMissionId: "mis_p1",
      width: 50,
      height: 8,
    });
    model = moveMissionSelection(model, view, "right", { width: 50, height: 8 });
    expect(model.selectedMissionId).toBe("mis_b0");
    expect(model.selectedColumn).toBe("blocked");
    model = moveMissionSelection(model, view, "right", { width: 50, height: 8 });
    expect(model.selectedMissionId).toBe("mis_d0");
    expect(model.horizontalOffset).toBeGreaterThan(0);
    model = moveMissionSelection(model, view, "end", { width: 50, height: 8 });
    expect(model.selectedMissionId).toBe("mis_d2");
    model = moveMissionSelection(model, view, "up", { width: 50, height: 8 });
    expect(model.selectedMissionId).toBe("mis_d1");
  });

  it("computes narrow/medium/wide geometry, density heights, and exact Unicode clipping", () => {
    const model = defaultMissionWorkspaceModel("mis_a");
    const view = snapshot(
      board({ planned: [card("mis_a", "planned", "Pair 👨‍💻 and Flag 🇳🇱 key 1️⃣ 分析 Café")] }),
    );
    const narrow = missionWorkspaceLayout(
      30,
      12,
      reconcileMissionWorkspaceModel(model, view, { width: 30, height: 12 }),
      view,
    );
    const medium = missionWorkspaceLayout(72, 12, model, view);
    const wide = missionWorkspaceLayout(180, 12, model, view);
    expect(narrow.board.visibleColumns.length).toBe(1);
    expect(medium.board.visibleColumns.length).toBeGreaterThan(1);
    expect(wide.board.visibleColumns).toEqual([...MISSION_BOARD_COLUMNS]);
    expect(cycleMissionDensity(model, view).density).toBe("detailed");
    const clipped = clipTerminal("ASCII 分析 Café 👨‍💻 🇳🇱 1️⃣", 14);
    expect(terminalWidth(clipped)).toBeLessThanOrEqual(14);
    expect(
      missionCardLines(view.board.columns.planned[0]!, "detailed", 18).every(
        (line) => terminalWidth(line) <= 18,
      ),
    ).toBe(true);
  });

  it("projects framed board lanes with active state, title counts, and bounded bodies", () => {
    const view = snapshot(
      board({
        planned: [card("mis_a", "planned"), card("mis_b", "planned")],
        running: [card("mis_c", "running")],
      }),
    );
    const model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_c"), view, {
      width: 56,
      height: 12,
    });
    const layout = missionWorkspaceLayout(56, 12, model, view);
    expect(
      layout.board.columns.map((column) => [column.column, column.title, column.active]),
    ).toEqual([
      ["planned", "Planned · 2", false],
      ["running", "Running · 1", true],
    ]);
    for (const column of layout.board.columns) {
      expect(column.y).toBe(MISSION_HEADER_ROWS);
      expect(column.height).toBe(layout.height - MISSION_HEADER_ROWS - MISSION_FOOTER_ROWS);
      expect(column.x + column.width).toBeLessThanOrEqual(layout.width);
      expect(column.bodyX).toBeGreaterThanOrEqual(column.x);
      expect(column.bodyY).toBeGreaterThan(column.y);
      expect(column.bodyX + column.bodyWidth).toBeLessThanOrEqual(column.x + column.width);
      expect(column.bodyY + column.bodyHeight).toBeLessThanOrEqual(column.y + column.height);
      for (const item of column.cards) {
        expect(item.x).toBe(column.bodyX);
        expect(item.width).toBe(column.bodyWidth);
        expect(item.y).toBeGreaterThanOrEqual(column.bodyY);
        expect(item.y + item.height).toBeLessThanOrEqual(layout.height - MISSION_FOOTER_ROWS);
      }
    }
  });

  it("formats dense mission rows by density with pinned status, progress, and agent", () => {
    const latestAttempt = {
      id: "att_a",
      taskId: "tsk_a",
      status: "running",
      outcome: null,
      agent: "worker",
      harness: "codex",
      model: "gpt-5",
      terminal: "%7",
      session: "proj",
      worktree: "apps/api",
      startedAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      finishedAt: null,
      durationMs: null,
      proofIds: [],
    };
    const mission = card("mis_a", "running", "Dense mission", { latestAttempt });
    const compact = missionCardLines(mission, "compact", 80)[0]!;
    expect(compact.startsWith("Dense mission")).toBe(true);
    expect(compact.endsWith("started 2/4 @worker")).toBe(true);
    expect(terminalWidth(compact)).toBe(80);
    const comfortable = missionCardLines(mission, "comfortable", 80);
    expect(comfortable).toHaveLength(3);
    expect(comfortable[1]).toBe("summary mis_a");
    expect(comfortable[2]).toBe("attempt worker/codex");
    expect(
      missionCardLines(mission, "detailed", 12).every((line) => terminalWidth(line) <= 12),
    ).toBe(true);
  });

  it("pins mission and task primary metadata at realistic and narrow widths", () => {
    const longTitle =
      "Implement the extremely long and descriptive mission board responsive surface";
    const latestAttempt = {
      id: "att_a",
      taskId: "tsk_a",
      status: "running",
      outcome: null,
      agent: "coordinator",
      harness: "codex",
      model: "gpt-5",
      terminal: "%7",
      session: "proj",
      worktree: "apps/api",
      startedAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
      finishedAt: null,
      durationMs: null,
      proofIds: [],
    };
    const mission = card("mis_a", "running", longTitle, { latestAttempt });
    for (const width of [24, 28, 32]) {
      const line = missionCardLines(mission, "compact", width)[0]!;
      expect(terminalWidth(line)).toBeLessThanOrEqual(width);
      expect(line).toMatch(/started 2\/4 @coordinator$/);
    }
    expect(missionCardLines(mission, "compact", 12)[0]).toBe("started 2/4");
    expect(missionCardLines(mission, "compact", 8)[0]).toBe("started…");
    const comfortable = missionCardLines(
      card("mis_blocked", "running", longTitle, {
        latestAttempt,
        blockedBy: ["tsk_a", "tsk_b", "tsk_c", "tsk_d"],
      }),
      "comfortable",
      32,
    );
    expect(comfortable[0]).toMatch(/started 2\/4 @coordinator$/);
    expect(comfortable[1]).toBe("summary mis_blocked");
    expect(comfortable[2]).toBe("blocked by 4");
    expect(comfortable.join("\n")).not.toContain("agent coordinator");

    const longTask = task("tsk_long", "running", {
      title: "Implement a very long selected task row with stable right metadata",
      latestAttempt,
    });
    const taskLine = missionDetailTaskLines(longTask, "compact", 28)[0]!;
    expect(terminalWidth(taskLine)).toBeLessThanOrEqual(28);
    expect(taskLine).toMatch(/started p1 @coordinator$/);
    expect(missionDetailTaskLines(longTask, "compact", 10)[0]).toBe("started p1");
    expect(pinnedPrimaryLine(longTitle, 0, "started 2/4", "coordinator")).toBe("");
  });

  it("uses density-aware item capacity and never overflows into the footer", () => {
    const many = Array.from({ length: 8 }, (_, index) => card(`mis_${index}`, "planned"));
    const view = snapshot(
      board({ planned: many }),
      many.map((item) => history(item.id)),
    );
    for (const density of ["compact", "comfortable", "detailed"] as const) {
      const model = reconcileMissionWorkspaceModel(
        { ...defaultMissionWorkspaceModel("mis_7"), density },
        view,
        { height: 9 },
      );
      const layout = missionWorkspaceLayout(40, 9, model, view);
      const footerTop = layout.height - MISSION_FOOTER_ROWS;
      for (const column of layout.board.columns) {
        expect(column.cards.length).toBeLessThanOrEqual(layout.board.itemCapacity);
        for (const item of column.cards) {
          expect(item.y + item.height).toBeLessThanOrEqual(footerTop);
        }
      }
      const historyModel = setMissionWorkspaceMode(model, view, "history", { height: 9 });
      const historyLayout = missionWorkspaceLayout(40, 9, historyModel, view);
      expect(historyLayout.history.rows.length).toBeLessThanOrEqual(
        historyLayout.history.itemCapacity,
      );
      for (const row of historyLayout.history.rows) {
        expect(row.y + row.height).toBeLessThanOrEqual(footerTop);
      }
    }
  });

  it("keeps whole narrow columns within canvas and follows selected offscreen columns", () => {
    const view = snapshot(board({ done: [card("mis_done", "done")] }));
    const model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_done"), view, {
      width: 20,
      height: 10,
    });
    expect(model.horizontalOffset).toBe(4);
    for (const width of [1, 20, 22]) {
      const layout = missionWorkspaceLayout(width, 10, model, view);
      expect(layout.board.visibleColumns.length).toBe(1);
      for (const column of layout.board.columns) {
        expect(column.width).toBeGreaterThanOrEqual(0);
        expect(column.height).toBeGreaterThanOrEqual(0);
        expect(column.bodyWidth).toBeGreaterThanOrEqual(0);
        expect(column.bodyHeight).toBeGreaterThanOrEqual(0);
        expect(column.width).toBeLessThanOrEqual(layout.width);
        expect(column.x + column.width).toBeLessThanOrEqual(layout.width);
        expect(column.bodyX + column.bodyWidth).toBeLessThanOrEqual(layout.width);
        expect(column.bodyY + column.bodyHeight).toBeLessThanOrEqual(
          layout.height - MISSION_FOOTER_ROWS,
        );
        for (const item of column.cards)
          expect(item.x + item.width).toBeLessThanOrEqual(layout.width);
      }
      const historyModel = setMissionWorkspaceMode(model, view, "history", { width, height: 10 });
      const historyLayout = missionWorkspaceLayout(width, 10, historyModel, view);
      for (const row of historyLayout.history.rows) {
        expect(row.x + row.width).toBeLessThanOrEqual(historyLayout.width);
      }
    }
  });

  it("keeps independent column/history scroll state and clamps after shrink", () => {
    const view = snapshot(
      board({
        planned: [card("mis_a", "planned"), card("mis_b", "planned"), card("mis_c", "planned")],
        done: [card("mis_d", "done")],
      }),
      [history("mis_h1"), history("mis_h2"), history("mis_h3")],
    );
    let model = scrollMissionWorkspace(defaultMissionWorkspaceModel("mis_c"), view, "planned", 10, {
      height: 4,
    });
    model = scrollMissionWorkspace(model, view, "history", 10, { height: 4 });
    expect(model.columnScroll.planned).toBeGreaterThan(0);
    expect(model.columnScroll.done).toBe(0);
    model.selectedMissionId = "mis_h3";
    model = setMissionWorkspaceMode(model, view, "history", { height: 4 });
    expect(model.historyScroll).toBeGreaterThan(0);
    const shrunk = snapshot(board({ planned: [card("mis_a", "planned")] }), [history("mis_h1")]);
    const clamped = reconcileMissionWorkspaceModel(model, shrunk, { height: 24 });
    expect(clamped.columnScroll.planned).toBe(0);
    expect(clamped.historyScroll).toBe(0);
  });

  it("keeps keyboard selection visible in long columns across movement, density, and resize", () => {
    const many = Array.from({ length: 20 }, (_, index) => card(`mis_${index}`, "planned"));
    const view = snapshot(board({ planned: many }));
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_0"), view, {
      width: 80,
      height: 10,
    });
    for (let index = 0; index < 19; index++) {
      model = moveMissionSelection(model, view, "down", { width: 80, height: 10 });
    }
    expect(model.selectedMissionId).toBe("mis_19");
    let layout = missionWorkspaceLayout(80, 10, model, view);
    expect(layout.board.columns[0]!.cards.map((item) => item.missionId)).toContain("mis_19");
    model = cycleMissionDensity(model, view, { width: 80, height: 10 });
    layout = missionWorkspaceLayout(80, 10, model, view);
    expect(layout.board.columns[0]!.cards.map((item) => item.missionId)).toContain("mis_19");
    model = reconcileMissionWorkspaceModel(model, view, { width: 80, height: 6 });
    layout = missionWorkspaceLayout(80, 6, model, view);
    expect(layout.board.columns[0]!.cards.map((item) => item.missionId)).toContain("mis_19");
    model = moveMissionSelection(model, view, "home", { width: 80, height: 6 });
    expect(model.selectedMissionId).toBe("mis_0");
    expect(model.columnScroll.planned).toBe(0);
  });

  it("keeps detail task selection visible with projected scroll geometry", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => task(`tsk_${index}`, "planned"));
    const view = snapshot(
      board({ running: [card("mis_detail", "running")] }),
      [],
      detail({
        taskBoard: {
          columns: { planned: tasks, running: [], blocked: [], review: [], done: [] },
          counts: { planned: 9, running: 0, blocked: 0, review: 0, done: 0, total: 9 },
        },
      }),
    );
    let model = openMissionDetail(defaultMissionWorkspaceModel("mis_detail"), view, {
      width: 56,
      height: 12,
    });
    model = moveMissionSelection(model, view, "end", { width: 56, height: 12 });
    const layout = missionWorkspaceLayout(56, 12, model, view);
    expect(model.selectedTaskId).toBe("tsk_8");
    expect(layout.detail.rows.map((row) => row.id)).toContain("tsk_8");
    for (const row of layout.detail.rows) {
      expect(row.y + row.height).toBeLessThanOrEqual(layout.height - MISSION_FOOTER_ROWS);
    }
  });

  it("formats history projected outcome/duration/task/attempt/proof/diff/test/pr/last event fields", () => {
    const lines = missionHistoryLines(history("mis_done", "failed"), "detailed", 120).join("\n");
    expect(lines).toContain("failed");
    expect(lines).toContain("5m");
    expect(lines).toContain("2/2 tasks");
    expect(lines).toContain("approved");
    expect(lines).toContain("submitted");
    expect(lines).toContain("rejected");
    expect(lines).toContain("tests 9/10");
    expect(lines).toContain("diff 3");
    expect(lines).toContain("PR 122");
    expect(lines).toContain("Mission completed");
  });

  it("hit-tests mode chips, cards, history rows, and horizontal affordances against layout", () => {
    const view = snapshot(board({ planned: [card("mis_a", "planned")] }), [history("mis_h1")]);
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_a"), view);
    let layout = missionWorkspaceLayout(80, 20, model, view);
    const boardChip = layout.header.rows[0]!.find((chip) => chip.mode === "board")!;
    const refreshChip = layout.header.rows[0]!.find((chip) => chip.kind === "refresh")!;
    const rightChip = layout.header.rows[1]!.find((chip) => chip.direction === 1)!;
    expect(missionWorkspaceHitTest(layout, boardChip.start, boardChip.row)).toEqual({
      kind: "mode",
      mode: "board",
    });
    expect(missionWorkspaceHitTest(layout, refreshChip.start, refreshChip.row)).toEqual({
      kind: "refresh",
    });
    expect(missionWorkspaceHitTest(layout, rightChip.start, rightChip.row)).toEqual({
      kind: "horizontal",
      direction: 1,
    });
    const planned = layout.board.columns.find((column) => column.column === "planned")!;
    expect(missionWorkspaceHitTest(layout, planned.x, planned.y)).toEqual({
      kind: "column",
      column: "planned",
    });
    const firstCard = planned.cards[0]!;
    expect(missionWorkspaceHitTest(layout, firstCard.x, firstCard.y)).toEqual({
      kind: "card",
      missionId: "mis_a",
      column: "planned",
      index: 0,
      hoverKey: 0,
    });
    model = setMissionWorkspaceMode(model, view, "history");
    layout = missionWorkspaceLayout(80, 20, model, view);
    expect(missionWorkspaceHitTest(layout, 1, MISSION_HEADER_ROWS)).toEqual({
      kind: "history",
      missionId: "mis_h1",
      index: 0,
      hoverKey: 0,
    });
  });

  it("assigns unique card hover keys across visible columns", () => {
    const view = snapshot(
      board({
        planned: [
          card("mis_p0", "planned"),
          card("mis_p1", "planned"),
          ...Array.from({ length: 9_999 }, (_, index) => card(`mis_px_${index}`, "planned")),
          card("mis_p10000", "planned"),
        ],
        running: [card("mis_r0", "running"), card("mis_r1", "running")],
      }),
    );
    const layout = missionWorkspaceLayout(
      80,
      20,
      {
        ...defaultMissionWorkspaceModel("mis_p10000"),
        columnScroll: { planned: 10_000, running: 0, blocked: 0, review: 0, done: 0 },
      },
      view,
    );
    const keys = layout.board.columns.flatMap((column) =>
      column.cards.map((item) => item.hoverKey),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(50_000);
    expect(keys).toContain(1);
  });

  it("applies pointer hits deterministically, including column header first-card selection", () => {
    const view = snapshot(
      board({
        planned: [card("mis_a", "planned")],
        blocked: [card("mis_b", "blocked"), card("mis_c", "blocked")],
      }),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_a"), view);
    model = applyMissionWorkspaceHit(model, view, { kind: "column", column: "blocked" });
    expect(model.selectedMissionId).toBe("mis_b");
    model = applyMissionWorkspaceHit(model, view, {
      kind: "card",
      missionId: "mis_c",
      column: "blocked",
      index: 1,
      hoverKey: 7,
    });
    expect(model.selectedMissionId).toBe("mis_c");
  });

  it("projects horizontal overflow hints and header hit parity for density collapse zoom and arrows", () => {
    const view = snapshot(board({ done: [card("mis_done", "done")] }));
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_done"), view, {
      width: 56,
      height: 10,
    });
    let layout = missionWorkspaceLayout(56, 10, model, view);
    expect(layout.header.labels[1]).toContain("more <");
    for (const kind of ["density", "collapse", "zoom", "refresh"] as const) {
      const chip = layout.header.rows[0]!.find((item) => item.kind === kind)!;
      expect(missionWorkspaceHitTest(layout, chip.start, chip.row)).toEqual({ kind });
    }
    const left = layout.header.rows[1]!.find((item) => item.direction === -1)!;
    model = applyMissionWorkspaceHit(
      model,
      view,
      { kind: "horizontal", direction: -1 },
      {
        width: 56,
        height: 10,
      },
    );
    expect(model.horizontalOffset).toBe(3);
    model = { ...model, horizontalOffset: 2 };
    layout = missionWorkspaceLayout(56, 10, model, view);
    expect(missionWorkspaceHitTest(layout, left.start, left.row)).toEqual({
      kind: "horizontal",
      direction: -1,
    });
    expect(layout.header.labels[1]).toContain("more <>");
  });

  it("collapses and expands focused lanes without discarding mission data or bounds", () => {
    const view = snapshot(
      board({
        planned: [card("mis_a", "planned")],
        running: [card("mis_b", "running"), card("mis_c", "running")],
      }),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_b"), view, {
      width: 56,
      height: 12,
    });
    model = toggleMissionColumnCollapse(model, view, { width: 56, height: 12 });
    expect(model.collapsedColumns.running).toBe(true);
    let layout = missionWorkspaceLayout(56, 12, model, view);
    const running = layout.board.columns.find((column) => column.column === "running")!;
    expect(running.collapsed).toBe(true);
    expect(running.title).toBe("Ru 2");
    expect(running.cards).toEqual([]);
    expect(view.board.columns.running).toHaveLength(2);
    expect(running.x + running.width).toBeLessThanOrEqual(layout.width);
    model = toggleMissionColumnCollapse(model, view, { width: 56, height: 12 });
    layout = missionWorkspaceLayout(56, 12, model, view);
    expect(layout.board.columns.find((column) => column.column === "running")!.cards).toHaveLength(
      2,
    );
  });

  it("packs variable-width board windows so collapsed rails reveal additional lanes", () => {
    const view = snapshot(
      board({
        planned: [card("mis_a", "planned")],
        running: [card("mis_b", "running")],
        blocked: [card("mis_c", "blocked")],
        review: [card("mis_d", "review")],
      }),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_a"), view, {
      width: 56,
      height: 12,
    });
    let layout = missionWorkspaceLayout(56, 12, model, view);
    expect(layout.board.visibleColumns).toEqual(["planned", "running"]);
    model = toggleMissionColumnCollapse(model, view, { width: 56, height: 12 });
    layout = missionWorkspaceLayout(56, 12, model, view);
    expect(layout.board.visibleColumns).toEqual(["planned", "running", "blocked"]);
    expect(layout.board.columns[0]!.collapsed).toBe(true);
    for (const column of layout.board.columns) {
      expect(column.x + column.width).toBeLessThanOrEqual(layout.width);
      expect(column.bodyX + column.bodyWidth).toBeLessThanOrEqual(layout.width);
    }
    model = toggleMissionColumnCollapse(model, view, { width: 56, height: 12 });
    layout = missionWorkspaceLayout(56, 12, model, view);
    expect(layout.board.visibleColumns).toEqual(["planned", "running"]);
    expect(layout.header.labels[1]).toContain("more >");
  });

  it("projects compact collapsed lane titles that preserve identity and count inside body width", () => {
    const view = snapshot(
      board({ running: Array.from({ length: 12 }, (_, i) => card(`mis_${i}`, "running")) }),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_0"), view, {
      width: 56,
      height: 12,
    });
    model = toggleMissionColumnCollapse(model, view, { width: 56, height: 12 });
    const layout = missionWorkspaceLayout(56, 12, model, view);
    const running = layout.board.columns.find((column) => column.column === "running")!;
    expect(running.collapsed).toBe(true);
    expect(running.bodyWidth).toBe(6);
    expect(running.title).toBe("Ru 12");
    expect(terminalWidth(running.title)).toBeLessThanOrEqual(running.bodyWidth);
  });

  it("keeps shortest lane title visibility and card geometry in sync with projection", () => {
    const view = snapshot(board({ planned: [card("mis_a", "planned")] }));
    const model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_a"), view, {
      width: 56,
      height: 4,
    });
    const layout = missionWorkspaceLayout(56, 4, model, view);
    const planned = layout.board.columns[0]!;
    expect(planned.titleRows).toBe(0);
    expect(planned.showTitle).toBe(false);
    expect(planned.cards).toHaveLength(1);
    expect(planned.cards[0]!.height).toBe(1);
    expect(planned.cards[0]!.y + planned.cards[0]!.height).toBeLessThanOrEqual(
      layout.height - MISSION_FOOTER_ROWS,
    );
  });

  it("zooms the focused column and restores the prior board window deterministically", () => {
    const view = snapshot(board({ done: [card("mis_done", "done")] }));
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_done"), view, {
      width: 20,
      height: 10,
    });
    expect(model.horizontalOffset).toBe(4);
    model.horizontalOffset = 3;
    model = toggleMissionColumnZoom(model, view, { width: 20, height: 10 });
    expect(model.zoomColumn).toBe("done");
    expect(model.zoomRestoreHorizontalOffset).toBe(3);
    let layout = missionWorkspaceLayout(20, 10, model, view);
    expect(layout.board.visibleColumns).toEqual(["done"]);
    expect(layout.board.columns[0]!.width).toBe(20);
    model = toggleMissionColumnZoom(model, view, { width: 20, height: 10 });
    expect(model.zoomColumn).toBeNull();
    expect(model.horizontalOffset).toBe(3);
    layout = missionWorkspaceLayout(20, 10, model, view);
    expect(layout.board.visibleColumns).toEqual(["review"]);
  });

  it("keeps header chip spans non-overlapping at narrow, medium, and wide widths", () => {
    for (const width of [20, 56, 72, 120, 180]) {
      const layout = missionWorkspaceLayout(width, 10, defaultMissionWorkspaceModel(), snapshot());
      expect(layout.header.labels).toHaveLength(2);
      expect(layout.header.labels.every((label) => terminalWidth(label) <= width)).toBe(true);
      expect(terminalWidth(layout.header.labels[1])).toBe(width);
      expect(terminalWidth(layout.footer.label)).toBe(width);
      if (width >= 56) {
        expect(layout.header.rows[0]!.map((chip) => chip.kind)).toEqual([
          "mode",
          "mode",
          "density",
          "collapse",
          "zoom",
          "refresh",
        ]);
      }
      for (const row of layout.header.rows) {
        const sorted = [...row].sort((a, b) => a.start - b.start);
        for (const [index, chip] of sorted.entries()) {
          expect(chip.start).toBeGreaterThanOrEqual(0);
          expect(chip.start + chip.width).toBeLessThanOrEqual(layout.width);
          const previous = sorted[index - 1];
          if (previous) expect(chip.start).toBeGreaterThanOrEqual(previous.start + previous.width);
        }
      }
    }
  });

  it("keeps presentation context/status/footer bounded at smoke widths", () => {
    const loaded = snapshot(board({ planned: [card("mis_a", "planned")] }), [
      history("mis_done"),
      history("mis_failed", "failed"),
    ]);
    for (const width of [20, 56, 120]) {
      const layout = missionWorkspaceLayout(width, 10, defaultMissionWorkspaceModel(), loaded, {
        loadStatus: "refreshing",
        projectLabel: "/repo/apps/api",
        quitHint: "^q detach",
      });
      expect(terminalWidth(layout.header.labels[0])).toBeLessThanOrEqual(width);
      expect(terminalWidth(layout.header.labels[1])).toBe(width);
      expect(terminalWidth(layout.footer.label)).toBe(width);
      expect(layout.header.labels[1].startsWith("<")).toBe(true);
      expect(layout.header.labels[1].endsWith(">")).toBe(true);
      expect(layout.footer.label.startsWith("^q detach")).toBe(true);
      expect(layout.header.rows[1]).toEqual([
        { kind: "horizontal", direction: -1, label: "<", row: 1, start: 0, width: 1 },
        { kind: "horizontal", direction: 1, label: ">", row: 1, start: width - 1, width: 1 },
      ]);
    }
    const wide = missionWorkspaceLayout(120, 10, defaultMissionWorkspaceModel(), loaded, {
      loadStatus: "refreshing",
      projectLabel: "/repo/apps/api",
      quitHint: "^q detach",
    });
    expect(wide.header.labels[1]).toContain("refreshing");
    expect(wide.header.labels[1]).toContain("api");
    expect(wide.header.labels[1]).toContain("1 total");
    expect(wide.header.labels[1]).toContain("2 finished");
  });

  it("persists reconciled fallback selection when refreshed data removes the prior mission", () => {
    const initial = snapshot(board({ planned: [card("mis_old", "planned")] }));
    const refreshed = snapshot(board({ running: [card("mis_new", "running")] }));
    const model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel(), initial, {
      persistedMissionId: "mis_old",
    });
    const reconciled = reconcileMissionWorkspaceModel(model, refreshed, {
      persistedMissionId: "mis_old",
    });
    const state = workspaceStateWithMissionSelection(
      defaultWorkspaceUiState(),
      "missions-a",
      reconciled.selectedMissionId,
    );
    expect(missionSelectionFromWorkspaceState(state, "missions-a")).toEqual({
      selectedMissionId: "mis_new",
      selectedTaskId: null,
    });
  });

  it("opens detail from board/history and returns to the originating surface", () => {
    const view = snapshot(
      board({ running: [card("mis_detail", "running")] }),
      [history("mis_done")],
      detail(),
    );
    let model = reconcileMissionWorkspaceModel(defaultMissionWorkspaceModel("mis_detail"), view);
    model = openMissionDetail(model, view, { persistedTaskId: "tsk_setup" });
    expect(model.mode).toBe("detail");
    expect(model.detailReturnMode).toBe("board");
    expect(model.selectedTaskId).toBe("tsk_setup");
    expect(closeMissionDetail(model).mode).toBe("board");

    model = setMissionWorkspaceMode(model, view, "history");
    model = openMissionDetail(model, view);
    expect(model.detailReturnMode).toBe("history");
    expect(closeMissionDetail(model).mode).toBe("history");
  });

  it("keeps detail mode active while selected detail is loading for an existing mission", () => {
    const boardOnly = snapshot(
      board({
        planned: [card("mis_other", "planned")],
        running: [card("mis_detail", "running")],
      }),
    );
    const model = openMissionDetail(defaultMissionWorkspaceModel("mis_detail"), boardOnly);
    expect(model.mode).toBe("detail");
    expect(model.selectedMissionId).toBe("mis_detail");
    const loading = reconcileMissionWorkspaceModel(model, boardOnly, {
      persistedMissionId: "mis_other",
    });
    expect(loading.mode).toBe("detail");
    expect(loading.selectedMissionId).toBe("mis_detail");
    const loaded = reconcileMissionWorkspaceModel(
      loading,
      snapshot(boardOnly.board, [], detail()),
      { persistedMissionId: "mis_other" },
    );
    expect(loaded.mode).toBe("detail");
    expect(loaded.selectedMissionId).toBe("mis_detail");
    const missing = reconcileMissionWorkspaceModel(model, snapshot(board({})));
    expect(missing.mode).toBe("board");
  });

  it("flattens task-board order, restores task by id, and falls back after removal", () => {
    const view = snapshot(board({ running: [card("mis_detail", "running")] }), [], detail());
    const restored = reconcileMissionWorkspaceModel(
      { ...defaultMissionWorkspaceModel("mis_detail", "tsk_finish"), mode: "detail" },
      view,
    );
    expect(restored.selectedTaskId).toBe("tsk_finish");
    const shrunk = snapshot(
      board({ running: [card("mis_detail", "running")] }),
      [],
      detail({
        taskBoard: {
          columns: {
            planned: [task("tsk_only", "planned")],
            running: [],
            blocked: [],
            review: [],
            done: [],
          },
          counts: { planned: 1, running: 0, blocked: 0, review: 0, done: 0, total: 1 },
        },
      }),
    );
    const fallback = reconcileMissionWorkspaceModel(restored, shrunk);
    expect(fallback.selectedTaskId).toBe("tsk_only");
  });

  it("renders bounded detail sections, hits section/rows/links, and clips Unicode safely", () => {
    const view = snapshot(board({ running: [card("mis_detail", "running")] }), [], detail());
    let model = openMissionDetail(defaultMissionWorkspaceModel("mis_detail"), view);
    for (const width of [20, 56, 72, 120]) {
      const layout = missionWorkspaceLayout(width, 10, model, view);
      expect(layout.detail.rows.every((row) => row.x + row.width <= layout.width)).toBe(true);
      expect(layout.detail.rows.every((row) => row.y + row.height <= layout.height - 1)).toBe(true);
      expect(layout.detail.rows.some((row) => row.kind === "context")).toBe(width < 72);
      expect(layout.detail.sections.map((chip) => chip.section)).toEqual([
        "tasks",
        "timeline",
        "attempts",
        "proof",
      ]);
      const chips = [...layout.detail.sections, ...layout.detail.links].sort(
        (a, b) => a.start - b.start,
      );
      for (const [index, chip] of chips.entries()) {
        expect(chip.start).toBeGreaterThanOrEqual(0);
        expect(chip.start + chip.width).toBeLessThanOrEqual(layout.width);
        const previous = chips[index - 1];
        if (previous) expect(chip.start).toBeGreaterThanOrEqual(previous.start + previous.width);
      }
      for (const section of layout.detail.sections) {
        expect(missionWorkspaceHitTest(layout, section.start, section.row)).toEqual({
          kind: "detail-section",
          section: section.section,
        });
      }
      for (const link of layout.detail.links) {
        expect(missionWorkspaceHitTest(layout, link.start, link.row)).toEqual({
          kind: "deep-link",
          link: link.link,
        });
      }
      const row = layout.detail.rows[0]!;
      const hit = missionWorkspaceHitTest(layout, row.x, row.y);
      if (row.kind === "context") {
        expect(hit).toBeNull();
      } else {
        expect(hit).toMatchObject({
          kind: "detail-row",
          section: "tasks",
          id: "tsk_setup",
        });
      }
      expect(row.lines.every((line) => terminalWidth(line) <= row.width)).toBe(true);
    }
    const lines = [
      missionDetailTaskLines(view.detail!.taskBoard.columns.planned[0]!, "detailed", 80).join("\n"),
      missionDetailTimelineLines(view.detail!.timeline[1]!, 80).join("\n"),
      missionDetailAttemptLines(view.detail!.attempts[0]!, "detailed", 80).join("\n"),
      missionDetailProofLines(view.detail!, "detailed", 80).join("\n"),
    ].join("\n");
    expect(lines).toContain("codex");
    expect(lines).toContain("Attempt approved");
    expect(lines).toContain("pane %7");
    expect(lines).toContain("tests 4/4");
    expect(missionDetailProofLines(view.detail!, "comfortable", 80)).toHaveLength(4);
    expect(missionDetailProofLines(view.detail!, "detailed", 80)).toHaveLength(5);
    expect(missionWorkspaceLayout(120, 24, model, view).footer.label).toContain("esc back");
    expect(missionWorkspaceLayout(120, 24, model, view).footer.label).toContain("t/f/d open");
  });

  it("keeps narrow detail scroll and selected task visibility width-aware", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(`tsk_${index}`, "planned"));
    const view = snapshot(
      board({ running: [card("mis_detail", "running")] }),
      [],
      detail({
        taskBoard: {
          columns: { planned: tasks, running: [], blocked: [], review: [], done: [] },
          counts: { planned: 6, running: 0, blocked: 0, review: 0, done: 0, total: 6 },
        },
      }),
    );
    let model = reconcileMissionWorkspaceModel(
      { ...defaultMissionWorkspaceModel("mis_detail", "tsk_5"), mode: "detail" },
      view,
      { width: 56, height: 24 },
    );
    expect(model.detailScroll.tasks).toBe(2);
    let layout = missionWorkspaceLayout(56, 24, model, view);
    expect(layout.detail.itemCapacity).toBe(4);
    expect(layout.detail.rows.filter((row) => row.kind === "tasks").map((row) => row.id)).toEqual([
      "tsk_2",
      "tsk_3",
      "tsk_4",
      "tsk_5",
    ]);

    model = moveMissionSelection(model, view, "home", { width: 56, height: 24 });
    expect(model.selectedTaskId).toBe("tsk_0");
    expect(model.detailScroll.tasks).toBe(0);
    model = moveMissionSelection(model, view, "end", { width: 56, height: 24 });
    expect(model.selectedTaskId).toBe("tsk_5");
    expect(model.detailScroll.tasks).toBe(2);

    layout = missionWorkspaceLayout(56, 6, model, view);
    expect(layout.detail.itemCapacity).toBe(0);
    expect(layout.detail.rows.length).toBeGreaterThan(0);
    expect(layout.detail.rows.every((row) => row.kind === "context")).toBe(true);
    expect(
      missionWorkspaceHitTest(layout, layout.detail.rows[0]!.x, layout.detail.rows[0]!.y),
    ).toBeNull();
  });

  it("keeps narrow mission context visible when the active detail section is empty", () => {
    const view = snapshot(
      board({ running: [card("mis_detail", "running")] }),
      [],
      detail({ attempts: [] }),
    );
    const model = setMissionDetailSection(
      openMissionDetail(defaultMissionWorkspaceModel("mis_detail"), view),
      view,
      "attempts",
    );
    const layout = missionWorkspaceLayout(56, 24, model, view);
    expect(layout.detail.itemCapacity).toBe(0);
    expect(layout.detail.rows.map((row) => row.kind)).toEqual(["context", "context"]);
    expect(layout.detail.rows[0]!.lines[0]).toContain("Mission detail");
  });

  it("keeps proof-section navigation deterministic when no proof is recorded", () => {
    const noProof = detail({ proofSummary: proof() });
    const view = snapshot(board({ running: [card("mis_detail", "running")] }), [], noProof);
    const model = setMissionDetailSection(
      openMissionDetail(defaultMissionWorkspaceModel("mis_detail"), view),
      view,
      "proof",
    );
    const layout = missionWorkspaceLayout(56, 10, model, view);
    expect(layout.detail.itemCapacity).toBeGreaterThan(0);
    const proofRow = layout.detail.rows.find((row) => row.kind === "proof");
    expect(proofRow).toMatchObject({ kind: "proof", id: "proof", index: 0 });
    expect(proofRow!.lines.join("\n")).toContain("no proof recorded");
    const scrolled = scrollMissionWorkspace(model, view, "proof", 10, { height: 10 });
    expect(scrolled.detailScroll.proof).toBe(0);
  });

  it("resolves safe deep-link intents and rejects missing, outside, traversal, and unsupported URI refs", () => {
    const views = [
      { id: "term", title: "Term", panel: "terminals" as const },
      { id: "files", title: "Files", panel: "files" as const },
      { id: "diff", title: "Diff", panel: "diff" as const },
    ];
    const model = defaultMissionWorkspaceModel("mis_detail", "tsk_setup");
    const projected = detail();
    expect(
      resolveMissionDeepLink("terminal", projected, model, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({
      available: true,
      intent: { kind: "terminal", session: "proj", paneId: "%7", viewId: "term" },
    });
    expect(
      resolveMissionDeepLink("files", projected, model, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({
      available: true,
      intent: { kind: "files", path: "/repo/apps/api/index.ts", mode: "open" },
    });
    expect(
      resolveMissionDeepLink(
        "files",
        detail({
          taskBoard: {
            columns: {
              planned: [
                task("tsk_setup", "planned", {
                  proofSummary: proof(),
                  refs: {
                    missionId: "mis_detail",
                    taskId: "tsk_setup",
                    attemptIds: [],
                    proofIds: [],
                    worktree: "apps/api",
                  },
                }),
              ],
              running: [],
              blocked: [],
              review: [],
              done: [],
            },
            counts: { planned: 1, running: 0, blocked: 0, review: 0, done: 0, total: 1 },
          },
        }),
        model,
        {
          projectRoot: "/repo",
          views,
          resolveProjectPath: absoluteProjectPath,
        },
      ),
    ).toMatchObject({
      available: true,
      intent: { kind: "files", path: "/repo/apps/api", mode: "reveal" },
    });
    expect(
      resolveMissionDeepLink("diff", projected, model, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({ available: true, intent: { kind: "diff", path: "/repo/apps/api" } });
    const unsafe = detail({
      proofSummary: proof({
        hasProof: true,
        proofIds: ["prf_bad"],
        artifacts: [{ name: "bad", uri: "https://example.com/file" }],
      }),
      taskBoard: {
        columns: {
          planned: [
            task("tsk_setup", "planned", {
              refs: {
                missionId: "mis_detail",
                taskId: "tsk_setup",
                attemptIds: [],
                proofIds: [],
                worktree: "../outside",
              },
            }),
          ],
          running: [],
          blocked: [],
          review: [],
          done: [],
        },
        counts: { planned: 1, running: 0, blocked: 0, review: 0, done: 0, total: 1 },
      },
    });
    expect(
      resolveMissionDeepLink("files", unsafe, model, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({ available: false });
    expect(
      resolveMissionDeepLink("terminal", projected, model, {
        projectRoot: "/repo",
        views: views.filter((view) => view.panel !== "terminals"),
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({ available: false, reason: "no configured Terminals view" });
  });

  it("scopes detail deep links to selected task refs and fails closed without them", () => {
    const views = [
      { id: "term", title: "Term", panel: "terminals" as const },
      { id: "files", title: "Files", panel: "files" as const },
      { id: "diff", title: "Diff", panel: "diff" as const },
    ];
    const selected = task("tsk_selected", "planned", {
      latestAttempt: {
        id: "att_selected",
        taskId: "tsk_selected",
        status: "approved",
        outcome: "approved",
        agent: "worker",
        harness: "codex",
        model: "gpt-5",
        terminal: "%selected",
        session: "selected-session",
        worktree: "apps/selected",
        startedAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
        finishedAt: "2026-01-01T00:02:00.000Z",
        durationMs: 60_000,
        proofIds: ["prf_selected"],
      },
      proofSummary: proof({
        proofIds: ["prf_selected"],
        hasProof: true,
        artifacts: [{ name: "selected", uri: "apps/selected/file.ts" }],
      }),
      refs: {
        missionId: "mis_detail",
        taskId: "tsk_selected",
        attemptIds: ["att_selected"],
        proofIds: ["prf_selected"],
        terminal: "%selected",
        session: "selected-session",
        worktree: "apps/selected",
      },
    });
    const sibling = task("tsk_sibling", "done", {
      latestAttempt: {
        ...selected.latestAttempt!,
        id: "att_sibling",
        taskId: "tsk_sibling",
        terminal: "%sibling",
        session: "sibling-session",
        worktree: "apps/sibling",
      },
      proofSummary: proof({
        proofIds: ["prf_sibling"],
        hasProof: true,
        artifacts: [{ name: "sibling", uri: "apps/sibling/file.ts" }],
      }),
      refs: {
        missionId: "mis_detail",
        taskId: "tsk_sibling",
        attemptIds: ["att_sibling"],
        proofIds: ["prf_sibling"],
        terminal: "%sibling",
        session: "sibling-session",
        worktree: "apps/sibling",
      },
    });
    const noRefs = task("tsk_no_refs", "blocked");
    const projected = detail({
      mission: card("mis_detail", "running", "Mission detail", {
        latestAttempt: sibling.latestAttempt,
        proofSummary: sibling.proofSummary,
      }),
      taskBoard: {
        columns: {
          planned: [selected, noRefs],
          running: [],
          blocked: [],
          review: [],
          done: [sibling],
        },
        counts: { planned: 2, running: 0, blocked: 0, review: 0, done: 1, total: 3 },
      },
      attempts: [selected.latestAttempt!, sibling.latestAttempt!],
      proofSummary: sibling.proofSummary,
    });
    const selectedModel = defaultMissionWorkspaceModel("mis_detail", "tsk_selected");
    expect(
      resolveMissionDeepLink("terminal", projected, selectedModel, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({
      available: true,
      intent: { kind: "terminal", session: "selected-session", paneId: "%selected" },
    });
    expect(
      resolveMissionDeepLink("files", projected, selectedModel, {
        projectRoot: "/repo",
        views,
        resolveProjectPath: absoluteProjectPath,
      }),
    ).toMatchObject({
      available: true,
      intent: { kind: "files", path: "/repo/apps/selected/file.ts", mode: "open" },
    });

    const noRefModel = defaultMissionWorkspaceModel("mis_detail", "tsk_no_refs");
    for (const link of ["terminal", "files", "diff"] as const) {
      expect(
        resolveMissionDeepLink(link, projected, noRefModel, {
          projectRoot: "/repo",
          views,
          resolveProjectPath: absoluteProjectPath,
        }),
      ).toMatchObject({ available: false });
    }
  });

  it("plans terminal deep-link preflight with hostile-looking values as single argv elements", () => {
    const commands = missionTmuxPreflightCommands({
      kind: "terminal",
      session: "proj; rm -rf /",
      paneId: "%7; send-keys pwn",
      viewId: "term",
    });
    expect(commands).toEqual([
      { kind: "session", file: "tmux", args: ["has-session", "-t", "=proj; rm -rf /"] },
      {
        kind: "pane",
        file: "tmux",
        args: ["display-message", "-p", "-t", "%7; send-keys pwn", "#{session_name}\t#{pane_id}"],
      },
    ]);
    expect(
      missionTmuxPanePreflightMatches(
        "proj; rm -rf /\t%7; send-keys pwn\n",
        commands[0]!.args[2].slice(1),
        "%7; send-keys pwn",
      ),
    ).toBe(true);
    expect(
      missionTmuxPanePreflightMatches(
        "other\t%7; send-keys pwn\n",
        commands[0]!.args[2].slice(1),
        "%7; send-keys pwn",
      ),
    ).toBe(false);
  });

  it("persists one dock Missions selection independently of hosted view aliases", () => {
    const state = workspaceStateWithMissionSelection(
      defaultWorkspaceUiState(),
      "mission-a",
      "mis_one",
      "tsk_one",
    );
    const next = workspaceStateWithMissionSelection(state, "mission-b", "mis_two");
    expect(missionSelectionFromWorkspaceState(next, "mission-a")).toEqual({
      selectedMissionId: "mis_two",
      selectedTaskId: null,
    });
    expect(missionSelectionFromWorkspaceState(next, "mission-b")).toEqual({
      selectedMissionId: "mis_two",
      selectedTaskId: null,
    });
    const json = serializeWorkspaceUiState(next);
    expect(json).toContain('"selectedTaskId": null');
    expect(json).not.toContain("columns");
    expect(json).not.toContain("history");
    expect(json).not.toContain("projection");
  });

  it("persists one dock Missions navigation model without projection blobs", () => {
    const viewA = {
      id: "mission-a",
      title: "Missions A",
      panel: "missions",
      layout: null,
      glyph: "◆",
      order: 0,
      shortcut: null,
    } as const;
    const viewB = { ...viewA, id: "mission-b", title: "Missions B" };
    let model = {
      ...defaultMissionWorkspaceModel("mis_one", "tsk_one"),
      mode: "board" as const,
      density: "detailed" as const,
      selectedColumn: "done" as const,
      preferredRow: 7,
      columnScroll: { planned: 0, running: 2, blocked: 0, review: 0, done: 5 },
      horizontalOffset: 3,
      collapsedColumns: {
        planned: false,
        running: true,
        blocked: false,
        review: true,
        done: false,
      },
      zoomColumn: "done" as const,
      zoomRestoreHorizontalOffset: 2,
    };
    const state = workspaceStateWithMissionModel(defaultWorkspaceUiState(), viewA.id, model);
    const isolated = workspaceStateWithMissionModel(
      state,
      viewB.id,
      defaultMissionWorkspaceModel("mis_two"),
    );
    expect(missionModelFromWorkspaceState(isolated, viewA).selectedMissionId).toBe("mis_two");
    expect(missionModelFromWorkspaceState(isolated, viewA).columnScroll.done).toBe(0);
    expect(missionModelFromWorkspaceState(isolated, viewA).collapsedColumns.running).toBe(false);
    expect(missionModelFromWorkspaceState(isolated, viewA).zoomColumn).toBeNull();
    expect(missionModelFromWorkspaceState(isolated, viewB).selectedMissionId).toBe("mis_two");
    const json = serializeWorkspaceUiState(isolated);
    expect(json).toContain('"navigation"');
    expect(json).not.toContain("columns");
    expect(json).not.toContain("projection");

    const legacy = workspaceStateWithMissionSelection(
      defaultWorkspaceUiState(),
      viewA.id,
      "mis_legacy",
      "tsk_legacy",
    );
    model = missionModelFromWorkspaceState(legacy, viewA, defaultMissionWorkspaceModel());
    expect(model.selectedMissionId).toBe("mis_legacy");
    expect(model.selectedTaskId).toBe("tsk_legacy");
    expect(model.density).toBe("comfortable");
    expect(model.collapsedColumns).toEqual({
      planned: false,
      running: false,
      blocked: false,
      review: false,
      done: false,
    });
  });
});

function terminalWidth(value: string): number {
  return terminalDisplayWidth(value);
}
