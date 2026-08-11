import type {
  DaemonProjectsResponse,
  DaemonSessionsResponse,
  FleetCatalogResourceV1,
} from "@tmux-ide/contracts";
import { basename } from "node:path";

import type { AgentStatus } from "../../detect/classify.ts";
import type { AgentRowInput } from "../agent-rows.ts";
import type { SessionPaneDescriptor } from "../../../terminal/protocol/session-descriptor-discovery.ts";

export interface TuiFleetSession {
  readonly name: string;
  readonly status: AgentStatus;
  readonly panes: number;
  readonly attached: boolean;
  readonly windows: { index: number; name: string; active: boolean }[];
  readonly agents?: AgentRowInput[];
}

export interface TuiFleetProject {
  readonly name: string;
  readonly dir: string | null;
  readonly registered: boolean;
  readonly running: boolean;
  readonly status: AgentStatus;
  readonly sessions: TuiFleetSession[];
}

function fleetStatus(
  activity: FleetCatalogResourceV1["sessions"][number]["agents"][number]["activity"],
): AgentStatus {
  if (activity === "running") return "working";
  if (activity === "waiting" || activity === "failed") return "blocked";
  if (activity === "complete") return "done";
  if (activity === "idle") return "idle";
  return "unknown";
}

function rollup(statuses: readonly AgentStatus[]): AgentStatus {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("working")) return "working";
  if (statuses.includes("done")) return "done";
  if (statuses.includes("unknown")) return "unknown";
  return "idle";
}

export interface ApplicationShellAgentRowSource {
  readonly paneId: string | null;
  readonly name: string;
  readonly harness: string;
  readonly activity: "running" | "waiting" | "failed" | "complete" | "idle" | "disconnected";
}

/**
 * Join the wire-safe application-shell identity to the daemon-proven local
 * tmux descriptor before exposing a lifecycle target. Semantic/fallback ids
 * are display identities only; kill/restart/close actions require the raw
 * `%pane` id and therefore fail closed when the join is absent or ambiguous.
 */
export function projectAuthoritativeAgentRows(input: {
  readonly workspaceName: string;
  readonly agents: readonly ApplicationShellAgentRowSource[];
  readonly paneDescriptors: readonly SessionPaneDescriptor[];
}): AgentRowInput[] {
  const descriptorsBySemantic = new Map<string, SessionPaneDescriptor[]>();
  for (const descriptor of input.paneDescriptors) {
    if (!descriptor.semanticPaneId || !/^%[0-9]+$/u.test(descriptor.runtimePaneId)) continue;
    const matches = descriptorsBySemantic.get(descriptor.semanticPaneId) ?? [];
    matches.push(descriptor);
    descriptorsBySemantic.set(descriptor.semanticPaneId, matches);
  }
  const stateByActivity: Record<ApplicationShellAgentRowSource["activity"], AgentStatus> = {
    running: "working",
    waiting: "blocked",
    failed: "blocked",
    complete: "done",
    idle: "idle",
    disconnected: "unknown",
  };
  return input.agents.flatMap((agent) => {
    if (!agent.paneId) return [];
    const matches = descriptorsBySemantic.get(agent.paneId) ?? [];
    if (matches.length !== 1) return [];
    const descriptor = matches[0]!;
    return [
      {
        paneId: descriptor.runtimePaneId,
        windowIndex: descriptor.windowIndex ?? 0,
        session: input.workspaceName,
        kind: agent.harness,
        state: stateByActivity[agent.activity],
        since: null,
        displayName: agent.name,
      },
    ];
  });
}

/**
 * Combine action-authoritative REST sessions/projects with the display-only
 * fleet decoration. A fleet label can decorate a matching real session but can
 * never create an attach/rename/kill target by itself.
 */
export function projectTuiFleetResources(input: {
  readonly sessions: DaemonSessionsResponse;
  readonly projects: DaemonProjectsResponse;
  readonly fleet: FleetCatalogResourceV1;
  /** Actionable rows from the open workspace's authenticated application shell. */
  readonly authoritativeAgents?: readonly AgentRowInput[];
}): TuiFleetProject[] {
  const fleetByLabel = new Map(input.fleet.sessions.map((session) => [session.label, session]));
  const registeredByDir = new Map(input.projects.projects.map((project) => [project.dir, project]));
  const result = new Map<string, TuiFleetProject>();
  const agentsBySession = new Map<string, AgentRowInput[]>();
  for (const agent of input.authoritativeAgents ?? []) {
    const agents = agentsBySession.get(agent.session) ?? [];
    agents.push(agent);
    agentsBySession.set(agent.session, agents);
  }

  for (const session of input.sessions.sessions) {
    const registered = registeredByDir.get(session.dir);
    const projectKey = session.dir;
    const decoration = fleetByLabel.get(session.name);
    const status = rollup(decoration?.agents.map((agent) => fleetStatus(agent.activity)) ?? []);
    const previous = result.get(projectKey);
    const fleetSession: TuiFleetSession = {
      // This is the only action target and comes exclusively from /api/sessions.
      name: session.name,
      status,
      panes: decoration?.paneCount ?? 0,
      attached: false,
      windows: [],
      agents: agentsBySession.get(session.name) ?? [],
    };
    if (previous) {
      result.set(projectKey, {
        ...previous,
        status: rollup([...previous.sessions.map((entry) => entry.status), status]),
        sessions: [...previous.sessions, fleetSession],
      });
      continue;
    }
    result.set(projectKey, {
      name: registered?.name ?? (basename(session.dir) || session.name),
      dir: session.dir,
      registered: Boolean(registered),
      running: true,
      status,
      sessions: [fleetSession],
    });
  }

  for (const project of input.projects.projects) {
    if (result.has(project.dir)) continue;
    result.set(project.dir, {
      name: project.name,
      dir: project.dir,
      registered: true,
      running: false,
      status: "idle",
      sessions: [],
    });
  }
  return [...result.values()];
}
