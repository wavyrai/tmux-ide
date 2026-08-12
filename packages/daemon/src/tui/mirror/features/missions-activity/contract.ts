import type { WorkspaceMissionsEnvelopeV1 } from "@tmux-ide/contracts";

import type { AgentRowInput } from "../../agent-rows.ts";
import type { ActivitySurfaceProjection } from "../../activity-surface.ts";
import type { MissionDashboardProjection } from "../../missions-dashboard.ts";
import type {
  MissionDeepLinkIntent,
  MissionDeepLinkKind,
  MissionDeepLinkResolution,
  MissionWorkspaceLoadState,
  MissionWorkspaceMode,
  MissionWorkspaceModel,
  MissionWorkspaceSnapshot,
} from "../../missions-workspace.ts";
import type { HostedPanelView } from "../../panel-host.ts";
import type {
  WorkspaceActivitySurfaceState,
  WorkspaceMissionsViewState,
} from "../../workspace-ui-state.ts";

export interface MissionsActivityIdentity {
  readonly workspaceName: string;
  readonly directory: string;
  readonly projectRoot: string;
  readonly identityKey: string;
}

export function missionsActivityIdentityScope(identity: MissionsActivityIdentity): string {
  return `${identity.workspaceName}\u0000${identity.directory}\u0000${identity.identityKey}`;
}

export interface MissionsActivityInteractionInput {
  readonly operationId: string;
  readonly sequence: number;
  readonly at: string;
  readonly source: string;
  readonly message: string;
  readonly detail: string;
  readonly phase: "requested" | "accepted" | "completed" | "rejected" | "timed-out";
}

export type MissionsActivityHoverTarget =
  | { readonly kind: "mission-mode"; readonly index: number }
  | { readonly kind: "mission-button"; readonly index: number }
  | { readonly kind: "mission-card"; readonly index: number }
  | { readonly kind: "mission-history"; readonly index: number };

export interface MissionsActivityKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface MissionsActivityFeatureHost {
  readonly width: () => number;
  readonly height: () => number;
  readonly hover: () => MissionsActivityHoverTarget | null;
  readonly agents: () => readonly AgentRowInput[];
  readonly interactions: () => readonly MissionsActivityInteractionInput[];
  readonly refresh: () => void;
  readonly setStatusNote: (message: string) => void;
  readonly persistMissions: (state: WorkspaceMissionsViewState) => void;
  readonly persistActivity: (state: WorkspaceActivitySurfaceState) => void;
  readonly deepLinkContext: () => {
    readonly projectRoot: string;
    readonly views: readonly HostedPanelView[];
    readonly resolveProjectPath: (projectRoot: string, path: string | null) => string | null;
  };
  readonly executeDeepLink: (intent: MissionDeepLinkIntent) => void;
}

export interface MissionsActivityFeatureSession {
  readonly missionProjection: () => MissionDashboardProjection;
  readonly activityProjection: () => ActivitySurfaceProjection;
  readonly missionModel: () => MissionWorkspaceModel;
  readonly missionSnapshot: () => MissionWorkspaceSnapshot | null;
  readonly missionLoadState: () => MissionWorkspaceLoadState;
  readonly missionMode: () => MissionWorkspaceMode;
  readonly missionErrorMessage: () => string;
  readonly resolveDeepLink: (kind: MissionDeepLinkKind) => MissionDeepLinkResolution;
  readonly setWorkspaceIdentity: (identity: MissionsActivityIdentity) => void;
  readonly applyCatalog: (
    generation: number,
    identityScope: string,
    envelope: WorkspaceMissionsEnvelopeV1,
  ) => void;
  readonly reset: (generation: number) => void;
  readonly hydrateMissions: (state: WorkspaceMissionsViewState) => void;
  readonly hydrateActivity: (state: WorkspaceActivitySurfaceState) => void;
  readonly missionsState: () => WorkspaceMissionsViewState;
  readonly activityState: () => WorkspaceActivitySurfaceState;
  readonly handleMissionKey: (event: MissionsActivityKeyEvent) => boolean;
  readonly handleMissionPointer: (x: number, y: number) => boolean;
  readonly handleMissionScroll: (
    x: number,
    y: number,
    direction: "up" | "down",
    step: number,
  ) => boolean;
  readonly missionHoverAt: (x: number, y: number) => MissionsActivityHoverTarget | null;
  readonly handleActivityKey: (event: MissionsActivityKeyEvent) => boolean;
  readonly handleActivityPointer: (x: number, y: number) => boolean;
  readonly handleActivityScroll: (direction: "up" | "down", step: number) => boolean;
  readonly dispose: () => void;
}
