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
  type MissionRepositorySnapshot,
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
export {
  classifyProjectReadiness,
  type AuthenticationReadiness,
  type Availability,
  type CommandReadiness,
  type ConfigFreeLaunchPane,
  type ConfigFreeLaunchPlan,
  type HarnessKind,
  type HarnessReadinessState,
  type ProjectHarnessReadiness,
  type ProjectReadinessGitProbe,
  type ProjectReadinessHarnessProbe,
  type ProjectReadinessIssue,
  type ProjectReadinessIssueCode,
  type ProjectReadinessIssueSeverity,
  type ProjectReadinessPlatformProbe,
  type ProjectReadinessProbe,
  type ProjectReadinessProjectProbe,
  type ProjectReadinessResult,
  type ProjectReadinessToolProbe,
  type ProjectRecoveryAction,
  type ProjectRecoveryActionKind,
  type ProjectRegistrationState,
} from "./lib/project-readiness.ts";
