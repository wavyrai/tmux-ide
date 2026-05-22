/**
 * Tiny daemon-API client used by Solid widgets. Backed by the typed client
 * from @tmux-ide/contracts so request paths, query params, and response
 * shapes stay in lockstep with the daemon's route registry.
 *
 * Each fetch* helper here is a thin adapter that:
 *   - constructs a per-call ApiClient bound to the host's apiBaseUrl + token
 *   - invokes a single named route from the registry
 *   - reshapes the raw response into the widget-friendly shape (renaming a
 *     few server fields for the UI tier — kept here so the contracts package
 *     stays naming-stable for other consumers)
 *
 * If you find yourself adding a new fetch helper, add the route spec in
 * @tmux-ide/contracts/routes.ts first, then thread it through here.
 */

import { createApiClient, type ApiClient } from "@tmux-ide/contracts";
import type { BaseMountOptions } from "./types";

function client(opts: BaseMountOptions): ApiClient {
  return createApiClient({
    apiBaseUrl: opts.apiBaseUrl,
    bearerToken: opts.bearerToken,
  });
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MetricsAgent {
  name: string;
  taskCount: number;
  totalTimeMs: number;
  utilization: number;
}

export interface MetricsData {
  sessionStart: string;
  sessionElapsedMs: number;
  agents: MetricsAgent[];
  totalTimeMs: number;
  totalTasks: number;
}

export async function fetchMetrics(opts: BaseMountOptions): Promise<MetricsData> {
  const raw = await client(opts).call("project.metrics", {
    params: { name: opts.sessionName },
  });
  const agents: MetricsAgent[] = raw.agents.map((a) => ({
    name: a.name,
    taskCount: a.taskCount,
    totalTimeMs: a.activeTimeMs,
    utilization: a.utilization,
  }));
  return {
    sessionStart: raw.session.startedAt,
    sessionElapsedMs: raw.session.durationMs,
    agents,
    totalTimeMs: agents.reduce((sum, a) => sum + a.totalTimeMs, 0),
    totalTasks: raw.tasks.total,
  };
}

// ---------------------------------------------------------------------------
// Project files (used by Explorer)
// ---------------------------------------------------------------------------

export interface ProjectFileNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children?: ProjectFileNode[];
  truncated?: true;
}

export interface ProjectFilesResponse {
  tree: ProjectFileNode[];
  maxDepth: number;
  truncated: boolean;
}

export async function fetchProjectFiles(opts: BaseMountOptions): Promise<ProjectFilesResponse> {
  const data = await client(opts).call("project.files", {
    params: { name: opts.sessionName },
  });
  return (data as ProjectFilesResponse | null) ?? { tree: [], maxDepth: 0, truncated: false };
}

// ---------------------------------------------------------------------------
// Diff (used by Changes)
// ---------------------------------------------------------------------------

export interface DiffFileEntry {
  file: string;
  additions: number;
  deletions: number;
}

export interface DiffData {
  diff: string;
  files: DiffFileEntry[];
}

export async function fetchProjectDiff(opts: BaseMountOptions): Promise<DiffData | null> {
  return client(opts).call("project.diff", { params: { name: opts.sessionName } });
}

export async function fetchProjectFileDiff(opts: BaseMountOptions, file: string): Promise<string> {
  const data = await client(opts).call("project.fileDiff", {
    params: { name: opts.sessionName, file },
  });
  return data?.diff ?? "";
}

// ---------------------------------------------------------------------------
// Mission Control
// ---------------------------------------------------------------------------

export interface MissionMilestone {
  id: string;
  title: string;
  status: string;
  taskCount: number;
  tasksDone: number;
  order?: number;
}

export interface MissionPayload {
  title: string;
  description?: string;
  status?: string;
  milestones?: MissionMilestone[];
}

export interface ValidationSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  blocked: number;
}

export interface MissionResponse {
  mission: MissionPayload;
  validationSummary: ValidationSummary;
}

export interface ProjectAgentDetail {
  paneTitle: string;
  paneId: string;
  isBusy: boolean;
  taskTitle: string | null;
  taskId: string | null;
  elapsed: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  status: string;
  priority?: number;
  assignee?: string | null;
  milestone?: string | null;
}

export interface ProjectDetailPayload {
  agents: ProjectAgentDetail[];
  tasks: ProjectTask[];
  milestones?: MissionMilestone[];
}

export interface ProjectEvent {
  type: string;
  timestamp: string;
  relative?: string;
  message?: string;
  agent?: string | null;
}

export async function fetchProjectMission(opts: BaseMountOptions): Promise<MissionResponse | null> {
  const data = await client(opts).call("project.mission", {
    params: { name: opts.sessionName },
  });
  return (data as MissionResponse | null) ?? null;
}

export async function fetchProjectDetail(
  opts: BaseMountOptions,
): Promise<ProjectDetailPayload | null> {
  const data = await client(opts).call("project.detail", {
    params: { name: opts.sessionName },
  });
  return (data as ProjectDetailPayload | null) ?? null;
}

export async function fetchProjectEvents(opts: BaseMountOptions): Promise<ProjectEvent[]> {
  const data = await client(opts).call("project.events", {
    params: { name: opts.sessionName },
  });
  if (!data) return [];
  if (Array.isArray(data)) return data as ProjectEvent[];
  return (data as { events: ProjectEvent[] }).events ?? [];
}

// ---------------------------------------------------------------------------
// Project plans (used by PlansRail)
//
// The plans surface is file-based (markdown under the project's plans/
// directory) and is not yet routed through the typed contracts client —
// the dashboard's `lib/api.ts` calls `/api/project/:name/plans` directly
// via fetch(). Mirroring that shape here keeps the rail widget self-
// contained until the route lands in @tmux-ide/contracts/routes.ts.
// ---------------------------------------------------------------------------

export type PlanStatus = "pending" | "in-progress" | "done" | "archived";

export interface PlanSummary {
  name: string;
  path: string;
  title: string;
  status: PlanStatus;
  effort: string | null;
  owner?: string | null;
  updated?: string | null;
  completed: string | null;
  tags?: string[];
}

export async function fetchProjectPlans(opts: BaseMountOptions): Promise<PlanSummary[]> {
  const base = opts.apiBaseUrl ?? "";
  const url = `${base}/api/project/${encodeURIComponent(opts.sessionName)}/plans`;
  const headers: Record<string, string> = {};
  if (opts.bearerToken) headers["Authorization"] = `Bearer ${opts.bearerToken}`;
  const res = await fetch(url, { cache: "no-store", headers });
  if (!res.ok) return [];
  const data = (await res.json()) as { plans?: PlanSummary[] };
  return data.plans ?? [];
}
