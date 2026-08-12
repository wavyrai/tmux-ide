import {
  MissionProjectionError,
  projectMissionBoard,
  projectMissionDetail,
  projectMissionHistory,
} from "../../../lib/mission-projections.ts";
import { MissionRepository, MissionRepositoryError } from "../../../lib/mission-repository.ts";
import type { ProjectRuntimeRepository } from "../../../lib/project-runtime-repository.ts";
import type { MissionWorkspaceLoadState, MissionWorkspaceSnapshot } from "../missions-workspace.ts";

/**
 * Compatibility loader for the legacy filesystem-backed Missions runtime.
 *
 * New presentation and controller code must consume daemon resource
 * envelopes instead. Keeping this adapter behind an explicit legacy import
 * prevents MissionRepository and filesystem state from entering the TUI's
 * eager presentation graph.
 */
export class MissionWorkspaceLoader {
  #generation = 0;
  #activeProjectKey: string | null = null;

  begin(
    projectKey: string | null,
    priorSnapshot?: MissionWorkspaceSnapshot | null,
  ): MissionWorkspaceLoadState {
    this.#generation += 1;
    this.#activeProjectKey = projectKey;
    if (projectKey && priorSnapshot?.project.identityKey === projectKey) {
      return {
        status: "refreshing",
        generation: this.#generation,
        projectKey,
        snapshot: priorSnapshot,
      };
    }
    return { status: "loading", generation: this.#generation, projectKey };
  }

  cancel(): void {
    this.#generation += 1;
    this.#activeProjectKey = null;
  }

  accept(
    generation: number,
    projectKey: string,
    snapshot: MissionWorkspaceSnapshot,
  ): MissionWorkspaceLoadState | null {
    if (generation !== this.#generation || projectKey !== this.#activeProjectKey) return null;
    const status =
      snapshot.board.counts.total === 0 && snapshot.history.length === 0 ? "empty" : "ready";
    return { status, generation, snapshot };
  }

  reject(
    generation: number,
    projectKey: string | null,
    error: unknown,
  ): MissionWorkspaceLoadState | null {
    if (generation !== this.#generation || projectKey !== this.#activeProjectKey) return null;
    return { status: "error", generation, projectKey, message: missionErrorMessage(error) };
  }

  isCurrent(generation: number, projectKey: string | null): boolean {
    return generation === this.#generation && projectKey === this.#activeProjectKey;
  }
}

export function readMissionWorkspace(
  repository: ProjectRuntimeRepository,
  selectedMissionId: string | null = null,
  now: () => Date = () => new Date(),
): MissionWorkspaceSnapshot {
  const missions = new MissionRepository(repository);
  const { history, state } = missions.snapshot();
  const board = projectMissionBoard(state, history);
  const completed = projectMissionHistory(state, history);
  const detail = selectedMissionId ? projectDetailOrNull(state, history, selectedMissionId) : null;
  return {
    board,
    history: completed.map((entry) => detached(entry)),
    detail: detail ? detached(detail) : null,
    project: {
      identityKey: repository.metadata.identityKey,
      projectRoot: repository.metadata.projectRoot,
    },
    loadedAt: now().toISOString(),
  };
}

function missionErrorMessage(error: unknown): string {
  if (error instanceof MissionRepositoryError || error instanceof MissionProjectionError) {
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "mission data could not be loaded";
}

function projectDetailOrNull(
  state: Parameters<typeof projectMissionDetail>[0],
  history: Parameters<typeof projectMissionDetail>[1],
  missionId: string,
) {
  try {
    return projectMissionDetail(state, history, missionId);
  } catch (error) {
    if (error instanceof MissionProjectionError && error.projectionCode === "MISSION_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
