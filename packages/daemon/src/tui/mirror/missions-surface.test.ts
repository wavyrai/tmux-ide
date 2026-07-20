import { describe, expect, it } from "vitest";
import {
  defaultMissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";
import {
  handleMissionSurfaceKey,
  handleMissionSurfacePointerDown,
  handleMissionSurfaceScroll,
  missionSurfaceCommandsForHit,
  missionSurfaceCommandsForKey,
  type MissionSurfaceControllerActions,
} from "./missions-surface-controller.ts";

const layoutSize = { width: 80, height: 24 };

function snapshot(): MissionWorkspaceSnapshot {
  const mission = {
    id: "mis_demo",
    column: "planned",
  };
  return {
    board: {
      columns: {
        planned: [mission],
        running: [],
        blocked: [],
        review: [],
        done: [],
      },
      counts: { planned: 1, running: 0, blocked: 0, review: 0, done: 0, total: 1 },
    },
    history: [],
    detail: null,
    project: { identityKey: "project", projectRoot: "/project" },
    loadedAt: "2026-07-19T00:00:00.000Z",
  } as MissionWorkspaceSnapshot;
}

function actionsFor(modelRef: { model: ReturnType<typeof defaultMissionWorkspaceModel> }) {
  const calls: string[] = [];
  const actions: MissionSurfaceControllerActions = {
    updateModel: (updater) => {
      calls.push("update");
      modelRef.model = updater(modelRef.model);
    },
    refresh: () => calls.push("refresh"),
    followDeepLink: (kind) => calls.push(`link:${kind}`),
    persistSelection: (missionId, taskId) =>
      calls.push(`persist:${missionId ?? ""}:${taskId ?? ""}`),
  };
  return { actions, calls };
}

describe("missions surface boundary", () => {
  it("exposes stable local command descriptors for keyboard and mouse actions", () => {
    const state = {
      model: defaultMissionWorkspaceModel("mis_demo", "tsk_demo"),
      snapshot: snapshot(),
      layoutSize,
      persistedTaskId: "tsk_saved",
    };

    expect(
      missionSurfaceCommandsForKey(
        { name: "return", ctrl: false, meta: false, shift: false },
        state,
      ),
    ).toEqual([
      expect.objectContaining({
        id: "mission.detail.open",
        label: "Open mission detail",
        role: "open",
        disabled: false,
        payload: {
          type: "open-detail",
          persist: true,
          selectedMissionId: "mis_demo",
          selectedTaskId: "tsk_demo",
        },
        metadata: { source: "keyboard", target: undefined },
      }),
    ]);

    expect(
      missionSurfaceCommandsForHit(
        { kind: "card", missionId: "mis_demo", column: "planned", index: 0, hoverKey: 0 },
        state,
      ),
    ).toEqual([
      expect.objectContaining({
        id: "mission.select.card",
        role: "navigate",
        payload: expect.objectContaining({ type: "select-hit" }),
        metadata: { source: "mouse", target: "card" },
      }),
      expect.objectContaining({
        id: "mission.detail.open",
        role: "open",
        payload: expect.objectContaining({
          type: "open-detail",
          persist: false,
          selectedMissionId: "mis_demo",
        }),
        metadata: { source: "mouse", target: undefined },
      }),
    ]);
  });

  it("marks snapshot-dependent commands disabled while keeping global commands available", () => {
    const state = {
      model: defaultMissionWorkspaceModel(),
      snapshot: null,
      layoutSize,
      persistedTaskId: null,
    };

    expect(
      missionSurfaceCommandsForKey(
        { name: "down", ctrl: false, meta: false, shift: false },
        state,
      )[0],
    ).toMatchObject({
      id: "mission.selection.down",
      disabled: true,
      disabledReason: "mission snapshot is not loaded",
    });
    expect(
      missionSurfaceCommandsForKey({ name: "r", ctrl: false, meta: false, shift: false }, state)[0],
    ).toMatchObject({ id: "mission.refresh", disabled: false });
  });

  it("maps keys to explicit navigation and action dependencies", () => {
    const state = {
      model: defaultMissionWorkspaceModel("mis_demo"),
      snapshot: null,
      layoutSize,
      persistedTaskId: null,
    };
    const { actions, calls } = actionsFor({ model: state.model });

    expect(
      handleMissionSurfaceKey(
        { name: "r", ctrl: false, meta: false, shift: false },
        state,
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfaceKey(
        { name: "t", ctrl: false, meta: false, shift: false },
        state,
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfaceKey(
        { name: "z", ctrl: false, meta: false, shift: false },
        state,
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfaceKey(
        { name: "c", ctrl: false, meta: false, shift: false },
        state,
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfaceKey(
        { name: "x", ctrl: false, meta: false, shift: false },
        state,
        actions,
      ),
    ).toBe(true);

    expect(calls).toEqual(["refresh", "link:terminal", "update", "update", "update"]);
  });

  it("keeps enter persistence/detail behavior outside JSX and refreshes missing detail", () => {
    const modelRef = { model: defaultMissionWorkspaceModel("mis_demo", "tsk_demo") };
    const { actions, calls } = actionsFor(modelRef);

    handleMissionSurfaceKey(
      { name: "return", ctrl: false, meta: false, shift: false },
      { model: modelRef.model, snapshot: snapshot(), layoutSize, persistedTaskId: "tsk_saved" },
      actions,
    );

    expect(calls).toEqual(["persist:mis_demo:tsk_demo", "update", "refresh"]);
    expect(modelRef.model.mode).toBe("detail");
    expect(modelRef.model.selectedMissionId).toBe("mis_demo");
  });

  it("routes pointer hits through explicit action callbacks", () => {
    const modelRef = { model: defaultMissionWorkspaceModel() };
    const { actions, calls } = actionsFor(modelRef);

    expect(
      handleMissionSurfacePointerDown(
        { kind: "refresh" },
        { model: modelRef.model, snapshot: snapshot(), layoutSize, persistedTaskId: null },
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfacePointerDown(
        { kind: "deep-link", link: "files" },
        { model: modelRef.model, snapshot: snapshot(), layoutSize, persistedTaskId: null },
        actions,
      ),
    ).toBe(true);
    expect(
      handleMissionSurfacePointerDown(
        { kind: "card", missionId: "mis_demo", column: "planned", index: 0, hoverKey: 0 },
        { model: modelRef.model, snapshot: snapshot(), layoutSize, persistedTaskId: null },
        actions,
      ),
    ).toBe(true);

    expect(calls).toEqual(["refresh", "link:files", "update", "update", "refresh"]);
    expect(modelRef.model.mode).toBe("detail");
    expect(modelRef.model.selectedMissionId).toBe("mis_demo");
  });

  it("routes scroll without requiring app-level mission model knowledge", () => {
    const modelRef = { model: defaultMissionWorkspaceModel("mis_demo") };
    const { actions, calls } = actionsFor(modelRef);

    expect(
      handleMissionSurfaceScroll(
        { kind: "column", column: "planned" },
        "down",
        { model: modelRef.model, snapshot: snapshot(), layoutSize, persistedTaskId: null },
        actions,
        3,
      ),
    ).toBe(true);

    expect(calls).toEqual(["update"]);
    expect(modelRef.model.columnScroll.planned).toBe(0);
  });
});
