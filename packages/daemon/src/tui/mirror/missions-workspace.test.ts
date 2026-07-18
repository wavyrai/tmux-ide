import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MissionBoardColumn,
  MissionBoardView,
  MissionCardView,
  MissionHistorySummary,
  MissionProgressSummary,
  MissionProofSummary,
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
  defaultMissionWorkspaceModel,
  invalidatedMissionWorkspaceLoadState,
  missionCardLines,
  missionHistoryLines,
  missionSelectionFromWorkspaceState,
  missionWorkspaceHitTest,
  missionWorkspaceLayout,
  moveMissionSelection,
  readMissionWorkspace,
  reconcileMissionWorkspaceModel,
  scrollMissionWorkspace,
  setMissionWorkspaceMode,
  workspaceStateWithMissionSelection,
} from "./missions-workspace.ts";
import { defaultWorkspaceUiState, serializeWorkspaceUiState } from "./workspace-ui-state.ts";
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

function snapshot(boardView = board({}), historyView: MissionHistorySummary[] = []) {
  return {
    board: boardView,
    history: historyView,
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
      const loaded = readMissionWorkspace(repository, () => new Date("2026-01-01T00:00:00.000Z"));
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
        expect(column.width).toBeLessThanOrEqual(layout.width);
        expect(column.x + column.width).toBeLessThanOrEqual(layout.width);
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
    expect(missionWorkspaceHitTest(layout, 1, 3)).toEqual({
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
    expect(missionSelectionFromWorkspaceState(state, "missions-a")).toBe("mis_new");
  });

  it("persists only selectedMissionId per exact missions view without projection blobs", () => {
    const state = workspaceStateWithMissionSelection(
      defaultWorkspaceUiState(),
      "mission-a",
      "mis_one",
    );
    const next = workspaceStateWithMissionSelection(state, "mission-b", "mis_two");
    expect(missionSelectionFromWorkspaceState(next, "mission-a")).toBe("mis_one");
    expect(missionSelectionFromWorkspaceState(next, "mission-b")).toBe("mis_two");
    const json = serializeWorkspaceUiState(next);
    expect(json).toContain('"selectedTaskId": null');
    expect(json).not.toContain("columns");
    expect(json).not.toContain("history");
    expect(json).not.toContain("projection");
  });
});

function terminalWidth(value: string): number {
  return terminalDisplayWidth(value);
}
