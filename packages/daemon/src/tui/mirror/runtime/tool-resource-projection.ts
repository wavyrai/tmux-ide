import type {
  DaemonProjectsResponse,
  DaemonSessionsResponse,
  FleetCatalogResourceV1,
} from "@tmux-ide/contracts";
import { basename } from "node:path";

import type { AgentStatus } from "../../detect/classify.ts";
import type { AgentRowInput } from "../agent-rows.ts";

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
