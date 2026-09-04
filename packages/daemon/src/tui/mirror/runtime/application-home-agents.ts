import type { AgentActivity, ApplicationShellResourceV2 } from "@tmux-ide/contracts";

import type { ApplicationHomeCatalogSession } from "./application-home-catalog.ts";
import { terminalAgentStatusLabel } from "./application-terminal-workspace-policy.ts";

export interface HomeAgentRow {
  readonly key: string;
  readonly sessionKey: string;
  readonly sessionName: string;
  readonly liveSessionId: string;
  readonly daemonInstanceId: string;
  readonly agentId: string;
  readonly paneId: string | null;
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

/** The authenticated shell supplies semantic identities; names never identify a row. */
export function projectHomeAgentRows(
  session: ApplicationHomeCatalogSession,
  shell: ApplicationShellResourceV2,
): HomeAgentRow[] {
  return shell.resource.workspace.sidebar.agents.map((agent) => ({
    key: `${session.id}\u0000${agent.id}`,
    sessionKey: session.id,
    sessionName: session.name,
    // Older catalog fixtures/callers retain a generation-qualified incarnation
    // key even when they do not expose the separately named wire field.
    liveSessionId: session.liveSessionId ?? session.id,
    daemonInstanceId: shell.daemon.instanceId,
    agentId: agent.id,
    paneId: agent.paneId,
    name: agent.name,
    harness: agent.harness,
    activity: agent.activity,
    attention: agent.attention,
    projectName: shell.resource.project.name,
  }));
}
