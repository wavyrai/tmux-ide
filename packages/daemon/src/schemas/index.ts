export {
  PaneSchema,
  RowSchema,
  ThemeConfigSchema,
  OrchestratorYamlConfigSchema,
  IdeConfigSchema,
  PaneActionSchema,
  SessionStateSchema,
} from "./ide-config.ts";

export type {
  Pane,
  Row,
  ThemeConfig,
  OrchestratorYamlConfig,
  IdeConfig,
  PaneAction,
  SessionState,
} from "./ide-config.ts";

export {
  ProofSchemaZ,
  TaskSchemaZ,
  GoalSchemaZ,
  MissionSchemaZ,
  EventTypeSchemaZ,
  OrchestratorEventSchemaZ,
  MarkRangeSchemaZ,
  MarkSchemaZ,
  AuthorshipStatsSchemaZ,
  PlanStatusSchemaZ,
  PlanMetaSchemaZ,
  AgentDetailSchemaZ,
  SessionOverviewSchemaZ,
  ProjectDetailSchemaZ,
  SessionStatsSchemaZ,
  PaneInfoSchemaZ,
  StructuredEventSchemaZ,
} from "./domain.ts";

export type {
  ProofSchema,
  Mission,
  Goal,
  Task,
  EventType,
  Mark,
  MarkRange,
  AuthorshipStats,
  AgentDetail,
  SessionOverview,
  ProjectDetail,
} from "./domain.ts";

export { ClientFrameSchemaZ, ServerFrameSchemaZ, SessionSnapshotSchemaZ } from "./ws-events.ts";

export type { ClientFrame, ServerFrame, SessionSnapshot } from "./ws-events.ts";

export {
  RegisteredProjectSchemaZ,
  RegisterProjectRequestSchemaZ,
  InitProjectRequestSchemaZ,
  ProjectTemplateSchemaZ,
} from "./registry.ts";

export type {
  RegisteredProject,
  RegisterProjectRequest,
  InitProjectRequest,
  ProjectTemplate,
} from "./registry.ts";

export { FilesystemEntrySchemaZ, FilesystemBrowseResultSchemaZ } from "./filesystem.ts";

export type { FilesystemEntry, FilesystemBrowseResult } from "./filesystem.ts";

export {
  ProjectInspectDetectedSchemaZ,
  ProjectInspectSchemaZ,
  InspectFilesystemRequestSchemaZ,
  OnboardProjectRequestSchemaZ,
} from "./inspect.ts";

export type {
  ProjectInspectDetected,
  ProjectInspect,
  InspectFilesystemRequest,
  OnboardProjectRequest,
} from "./inspect.ts";
