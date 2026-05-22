/**
 * HTTP route registry — every supported daemon endpoint described once,
 * here, by its method, path template, params (URL :placeholders), query
 * params, optional request body, and response shape.
 *
 * The typed client (`client.ts`) reads this registry to validate requests
 * and parse responses. Adding a route is a single object literal plus
 * matching server handler — no separate client glue needed.
 *
 * Conventions:
 *   - Path templates use `:name` for URL params (e.g. "/api/project/:name").
 *   - Query is a flat record of string/optional-string. Numbers + JSON go
 *     through as strings and the server parses.
 *   - When a route returns "null on 404", model it as `.nullable()` and let
 *     the client convert non-2xx into null on the read path.
 */

import { z } from "zod";
import { MissionSchemaZ, ProjectDetailSchemaZ, SessionOverviewSchemaZ } from "./domain.ts";
import { ProposedPlanZ, RuntimeModeZ } from "./chat-thread.ts";

// ---------------------------------------------------------------------------
// Shared response schemas (route-specific shapes that aren't elsewhere yet).
// ---------------------------------------------------------------------------

export const ValidationSummarySchemaZ = z.object({
  total: z.number(),
  passing: z.number(),
  failing: z.number(),
  pending: z.number(),
  blocked: z.number(),
});

export const MissionResponseSchemaZ = z.object({
  mission: MissionSchemaZ.passthrough(),
  validationSummary: ValidationSummarySchemaZ,
});

export const ProjectFileNodeSchemaZ: z.ZodType<{
  path: string;
  name: string;
  isDirectory: boolean;
  children?: Array<{
    path: string;
    name: string;
    isDirectory: boolean;
    children?: unknown[];
    truncated?: true;
  }>;
  truncated?: true;
}> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    isDirectory: z.boolean(),
    children: z.array(ProjectFileNodeSchemaZ).optional(),
    truncated: z.literal(true).optional(),
  }),
);

export const ProjectFilesResponseSchemaZ = z.object({
  tree: z.array(ProjectFileNodeSchemaZ),
  maxDepth: z.number(),
  truncated: z.boolean(),
});

export const DiffFileEntrySchemaZ = z.object({
  file: z.string(),
  additions: z.number(),
  deletions: z.number(),
});

export const DiffDataSchemaZ = z.object({
  diff: z.string(),
  files: z.array(DiffFileEntrySchemaZ),
});

export const FileDiffResponseSchemaZ = z.object({
  file: z.string(),
  diff: z.string(),
});

export const WidgetSpawnSpecSchemaZ = z.object({
  cwd: z.string(),
  cmd: z.array(z.string()),
});

export const SessionsListResponseSchemaZ = z.object({
  sessions: z.array(SessionOverviewSchemaZ),
});

export const ProjectEventSchemaZ = z.object({
  type: z.string(),
  timestamp: z.string(),
  relative: z.string().optional(),
  message: z.string().optional(),
  agent: z.string().nullable().optional(),
});

export const ProjectEventsResponseSchemaZ = z.union([
  z.array(ProjectEventSchemaZ),
  z.object({ events: z.array(ProjectEventSchemaZ) }),
]);

// Metrics — the daemon's raw response shape (renamed/reshaped client-side).
export const RawMetricsAgentSchemaZ = z.object({
  name: z.string(),
  totalTimeMs: z.number(),
  activeTimeMs: z.number(),
  taskCount: z.number(),
  utilization: z.number(),
});

export const RawMetricsResponseSchemaZ = z.object({
  session: z.object({ startedAt: z.string(), durationMs: z.number() }),
  tasks: z.object({ total: z.number() }),
  agents: z.array(RawMetricsAgentSchemaZ),
});

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Internal — narrow shape so the registry can be a `const` object literal. */
export interface RouteSpec<
  Params extends z.ZodTypeAny = z.ZodTypeAny,
  Query extends z.ZodTypeAny = z.ZodTypeAny,
  Body extends z.ZodTypeAny = z.ZodTypeAny,
  Res extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: HttpMethod;
  /** Path template: literal segments + `:name`-style placeholders. */
  path: string;
  /** Schema for URL params (the `:name` placeholders, etc.). */
  params?: Params;
  /** Schema for query string. */
  query?: Query;
  /** Schema for JSON request body (POST/PUT/DELETE). */
  body?: Body;
  /** Response shape on 2xx. Some routes accept null (e.g. 404 → null). */
  res: Res;
  /** When true, non-2xx maps to `null` instead of throwing. */
  nullableOn404?: boolean;
}

const ProjectNameParamsZ = z.object({ name: z.string() });

const ProjectFileParamsZ = z.object({
  name: z.string(),
  file: z.string(),
});

const WidgetSpawnQueryZ = z.object({
  session: z.string(),
  dir: z.string(),
  target: z.string().optional(),
  /** JSON-encoded theme blob — server JSON.parses if present. */
  theme: z.string().optional(),
});

const WidgetSpawnParamsZ = z.object({ name: z.string() });

// ---------------------------------------------------------------------------
// Plan-approve-execute (T076)
// ---------------------------------------------------------------------------

const ThreadIdParamsZ = z.object({ threadId: z.string().trim().min(1) });
const ThreadPlanParamsZ = z.object({
  threadId: z.string().trim().min(1),
  planId: z.string().trim().min(1),
});

export const PlanListResponseZ = z.object({
  plans: z.array(ProposedPlanZ),
});

export const PlanApproveBodyZ = z.object({
  runtimeMode: RuntimeModeZ.optional(),
});

export const PlanApproveResponseZ = z.object({
  plan: ProposedPlanZ,
  turnId: z.string(),
});

export const PlanRejectBodyZ = z.object({
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const PlanRejectResponseZ = z.object({
  plan: ProposedPlanZ,
});

export const routes = {
  "sessions.list": {
    method: "GET",
    path: "/api/sessions",
    res: SessionsListResponseSchemaZ,
  },
  "project.detail": {
    method: "GET",
    path: "/api/project/:name",
    params: ProjectNameParamsZ,
    res: ProjectDetailSchemaZ.passthrough(),
    nullableOn404: true,
  },
  "project.mission": {
    method: "GET",
    path: "/api/project/:name/mission",
    params: ProjectNameParamsZ,
    res: MissionResponseSchemaZ,
    nullableOn404: true,
  },
  "project.events": {
    method: "GET",
    path: "/api/project/:name/events",
    params: ProjectNameParamsZ,
    res: ProjectEventsResponseSchemaZ,
    nullableOn404: true,
  },
  "project.files": {
    method: "GET",
    path: "/api/project/:name/files",
    params: ProjectNameParamsZ,
    res: ProjectFilesResponseSchemaZ,
    nullableOn404: true,
  },
  "project.diff": {
    method: "GET",
    path: "/api/project/:name/diff",
    params: ProjectNameParamsZ,
    res: DiffDataSchemaZ,
    nullableOn404: true,
  },
  "project.fileDiff": {
    method: "GET",
    path: "/api/project/:name/diff/:file",
    params: ProjectFileParamsZ,
    res: FileDiffResponseSchemaZ,
    nullableOn404: true,
  },
  "project.metrics": {
    method: "GET",
    path: "/api/project/:name/metrics",
    params: ProjectNameParamsZ,
    res: RawMetricsResponseSchemaZ,
  },
  "widget.spawn": {
    method: "GET",
    path: "/api/widget/:name/spawn",
    params: WidgetSpawnParamsZ,
    query: WidgetSpawnQueryZ,
    res: WidgetSpawnSpecSchemaZ,
  },
  "threads.plans.list": {
    method: "GET",
    path: "/api/threads/:threadId/plans",
    params: ThreadIdParamsZ,
    res: PlanListResponseZ,
  },
  "threads.plans.approve": {
    method: "POST",
    path: "/api/threads/:threadId/plans/:planId/approve",
    params: ThreadPlanParamsZ,
    body: PlanApproveBodyZ,
    res: PlanApproveResponseZ,
  },
  "threads.plans.reject": {
    method: "POST",
    path: "/api/threads/:threadId/plans/:planId/reject",
    params: ThreadPlanParamsZ,
    body: PlanRejectBodyZ,
    res: PlanRejectResponseZ,
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof routes;

/** Inferred input/output types per route — narrowed via the satisfies above. */
export type RouteParams<R extends RouteName> = (typeof routes)[R] extends {
  params: infer P;
}
  ? P extends z.ZodTypeAny
    ? z.input<P>
    : void
  : void;

export type RouteQuery<R extends RouteName> = (typeof routes)[R] extends {
  query: infer Q;
}
  ? Q extends z.ZodTypeAny
    ? z.input<Q>
    : void
  : void;

export type RouteBody<R extends RouteName> = (typeof routes)[R] extends {
  body: infer B;
}
  ? B extends z.ZodTypeAny
    ? z.input<B>
    : void
  : void;

export type RouteResponse<R extends RouteName> = z.output<(typeof routes)[R]["res"]>;
