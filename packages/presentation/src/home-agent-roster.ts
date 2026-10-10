import type { PaneTeamMembership } from "@tmux-ide/contracts";
import type { NativePaneIdentity } from "@tmux-ide/contracts";
import type {
  AgentActivity,
  InteractionPaneEndpoint,
  ApplicationShellResourceV2,
  TmuxServerScope,
} from "@tmux-ide/contracts";

/** Structural catalog input; observation and transport remain with each host. */
export interface HomeAgentCatalogSession {
  readonly id: string;
  readonly server?: TmuxServerScope;
  readonly serverLabel?: string;
  readonly liveSessionId?: string;
  readonly workspaceName?: string;
  readonly name: string;
  readonly paneCount?: number;
}

export function terminalAgentStatusLabel(activity: AgentActivity): string {
  switch (activity) {
    case "running":
      return "WORKING";
    case "waiting":
      return "BLOCKED";
    case "complete":
      return "DONE";
    case "failed":
      return "FAILED";
    case "disconnected":
      return "DISCONNECTED";
    case "idle":
      return "IDLE";
  }
}

export interface HomeAgentRow {
  readonly team?: PaneTeamMembership;
  readonly nativeIdentity: NativePaneIdentity | null;
  readonly interactionEndpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null;
  readonly key: string;
  readonly machineId?: string;
  readonly machineLabel?: string;
  readonly server?: TmuxServerScope;
  readonly serverLabel?: string;
  readonly disabled?: boolean;
  readonly sessionKey: string;
  readonly sessionName: string;
  readonly liveSessionId: string;
  readonly daemonInstanceId: string;
  readonly agentId: string;
  readonly paneId: string | null;
  /** Durable window grouping from authenticated terminal inventory, when available. */
  readonly windowId?: string | null;
  readonly name: string;
  readonly harness: string;
  readonly activity: AgentActivity;
  readonly attention: boolean;
  readonly projectName: string;
}

export interface HomeAgentSnapshot {
  readonly phase: "loading" | "live" | "partial" | "unavailable";
  readonly rows: readonly HomeAgentRow[];
  readonly observedSessions: number;
  readonly totalSessions: number;
  readonly loadingSessions: number;
  readonly unavailableSessions: number;
  readonly truncatedSessions: number;
  readonly refreshingSessionKeys: readonly string[];
  readonly unavailableSessionKeys: readonly string[];
  readonly note: string | null;
}

export const homeAgentStatusLabel = terminalAgentStatusLabel;

/** Keep state priority separate from stable selection identity. */
export function sortHomeAgentRows(rows: readonly HomeAgentRow[]): HomeAgentRow[] {
  const rank = (row: HomeAgentRow) =>
    row.attention || row.activity === "waiting" || row.activity === "failed"
      ? 0
      : row.activity === "running"
        ? 1
        : 2;
  return [...rows].sort(
    (left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key),
  );
}

/** Hosts supply authenticated resource data and the identity used by the fallback. */
export type HomeAgentShell = Pick<ApplicationShellResourceV2, "resource"> & {
  readonly daemon: Pick<ApplicationShellResourceV2["daemon"], "instanceId">;
};

/** The authenticated shell supplies semantic identities; names never identify a row. */
export function projectHomeAgentRows(
  session: HomeAgentCatalogSession,
  shell: HomeAgentShell,
): HomeAgentRow[] {
  return shell.resource.workspace.sidebar.agents.map((agent) => ({
    key: `${session.id}\u0000${agent.id}`,
    sessionKey: session.id,
    server: session.server,
    serverLabel: session.serverLabel,
    sessionName: session.name,
    // Older catalog fixtures/callers retain a generation-qualified incarnation
    // key even when they do not expose the separately named wire field.
    liveSessionId: session.liveSessionId ?? session.id,
    daemonInstanceId: session.server?.generation ?? shell.daemon.instanceId,
    agentId: agent.id,
    paneId: agent.paneId,
    nativeIdentity:
      shell.resource.terminalInventory?.resources.find(
        (resource) =>
          resource.attachability.status === "available" &&
          resource.attachability.semanticPaneId === agent.paneId,
      )?.nativeIdentity ?? null,
    interactionEndpoint:
      shell.resource.terminalInventory?.resources.find(
        (resource) =>
          resource.attachability.status === "available" &&
          resource.attachability.semanticPaneId === agent.paneId,
      )?.interactionEndpoint ?? null,
    windowId:
      shell.resource.terminalInventory?.resources.find(
        (resource) =>
          resource.attachability.status === "available" &&
          resource.attachability.semanticPaneId === agent.paneId,
      )?.windowResourceId ?? null,
    name: agent.name,
    ...(agent.team ? { team: agent.team } : {}),
    harness: agent.harness,
    activity: agent.activity,
    attention: agent.attention,
    projectName: shell.resource.project.name,
  }));
}
