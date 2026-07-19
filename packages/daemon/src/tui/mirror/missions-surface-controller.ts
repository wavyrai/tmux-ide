import {
  applyMissionWorkspaceHit,
  closeMissionDetail,
  cycleMissionDensity,
  cycleMissionDetailSection,
  moveMissionSelection,
  openMissionDetail,
  scrollMissionWorkspace,
  setMissionDetailSection,
  setMissionWorkspaceMode,
  toggleMissionColumnCollapse,
  toggleMissionColumnZoom,
  type MissionDeepLinkKind,
  type MissionWorkspaceHit,
  type MissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";

export interface MissionSurfaceKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface MissionSurfaceLayoutSize {
  width: number;
  height: number;
}

export interface MissionSurfaceControllerState {
  model: MissionWorkspaceModel;
  snapshot: MissionWorkspaceSnapshot | null;
  layoutSize: MissionSurfaceLayoutSize;
  persistedTaskId: string | null;
}

export interface MissionSurfaceControllerActions {
  updateModel: (updater: (model: MissionWorkspaceModel) => MissionWorkspaceModel) => void;
  refresh: () => void;
  followDeepLink: (kind: MissionDeepLinkKind) => void;
  persistSelection: (missionId: string | null, taskId: string | null) => void;
}

export function handleMissionSurfaceKey(
  event: MissionSurfaceKeyEvent,
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  const { snapshot, layoutSize } = state;
  if (event.name === "r") {
    actions.refresh();
    return true;
  }
  if (event.name === "t" || event.name === "f" || event.name === "d") {
    actions.followDeepLink(event.name === "t" ? "terminal" : event.name === "f" ? "files" : "diff");
    return true;
  }
  if (event.name === "z") {
    actions.updateModel((model) => cycleMissionDensity(model, snapshot, layoutSize));
    return true;
  }
  if (event.name === "c") {
    actions.updateModel((model) => toggleMissionColumnCollapse(model, snapshot, layoutSize));
    return true;
  }
  if (event.name === "x") {
    actions.updateModel((model) => toggleMissionColumnZoom(model, snapshot, layoutSize));
    return true;
  }
  if (!snapshot) return true;
  if (state.model.mode === "detail") {
    if (event.name === "escape" || event.name === "backspace") {
      actions.updateModel(closeMissionDetail);
      return true;
    }
    if (event.name === "tab") {
      actions.updateModel((model) =>
        cycleMissionDetailSection(model, snapshot, event.shift ? -1 : 1, layoutSize),
      );
      return true;
    }
    const sectionKey =
      event.name === "1"
        ? "tasks"
        : event.name === "2"
          ? "timeline"
          : event.name === "3"
            ? "attempts"
            : event.name === "4"
              ? "proof"
              : null;
    if (sectionKey) {
      actions.updateModel((model) =>
        setMissionDetailSection(model, snapshot, sectionKey, layoutSize),
      );
      return true;
    }
  }
  if (event.name === "tab") {
    actions.updateModel((model) =>
      setMissionWorkspaceMode(
        model,
        snapshot,
        model.mode === "board" ? "history" : "board",
        layoutSize,
      ),
    );
    return true;
  }
  if (event.name === "b" || event.name === "y") {
    actions.updateModel((model) =>
      setMissionWorkspaceMode(
        model,
        snapshot,
        event.name === "b" ? "board" : "history",
        layoutSize,
      ),
    );
    return true;
  }
  const movement =
    event.name === "left" || event.name === "h"
      ? "left"
      : event.name === "right" || event.name === "l"
        ? "right"
        : event.name === "up" || event.name === "k"
          ? "up"
          : event.name === "down" || event.name === "j"
            ? "down"
            : event.name === "home"
              ? "home"
              : event.name === "end"
                ? "end"
                : null;
  if (movement) {
    actions.updateModel((model) => moveMissionSelection(model, snapshot, movement, layoutSize));
    return true;
  }
  if (event.name === "return") {
    const selected = state.model.selectedMissionId;
    if (selected) {
      actions.persistSelection(selected, state.model.selectedTaskId);
      actions.updateModel((model) =>
        openMissionDetail(model, snapshot, {
          persistedTaskId: state.persistedTaskId,
          ...layoutSize,
        }),
      );
      if (snapshot.detail?.mission.id !== selected) actions.refresh();
    }
    return true;
  }
  return true;
}

export function handleMissionSurfaceScroll(
  hit: MissionWorkspaceHit,
  direction: "up" | "down",
  state: MissionSurfaceControllerState,
  actions: Pick<MissionSurfaceControllerActions, "updateModel">,
  step: number,
): boolean {
  const { snapshot, model, layoutSize } = state;
  if (!snapshot) return true;
  const delta = direction === "up" ? -step : step;
  const target =
    hit?.kind === "detail-row"
      ? hit.section
      : model.mode === "detail"
        ? model.detailSection
        : hit?.kind === "card" || hit?.kind === "column"
          ? hit.column
          : model.mode === "history"
            ? "history"
            : model.selectedColumn;
  actions.updateModel((current) =>
    scrollMissionWorkspace(current, snapshot, target, delta, layoutSize),
  );
  return true;
}

export function handleMissionSurfacePointerDown(
  hit: MissionWorkspaceHit,
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  const { snapshot, layoutSize } = state;
  if (hit?.kind === "refresh") {
    actions.refresh();
    return true;
  }
  if (hit?.kind === "deep-link") {
    actions.followDeepLink(hit.link);
    return true;
  }
  if (hit?.kind === "detail-section" && snapshot) {
    actions.updateModel((model) =>
      setMissionDetailSection(model, snapshot, hit.section, layoutSize),
    );
    return true;
  }
  if (hit && snapshot) {
    actions.updateModel((model) => applyMissionWorkspaceHit(model, snapshot, hit, layoutSize));
    if (hit.kind === "card" || hit.kind === "history") {
      actions.updateModel((model) => openMissionDetail(model, snapshot, layoutSize));
      actions.refresh();
    }
    return true;
  }
  return false;
}
