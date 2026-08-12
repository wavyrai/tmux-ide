import { createRoot, createSignal } from "solid-js";

import type { WorkspaceMissionsEnvelopeV1 } from "@tmux-ide/contracts";

import { agentAgeLabel, agentDisplayKind } from "../../agent-rows.ts";
import {
  activityOrderSequence,
  activityRowHitTest,
  orderActivityRows,
  projectActivitySurface,
  type ActivityRowDto,
} from "../../activity-surface.ts";
import {
  missionDashboardHitTest,
  missionDashboardMainSize,
  missionDashboardProjection,
} from "../../missions-dashboard.ts";
import {
  handleMissionSurfaceKey,
  handleMissionSurfacePointerDown,
  handleMissionSurfaceScroll,
} from "../../missions-surface-controller.ts";
import {
  defaultMissionWorkspaceModel,
  invalidatedMissionWorkspaceLoadState,
  reconcileMissionWorkspaceModel,
  resolveMissionDeepLink,
  type MissionWorkspaceModel,
  type MissionWorkspaceHit,
  type MissionWorkspaceSnapshot,
} from "../../missions-workspace.ts";
import type {
  WorkspaceActivitySurfaceState,
  WorkspaceMissionsNavigationState,
  WorkspaceMissionsViewState,
} from "../../workspace-ui-state.ts";
import type {
  MissionsActivityFeatureHost,
  MissionsActivityFeatureSession,
  MissionsActivityHoverTarget,
  MissionsActivityIdentity,
} from "./contract.ts";
import { missionsActivityIdentityScope } from "./contract.ts";

type MissionActivityResource = Extract<
  WorkspaceMissionsEnvelopeV1["resource"]["missionWorkspace"],
  { status: "ready" | "empty" }
>["activity"][number];

export function missionHoverTarget(
  hit: MissionWorkspaceHit,
  projection: ReturnType<typeof missionDashboardProjection>,
): MissionsActivityHoverTarget | null {
  if (hit?.kind === "mode") return { kind: "mission-mode", index: hit.mode === "board" ? 0 : 1 };
  if (hit?.kind === "card") return { kind: "mission-card", index: hit.hoverKey };
  if (hit?.kind === "history" || hit?.kind === "detail-row")
    return { kind: "mission-history", index: hit.hoverKey };
  if (hit?.kind === "refresh") return { kind: "mission-button", index: 0 };
  if (hit?.kind === "density") return { kind: "mission-button", index: 1 };
  if (hit?.kind === "horizontal")
    return { kind: "mission-button", index: hit.direction < 0 ? 2 : 3 };
  if (hit?.kind === "collapse") return { kind: "mission-button", index: 4 };
  if (hit?.kind === "zoom") return { kind: "mission-button", index: 5 };
  if (hit?.kind === "detail-section") {
    const index = projection.main.layout.detail.sections.findIndex(
      (chip) => chip.section === hit.section,
    );
    return index < 0 ? null : { kind: "mission-button", index: 10 + index };
  }
  if (hit?.kind === "deep-link") {
    const index = projection.main.layout.detail.links.findIndex((chip) => chip.link === hit.link);
    return index < 0 ? null : { kind: "mission-button", index: 20 + index };
  }
  return null;
}

const navigationFromModel = (model: MissionWorkspaceModel): WorkspaceMissionsNavigationState => ({
  mode: model.mode,
  density: model.density,
  selectedColumn: model.selectedColumn,
  preferredRow: model.preferredRow,
  columnScroll: { ...model.columnScroll },
  historyScroll: model.historyScroll,
  horizontalOffset: model.horizontalOffset,
  detailReturnMode: model.detailReturnMode,
  detailSection: model.detailSection,
  detailScroll: { ...model.detailScroll },
  collapsedColumns: { ...model.collapsedColumns },
  zoomColumn: model.zoomColumn,
  zoomRestoreHorizontalOffset: model.zoomRestoreHorizontalOffset,
});

const modelFromState = (state: WorkspaceMissionsViewState): MissionWorkspaceModel => {
  const base = defaultMissionWorkspaceModel();
  return {
    ...base,
    ...(state.navigation ?? {}),
    selectedMissionId: state.selectedMissionId,
    selectedTaskId: state.selectedTaskId,
  };
};

export function createMissionsActivityFeatureSession(
  host: MissionsActivityFeatureHost,
  initialIdentity: MissionsActivityIdentity,
  initialGeneration: number,
): MissionsActivityFeatureSession {
  return createRoot((disposeOwner) => {
    const [identity, setIdentity] = createSignal(initialIdentity);
    const [generation, setGeneration] = createSignal(initialGeneration);
    const [missionLoadState, setMissionLoadState] = createSignal(
      invalidatedMissionWorkspaceLoadState(),
    );
    const [missionSnapshot, setMissionSnapshot] = createSignal<MissionWorkspaceSnapshot | null>(
      null,
    );
    const [missionModel, setMissionModel] = createSignal(defaultMissionWorkspaceModel());
    const [missionActivity, setMissionActivity] = createSignal<readonly MissionActivityResource[]>(
      [],
    );
    const [activitySelectedId, setActivitySelectedId] = createSignal<string | null>(null);
    const [activityScrollOffset, setActivityScrollOffset] = createSignal(0);
    let disposed = false;

    const missionLayoutSize = () => {
      const size = missionDashboardMainSize(host.width(), Math.max(1, host.height()));
      return { width: size.mainWidth, height: size.height };
    };
    const missionsState = (): WorkspaceMissionsViewState => ({
      panel: "missions",
      selectedMissionId: missionModel().selectedMissionId,
      selectedTaskId: missionModel().selectedTaskId,
      navigation: navigationFromModel(missionModel()),
    });
    const activityState = (): WorkspaceActivitySurfaceState => ({
      selectedRowId: activitySelectedId(),
      scrollOffset: activityScrollOffset(),
    });
    const persistMissionModel = () => {
      if (!disposed) host.persistMissions(missionsState());
    };
    const updateMissionModel = (
      updater: (model: MissionWorkspaceModel) => MissionWorkspaceModel,
    ) => {
      setMissionModel((current) => {
        const updated = updater(current);
        const next =
          updated.mode !== "detail" && updated.selectedMissionId !== current.selectedMissionId
            ? { ...updated, selectedTaskId: null }
            : updated;
        if (next !== current) queueMicrotask(persistMissionModel);
        return next;
      });
    };
    const resolveDeepLink = (kind: "terminal" | "files" | "diff") =>
      resolveMissionDeepLink(
        kind,
        missionSnapshot()?.detail ?? null,
        missionModel(),
        host.deepLinkContext(),
      );
    const followDeepLink = (kind: "terminal" | "files" | "diff") => {
      const resolved = resolveDeepLink(kind);
      if (!resolved.available) host.setStatusNote(resolved.reason);
      else host.executeDeepLink(resolved.intent);
    };
    const controllerState = () => ({
      model: missionModel(),
      snapshot: missionSnapshot(),
      layoutSize: missionLayoutSize(),
      persistedTaskId: missionModel().selectedTaskId,
    });
    const controllerActions = () => ({
      updateModel: updateMissionModel,
      refresh: () => {
        host.setStatusNote("refreshing missions…");
        host.refresh();
      },
      followDeepLink,
      persistSelection: (missionId: string | null, taskId: string | null) => {
        setMissionModel((current) => ({
          ...current,
          selectedMissionId: missionId,
          selectedTaskId: taskId,
        }));
        queueMicrotask(persistMissionModel);
      },
    });
    const missionErrorMessage = () => {
      const state = missionLoadState();
      return state.status === "error" ? state.message : "";
    };
    const missionProjection = () =>
      missionDashboardProjection(
        host.width(),
        Math.max(1, host.height()),
        missionModel(),
        missionSnapshot(),
        {
          loadStatus: missionLoadState().status,
          projectLabel: identity().projectRoot,
          errorMessage: missionErrorMessage(),
          quitHint: "^q quit",
          agents: host.agents(),
        },
      );

    const activityRows = (): ActivityRowDto[] => {
      const agentRows: ActivityRowDto[] = host.agents().map((agent, index) => ({
        kind: "agent",
        id: `agent:${agent.paneId}`,
        sequence: activityOrderSequence(agent.since, index + 1),
        timestampText: agent.since
          ? (agentAgeLabel(agent.state, agent.since, Math.floor(Date.now() / 1000)) ?? "now")
          : "now",
        agent: agentDisplayKind(agent),
        message: agent.statusText ?? agent.state,
        detail: `${agent.session} · ${agent.paneId}`,
        status: agent.state,
        attention: agent.state === "blocked",
      }));
      const missionRows: ActivityRowDto[] = missionActivity().map((event) => ({
        kind: "event",
        id: `mission:${event.id}`,
        sequence: activityOrderSequence(event.timestamp, event.sequence),
        timestampText: event.timestamp.slice(11, 16),
        source: event.actor.label,
        message: event.label,
        detail: event.reason ?? event.type,
        status: event.type.includes("fail") || event.type.includes("block") ? "blocked" : "done",
        attention: event.type.includes("fail") || event.type.includes("block"),
      }));
      const interactionRows: ActivityRowDto[] = host.interactions().map((event) => ({
        kind: "event",
        id: `interaction:${event.operationId}`,
        sequence: activityOrderSequence(event.at, event.sequence),
        timestampText: event.at.slice(11, 16),
        source: event.source,
        message: event.message,
        detail: event.detail,
        status:
          event.phase === "rejected" || event.phase === "timed-out"
            ? "blocked"
            : event.phase === "accepted"
              ? "working"
              : "done",
        attention: event.phase === "rejected" || event.phase === "timed-out",
      }));
      return [...agentRows, ...missionRows, ...interactionRows];
    };
    const activityProjection = () => {
      const rows = activityRows();
      const load = missionLoadState();
      return projectActivitySurface({
        width: host.width(),
        height: host.height(),
        state:
          rows.length > 0
            ? "ready"
            : load.status === "loading"
              ? "loading"
              : load.status === "error"
                ? "error"
                : "empty",
        rows,
        selectedRowId: activitySelectedId(),
        scrollOffset: activityScrollOffset(),
        message: load.status === "error" ? load.message : undefined,
      });
    };

    const setWorkspaceIdentity = (next: MissionsActivityIdentity) => {
      setIdentity(next);
      setMissionSnapshot(null);
      setMissionActivity([]);
      setMissionLoadState(invalidatedMissionWorkspaceLoadState());
      setMissionModel(defaultMissionWorkspaceModel());
      setActivitySelectedId(null);
      setActivityScrollOffset(0);
    };
    const reset = (nextGeneration: number) => {
      setGeneration(nextGeneration);
      setMissionSnapshot(null);
      setMissionActivity([]);
      setMissionLoadState(invalidatedMissionWorkspaceLoadState());
    };
    const applyCatalog = (
      nextGeneration: number,
      identityScope: string,
      envelope: WorkspaceMissionsEnvelopeV1,
    ) => {
      if (
        disposed ||
        nextGeneration !== generation() ||
        identityScope !== missionsActivityIdentityScope(identity()) ||
        envelope.resource.workspaceName !== identity().workspaceName
      )
        return;
      const resource = envelope.resource.missionWorkspace;
      if (resource.status === "degraded") {
        setMissionSnapshot(null);
        setMissionActivity([]);
        setMissionLoadState({
          status: "error",
          generation: nextGeneration,
          projectKey: identity().identityKey,
          message: resource.reason,
        });
        return;
      }
      const emptyColumns = { planned: [], running: [], blocked: [], review: [], done: [] };
      const cards = resource.missions.map((mission) => ({
        version: 1 as const,
        id: mission.id,
        title: mission.title,
        summary: mission.summary,
        status: mission.status,
        column: mission.column,
        labels: [],
        createdAt: mission.startedAt ?? mission.updatedAt,
        updatedAt: mission.updatedAt,
        ...(mission.startedAt ? { startedAt: mission.startedAt } : {}),
        ...(mission.finishedAt ? { finishedAt: mission.finishedAt } : {}),
        durationMs: mission.durationMs,
        progress: mission.progress,
        blockedBy: [],
        latestAttempt: null,
        proofSummary: {
          proofIds: [],
          hasProof: mission.proof.hasProof,
          noProofReasons: mission.proof.noProofReasons,
          notesCount: mission.proof.notesCount,
          tests: mission.proof.tests,
          commits: [],
          diff: {
            summaries: [],
            urls: [],
            filesChanged: mission.proof.filesChanged,
            insertions: mission.proof.insertions,
            deletions: mission.proof.deletions,
          },
          prs: [],
          artifacts: [],
        },
        refs: { missionId: mission.id, taskIds: [], attemptIds: [], proofIds: [] },
      }));
      const columns = { ...emptyColumns } as Record<(typeof cards)[number]["column"], typeof cards>;
      for (const card of cards) columns[card.column].push(card);
      const snapshot: MissionWorkspaceSnapshot = {
        board: {
          version: 1,
          columns,
          counts: {
            planned: columns.planned.length,
            running: columns.running.length,
            blocked: columns.blocked.length,
            review: columns.review.length,
            done: columns.done.length,
            total: cards.length,
          },
        },
        history: [],
        detail: null,
        project: { identityKey: identity().identityKey, projectRoot: identity().projectRoot },
        loadedAt: new Date().toISOString(),
      };
      setMissionSnapshot(snapshot);
      setMissionActivity(resource.activity);
      setMissionLoadState({
        status: cards.length === 0 ? "empty" : "ready",
        generation: nextGeneration,
        snapshot,
      });
      setMissionModel((current) =>
        reconcileMissionWorkspaceModel(current, snapshot, {
          persistedMissionId: current.selectedMissionId,
          persistedTaskId: current.selectedTaskId,
          ...missionLayoutSize(),
        }),
      );
    };
    const hydrateMissions = (state: WorkspaceMissionsViewState) => {
      setMissionModel(() =>
        reconcileMissionWorkspaceModel(modelFromState(state), missionSnapshot(), {
          persistedMissionId: state.selectedMissionId,
          persistedTaskId: state.selectedTaskId,
          ...missionLayoutSize(),
        }),
      );
    };
    const hydrateActivity = (state: WorkspaceActivitySurfaceState) => {
      setActivitySelectedId(state.selectedRowId);
      setActivityScrollOffset(state.scrollOffset);
    };
    const handleActivityKey = (event: { name: string }) => {
      if (!["j", "k", "up", "down"].includes(event.name)) return false;
      const rows = orderActivityRows(activityRows());
      if (rows.length === 0) return true;
      const current = rows.findIndex((row) => row.id === activitySelectedId());
      const delta = event.name === "j" || event.name === "down" ? 1 : -1;
      const next =
        current < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, current + delta));
      setActivitySelectedId(rows[next]!.id);
      host.persistActivity(activityState());
      return true;
    };

    return {
      missionProjection,
      activityProjection,
      missionModel,
      missionSnapshot,
      missionLoadState,
      missionMode: () => missionModel().mode,
      missionErrorMessage,
      resolveDeepLink,
      setWorkspaceIdentity,
      applyCatalog,
      reset,
      hydrateMissions,
      hydrateActivity,
      missionsState,
      activityState,
      handleMissionKey: (event) =>
        handleMissionSurfaceKey(event, controllerState(), controllerActions()),
      handleMissionPointer: (x, y) =>
        handleMissionSurfacePointerDown(
          missionDashboardHitTest(missionProjection(), x, y),
          controllerState(),
          controllerActions(),
        ),
      handleMissionScroll: (x, y, direction, step) =>
        handleMissionSurfaceScroll(
          missionDashboardHitTest(missionProjection(), x, y),
          direction,
          controllerState(),
          { updateModel: updateMissionModel },
          step,
        ),
      missionHoverAt: (x, y): MissionsActivityHoverTarget | null => {
        const hit = missionDashboardHitTest(missionProjection(), x, y);
        return missionHoverTarget(hit, missionProjection());
      },
      handleActivityKey,
      handleActivityPointer: (x, y) => {
        const hit = activityRowHitTest(activityProjection(), x, y);
        if (hit) setActivitySelectedId(hit.rowId);
        host.persistActivity(activityState());
        return true;
      },
      handleActivityScroll: (direction, step) => {
        const delta = direction === "up" ? -step : step;
        setActivityScrollOffset((offset) =>
          Math.max(0, Math.min(activityProjection().maximumScrollOffset, offset + delta)),
        );
        host.persistActivity(activityState());
        return true;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        disposeOwner();
      },
    };
  });
}
