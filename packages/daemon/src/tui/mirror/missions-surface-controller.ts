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
  type MissionDetailSection,
  type MissionWorkspaceMode,
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

export type MissionSurfaceCommandRole =
  | "refresh"
  | "layout"
  | "navigate"
  | "open"
  | "close"
  | "link";

export type MissionSurfaceCommandPayload =
  | { type: "refresh" }
  | { type: "follow-deep-link"; kind: MissionDeepLinkKind }
  | { type: "cycle-density" }
  | { type: "toggle-collapse" }
  | { type: "toggle-zoom" }
  | { type: "close-detail" }
  | { type: "cycle-detail-section"; direction: -1 | 1 }
  | { type: "set-detail-section"; section: MissionDetailSection }
  | { type: "set-mode"; mode: MissionWorkspaceMode }
  | { type: "move-selection"; movement: "left" | "right" | "up" | "down" | "home" | "end" }
  | {
      type: "open-detail";
      persist: boolean;
      selectedMissionId: string | null;
      selectedTaskId: string | null;
    }
  | { type: "select-hit"; hit: Exclude<MissionWorkspaceHit, { kind: "refresh" } | null> }
  | { type: "scroll"; hit: MissionWorkspaceHit; direction: "up" | "down"; step: number };

export interface MissionSurfaceCommandDescriptor {
  id: string;
  label: string;
  role: MissionSurfaceCommandRole;
  disabled: boolean;
  disabledReason?: string;
  payload: MissionSurfaceCommandPayload;
  metadata: {
    source: "keyboard" | "mouse" | "wheel" | "program";
    target?: string;
  };
}

export function handleMissionSurfaceKey(
  event: MissionSurfaceKeyEvent,
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  return executeMissionSurfaceCommands(missionSurfaceCommandsForKey(event, state), state, actions);
}

export function handleMissionSurfaceScroll(
  hit: MissionWorkspaceHit,
  direction: "up" | "down",
  state: MissionSurfaceControllerState,
  actions: Pick<MissionSurfaceControllerActions, "updateModel">,
  step: number,
): boolean {
  return executeMissionSurfaceCommand(
    missionSurfaceCommand(
      "mission.scroll",
      "Scroll missions",
      "navigate",
      state,
      {
        type: "scroll",
        hit,
        direction,
        step,
      },
      "wheel",
    ),
    state,
    {
      updateModel: actions.updateModel,
      refresh: () => {},
      followDeepLink: () => {},
      persistSelection: () => {},
    },
  );
}

export function handleMissionSurfacePointerDown(
  hit: MissionWorkspaceHit,
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  const commands = missionSurfaceCommandsForHit(hit, state);
  if (commands.length === 0) return false;
  return executeMissionSurfaceCommands(commands, state, actions);
}

export function missionSurfaceCommandsForKey(
  event: MissionSurfaceKeyEvent,
  state: MissionSurfaceControllerState,
): MissionSurfaceCommandDescriptor[] {
  if (event.name === "r")
    return [
      missionSurfaceCommand("mission.refresh", "Refresh missions", "refresh", state, {
        type: "refresh",
      }),
    ];
  const link =
    event.name === "t"
      ? "terminal"
      : event.name === "f"
        ? "files"
        : event.name === "d"
          ? "diff"
          : null;
  if (link)
    return [
      missionSurfaceCommand(`mission.link.${link}`, `Open ${link}`, "link", state, {
        type: "follow-deep-link",
        kind: link,
      }),
    ];
  if (event.name === "z")
    return [
      missionSurfaceCommand(
        "mission.layout.density.cycle",
        "Cycle mission density",
        "layout",
        state,
        {
          type: "cycle-density",
        },
      ),
    ];
  if (event.name === "c")
    return [
      missionSurfaceCommand(
        "mission.layout.column.collapse.toggle",
        "Toggle lane collapse",
        "layout",
        state,
        {
          type: "toggle-collapse",
        },
      ),
    ];
  if (event.name === "x")
    return [
      missionSurfaceCommand(
        "mission.layout.column.zoom.toggle",
        "Toggle lane zoom",
        "layout",
        state,
        {
          type: "toggle-zoom",
        },
      ),
    ];
  if (state.model.mode === "detail") {
    if (event.name === "escape" || event.name === "backspace")
      return [
        missionSurfaceCommand("mission.detail.close", "Close mission detail", "close", state, {
          type: "close-detail",
        }),
      ];
    if (event.name === "tab")
      return [
        missionSurfaceCommand(
          "mission.detail.section.cycle",
          "Cycle detail section",
          "navigate",
          state,
          {
            type: "cycle-detail-section",
            direction: event.shift ? -1 : 1,
          },
        ),
      ];
    const section =
      event.name === "1"
        ? "tasks"
        : event.name === "2"
          ? "timeline"
          : event.name === "3"
            ? "attempts"
            : event.name === "4"
              ? "proof"
              : null;
    if (section)
      return [
        missionSurfaceCommand(
          `mission.detail.section.${section}`,
          `Show ${section}`,
          "navigate",
          state,
          {
            type: "set-detail-section",
            section,
          },
        ),
      ];
  }
  if (event.name === "tab") {
    const mode = state.model.mode === "board" ? "history" : "board";
    return [
      missionSurfaceCommand(`mission.mode.${mode}`, `Show ${mode}`, "navigate", state, {
        type: "set-mode",
        mode,
      }),
    ];
  }
  if (event.name === "b" || event.name === "y") {
    const mode = event.name === "b" ? "board" : "history";
    return [
      missionSurfaceCommand(`mission.mode.${mode}`, `Show ${mode}`, "navigate", state, {
        type: "set-mode",
        mode,
      }),
    ];
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
  if (movement)
    return [
      missionSurfaceCommand(
        `mission.selection.${movement}`,
        `Move ${movement}`,
        "navigate",
        state,
        {
          type: "move-selection",
          movement,
        },
      ),
    ];
  if (event.name === "return")
    return [
      missionSurfaceCommand("mission.detail.open", "Open mission detail", "open", state, {
        type: "open-detail",
        persist: true,
        selectedMissionId: state.model.selectedMissionId,
        selectedTaskId: state.model.selectedTaskId,
      }),
    ];
  return [];
}

export function missionSurfaceCommandsForHit(
  hit: MissionWorkspaceHit,
  state: MissionSurfaceControllerState,
): MissionSurfaceCommandDescriptor[] {
  if (!hit) return [];
  if (hit.kind === "refresh")
    return [
      missionSurfaceCommand(
        "mission.refresh",
        "Refresh missions",
        "refresh",
        state,
        {
          type: "refresh",
        },
        "mouse",
      ),
    ];
  if (hit.kind === "deep-link")
    return [
      missionSurfaceCommand(
        `mission.link.${hit.link}`,
        `Open ${hit.link}`,
        "link",
        state,
        {
          type: "follow-deep-link",
          kind: hit.link,
        },
        "mouse",
      ),
    ];
  if (hit.kind === "detail-section")
    return [
      missionSurfaceCommand(
        `mission.detail.section.${hit.section}`,
        `Show ${hit.section}`,
        "navigate",
        state,
        {
          type: "set-detail-section",
          section: hit.section,
        },
        "mouse",
      ),
    ];
  const commands = [
    missionSurfaceCommand(
      `mission.select.${hit.kind}`,
      "Select mission target",
      "navigate",
      state,
      {
        type: "select-hit",
        hit,
      },
      "mouse",
    ),
  ];
  if (hit.kind === "card" || hit.kind === "history") {
    commands.push(
      missionSurfaceCommand(
        "mission.detail.open",
        "Open mission detail",
        "open",
        state,
        {
          type: "open-detail",
          persist: false,
          selectedMissionId: hit.missionId,
          selectedTaskId: state.model.selectedTaskId,
        },
        "mouse",
      ),
    );
  }
  return commands;
}

export function executeMissionSurfaceCommands(
  commands: readonly MissionSurfaceCommandDescriptor[],
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  for (const command of commands) executeMissionSurfaceCommand(command, state, actions);
  return true;
}

export function executeMissionSurfaceCommand(
  command: MissionSurfaceCommandDescriptor,
  state: MissionSurfaceControllerState,
  actions: MissionSurfaceControllerActions,
): boolean {
  const { snapshot, layoutSize } = state;
  if (command.disabled) return true;
  const payload = command.payload;
  switch (payload.type) {
    case "refresh":
      actions.refresh();
      return true;
    case "follow-deep-link":
      actions.followDeepLink(payload.kind);
      return true;
    case "cycle-density":
      actions.updateModel((model) => cycleMissionDensity(model, snapshot, layoutSize));
      return true;
    case "toggle-collapse":
      actions.updateModel((model) => toggleMissionColumnCollapse(model, snapshot, layoutSize));
      return true;
    case "toggle-zoom":
      actions.updateModel((model) => toggleMissionColumnZoom(model, snapshot, layoutSize));
      return true;
    case "close-detail":
      actions.updateModel(closeMissionDetail);
      return true;
    case "cycle-detail-section":
      if (!snapshot) return true;
      actions.updateModel((model) =>
        cycleMissionDetailSection(model, snapshot, payload.direction, layoutSize),
      );
      return true;
    case "set-detail-section":
      if (!snapshot) return true;
      actions.updateModel((model) =>
        setMissionDetailSection(model, snapshot, payload.section, layoutSize),
      );
      return true;
    case "set-mode":
      if (!snapshot) return true;
      actions.updateModel((model) =>
        setMissionWorkspaceMode(model, snapshot, payload.mode, layoutSize),
      );
      return true;
    case "move-selection":
      if (!snapshot) return true;
      actions.updateModel((model) =>
        moveMissionSelection(model, snapshot, payload.movement, layoutSize),
      );
      return true;
    case "open-detail": {
      if (!snapshot) return true;
      const selected = payload.selectedMissionId;
      if (payload.persist) {
        actions.persistSelection(selected, payload.selectedTaskId);
      }
      actions.updateModel((model) =>
        openMissionDetail(model, snapshot, {
          persistedTaskId: state.persistedTaskId,
          ...layoutSize,
        }),
      );
      if (selected && snapshot.detail?.mission.id !== selected) actions.refresh();
      return true;
    }
    case "select-hit":
      if (!snapshot) return true;
      actions.updateModel((model) =>
        applyMissionWorkspaceHit(model, snapshot, payload.hit, layoutSize),
      );
      return true;
    case "scroll": {
      if (!snapshot) return true;
      const delta = payload.direction === "up" ? -payload.step : payload.step;
      const hit = payload.hit;
      const target =
        hit?.kind === "detail-row"
          ? hit.section
          : state.model.mode === "detail"
            ? state.model.detailSection
            : hit?.kind === "card" || hit?.kind === "column"
              ? hit.column
              : state.model.mode === "history"
                ? "history"
                : state.model.selectedColumn;
      actions.updateModel((current) =>
        scrollMissionWorkspace(current, snapshot, target, delta, layoutSize),
      );
      return true;
    }
  }
}

function missionSurfaceCommand(
  id: string,
  label: string,
  role: MissionSurfaceCommandRole,
  state: MissionSurfaceControllerState,
  payload: MissionSurfaceCommandPayload,
  source: MissionSurfaceCommandDescriptor["metadata"]["source"] = "keyboard",
): MissionSurfaceCommandDescriptor {
  const disabledReason = missionSurfaceCommandDisabledReason(payload, state);
  return {
    id,
    label,
    role,
    disabled: Boolean(disabledReason),
    disabledReason,
    payload,
    metadata: { source, target: missionSurfaceCommandTarget(payload) },
  };
}

function missionSurfaceCommandDisabledReason(
  payload: MissionSurfaceCommandPayload,
  state: MissionSurfaceControllerState,
): string | undefined {
  if (
    payload.type === "cycle-detail-section" ||
    payload.type === "set-detail-section" ||
    payload.type === "set-mode" ||
    payload.type === "move-selection" ||
    payload.type === "select-hit" ||
    payload.type === "scroll"
  ) {
    if (!state.snapshot) return "mission snapshot is not loaded";
  }
  if (payload.type === "open-detail") {
    if (!state.snapshot) return "mission snapshot is not loaded";
    if (!payload.selectedMissionId && !state.model.selectedMissionId) return "no mission selected";
  }
  return undefined;
}

function missionSurfaceCommandTarget(payload: MissionSurfaceCommandPayload): string | undefined {
  if (payload.type === "follow-deep-link") return payload.kind;
  if (payload.type === "set-detail-section") return payload.section;
  if (payload.type === "set-mode") return payload.mode;
  if (payload.type === "move-selection") return payload.movement;
  if (payload.type === "select-hit") return payload.hit.kind;
  if (payload.type === "scroll") return payload.hit?.kind ?? "current";
  return undefined;
}
