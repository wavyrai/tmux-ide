export {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./embed.ts";
export {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
} from "./canonical.ts";
export type { CanonicalDaemonInfo } from "./canonical.ts";
export {
  MissionRepository,
  MissionRepositoryError,
  applyMissionEvent,
  replayMissionEvents,
  type MissionAttempt,
  type MissionHistoryEntry,
  type MissionProjectState,
  type MissionSnapshot,
  type MissionTask,
} from "./lib/mission-repository.ts";
export {
  MissionProjectionError,
  missionStatusToBoardColumn,
  projectMissionBoard,
  projectMissionDetail,
  projectMissionHistory,
  projectMissionTimeline,
  taskStatusToBoardColumn,
  type MissionProjectionErrorCode,
  type MissionProjectionOptions,
} from "./lib/mission-projections.ts";
