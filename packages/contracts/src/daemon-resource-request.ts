/**
 * The ONE daemon request vocabulary shared by every desktop host (m45.3).
 *
 * Before this module each daemon read or mutation was expressed at eleven
 * hand-written sites: a contract member, two host implementations, a facade
 * check, a channel constant, an allow-list entry, a preload stub, a main-process
 * handler, a coordinator interface, a coordinator method, and a broker fetch.
 * Seventeen resources meant roughly a hundred and ninety places where a keying
 * or vocabulary mistake could hide, and F-3.1 is exactly such a mistake that
 * shipped.
 *
 * Here the resource IS the data. One discriminated union names every request;
 * the result type of each variant is declared once; the preload stubs, the
 * renderer-facing method names, and the facade check are all DERIVED from that
 * declaration rather than mirrored by hand. Adding a resource is a variant here
 * plus a dispatch case in each host — two touch points, both of which the
 * compiler demands.
 *
 * What this is NOT: a generic escape hatch. The union is closed and validated
 * at the process boundary, so the renderer can still only ask for capabilities
 * that were declared and reviewed in this file.
 */
import { z } from "zod";

import {
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonFetchApplicationShellResultSchemaZ,
  DesktopDaemonFetchFleetCatalogResultSchemaZ,
  DesktopDaemonFetchWorkspaceCatalogResultSchemaZ,
  DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ,
  DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ,
  DesktopDaemonFetchWorkspaceChangesRequestSchemaZ,
  DesktopDaemonFetchWorkspaceChangesResultSchemaZ,
  DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ,
  DesktopDaemonFetchWorkspaceFilesRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilesResultSchemaZ,
  DesktopDaemonFetchWorkspaceMissionsRequestSchemaZ,
  DesktopDaemonFetchWorkspaceMissionsResultSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  DesktopDaemonStartupReadinessResultSchemaZ,
  type DesktopDaemonCapabilitiesResult,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonFetchFleetCatalogResult,
  type DesktopDaemonFetchWorkspaceCatalogResult,
  type DesktopDaemonFetchWorkspaceChangeDiffResult,
  type DesktopDaemonFetchWorkspaceChangesResult,
  type DesktopDaemonFetchWorkspaceFilePreviewResult,
  type DesktopDaemonFetchWorkspaceFilesResult,
  type DesktopDaemonFetchWorkspaceMissionsResult,
  type DesktopDaemonListWorkspacesResult,
  type DesktopDaemonRefreshConnectionResult,
  type DesktopDaemonStartupReadinessResult,
} from "./desktop-host.ts";
import {
  AppWindowMutationInvocationSchemaZ,
  AppWindowMutationHostResultSchemaZ,
  type AppWindowMutationHostResult,
} from "./app-window-mutation.ts";
import {
  WorkspacePaneCreateHostResultSchemaZ,
  WorkspacePaneCreateInvocationSchemaZ,
  type WorkspacePaneCreateHostResult,
} from "./workspace-pane-creation.ts";
import {
  WorkspacePromoteArgumentsSchemaZ,
  WorkspacePromoteHostResultSchemaZ,
  type WorkspacePromoteHostResult,
} from "./workspace-promotion.ts";
import {
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  type TerminalAttachmentIssueResult,
} from "./terminal-attachments.ts";
import { MultiplexerVerbInvocationSchemaZ } from "./multiplexer-verbs.ts";
import {
  WorkspaceMultiplexerHostResultSchemaZ,
  type WorkspaceMultiplexerHostResult,
} from "./workspace-multiplexer.ts";
import {
  PaneStreamIssueResultSchemaZ,
  PaneStreamLeaseRequestSchemaZ,
  type PaneStreamIssueResult,
} from "./pane-stream.ts";
import {
  WidgetAssetRequestSchemaZ,
  WidgetAssetResultSchemaZ,
  type WidgetAssetResult,
} from "./widget-asset.ts";

/**
 * Every daemon resource a desktop host can be asked for, keyed by `resource`.
 *
 * Variants carry a `request` only when the resource takes one. Note what is
 * absent: no route, no path fragment, and no session name. A client cannot
 * express "fetch this by tmux session" here because the renderer has no
 * business knowing tmux identity — see {@link DAEMON_WORKSPACE_ROUTE_KEYS} for
 * where that choice actually lives.
 */
export const DaemonResourceRequestSchemaZ = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("capabilities") }).strict(),
  z.object({ resource: z.literal("refreshConnection") }).strict(),
  z.object({ resource: z.literal("listWorkspaces") }).strict(),
  z.object({ resource: z.literal("fetchFleetCatalog") }).strict(),
  z.object({ resource: z.literal("fetchWorkspaceCatalog") }).strict(),
  z.object({ resource: z.literal("startupReadiness") }).strict(),
  z
    .object({
      resource: z.literal("fetchApplicationShell"),
      request: DesktopDaemonFetchApplicationShellRequestSchemaZ,
    })
    .strict(),
  z
    .object({
      resource: z.literal("fetchWorkspaceFiles"),
      request: DesktopDaemonFetchWorkspaceFilesRequestSchemaZ,
    })
    .strict(),
  z
    .object({
      resource: z.literal("fetchWorkspaceFilePreview"),
      request: DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ,
    })
    .strict(),
  z
    .object({
      resource: z.literal("fetchWorkspaceChanges"),
      request: DesktopDaemonFetchWorkspaceChangesRequestSchemaZ,
    })
    .strict(),
  z
    .object({
      resource: z.literal("fetchWorkspaceMissions"),
      request: DesktopDaemonFetchWorkspaceMissionsRequestSchemaZ,
    })
    .strict(),
  z
    .object({
      resource: z.literal("fetchWorkspaceChangeDiff"),
      request: DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ,
    })
    .strict(),
  z
    .object({ resource: z.literal("promoteWorkspace"), request: WorkspacePromoteArgumentsSchemaZ })
    .strict(),
  z
    .object({
      resource: z.literal("createWorkspacePane"),
      request: WorkspacePaneCreateInvocationSchemaZ,
    })
    .strict(),
  z
    .object({ resource: z.literal("mutateAppWindow"), request: AppWindowMutationInvocationSchemaZ })
    .strict(),
  // One resource for every tmux verb rather than one per route: see
  // MultiplexerVerbInvocation for why the invocation carries both the verb the
  // user clicked and the intent the daemon executes.
  z
    .object({ resource: z.literal("invokeVerb"), request: MultiplexerVerbInvocationSchemaZ })
    .strict(),
  z
    .object({
      resource: z.literal("issueTerminalAttachment"),
      request: TerminalAttachRequestSchemaZ,
    })
    .strict(),
  z
    .object({ resource: z.literal("issuePaneStream"), request: PaneStreamLeaseRequestSchemaZ })
    .strict(),
  z
    .object({ resource: z.literal("fetchWidgetAsset"), request: WidgetAssetRequestSchemaZ })
    .strict(),
]);

export type DaemonResourceRequest = z.infer<typeof DaemonResourceRequestSchemaZ>;
export type DaemonResourceKind = DaemonResourceRequest["resource"];
export type DaemonResourceRequestFor<K extends DaemonResourceKind> = Extract<
  DaemonResourceRequest,
  { resource: K }
>;

/**
 * The answer each resource resolves to. Extending `Record<DaemonResourceKind, …>`
 * is the completeness check: a variant added above without a result here does
 * not compile.
 */
export interface DaemonResourceResultMap extends Record<DaemonResourceKind, unknown> {
  capabilities: DesktopDaemonCapabilitiesResult;
  refreshConnection: DesktopDaemonRefreshConnectionResult;
  listWorkspaces: DesktopDaemonListWorkspacesResult;
  fetchFleetCatalog: DesktopDaemonFetchFleetCatalogResult;
  fetchWorkspaceCatalog: DesktopDaemonFetchWorkspaceCatalogResult;
  startupReadiness: DesktopDaemonStartupReadinessResult;
  fetchApplicationShell: DesktopDaemonFetchApplicationShellResult;
  fetchWorkspaceFiles: DesktopDaemonFetchWorkspaceFilesResult;
  fetchWorkspaceFilePreview: DesktopDaemonFetchWorkspaceFilePreviewResult;
  fetchWorkspaceChanges: DesktopDaemonFetchWorkspaceChangesResult;
  fetchWorkspaceMissions: DesktopDaemonFetchWorkspaceMissionsResult;
  fetchWorkspaceChangeDiff: DesktopDaemonFetchWorkspaceChangeDiffResult;
  promoteWorkspace: WorkspacePromoteHostResult;
  createWorkspacePane: WorkspacePaneCreateHostResult;
  mutateAppWindow: AppWindowMutationHostResult;
  invokeVerb: WorkspaceMultiplexerHostResult;
  issueTerminalAttachment: TerminalAttachmentIssueResult;
  issuePaneStream: PaneStreamIssueResult;
  fetchWidgetAsset: WidgetAssetResult;
}

export type DaemonResourceResult<K extends DaemonResourceKind> = DaemonResourceResultMap[K];

/**
 * The schema that validates each answer. Both hosts parse with these on the way
 * out and the preload parses with them on the way in, so a result that does not
 * match its contract is refused at the boundary rather than rendered.
 */
export const DAEMON_RESOURCE_RESULT_SCHEMAS: {
  readonly [K in DaemonResourceKind]: z.ZodType<DaemonResourceResult<K>>;
} = {
  capabilities: DesktopDaemonCapabilitiesResultSchemaZ,
  refreshConnection: DesktopDaemonRefreshConnectionResultSchemaZ,
  listWorkspaces: DesktopDaemonListWorkspacesResultSchemaZ,
  fetchFleetCatalog: DesktopDaemonFetchFleetCatalogResultSchemaZ,
  fetchWorkspaceCatalog: DesktopDaemonFetchWorkspaceCatalogResultSchemaZ,
  startupReadiness: DesktopDaemonStartupReadinessResultSchemaZ,
  fetchApplicationShell: DesktopDaemonFetchApplicationShellResultSchemaZ,
  fetchWorkspaceFiles: DesktopDaemonFetchWorkspaceFilesResultSchemaZ,
  fetchWorkspaceFilePreview: DesktopDaemonFetchWorkspaceFilePreviewResultSchemaZ,
  fetchWorkspaceChanges: DesktopDaemonFetchWorkspaceChangesResultSchemaZ,
  fetchWorkspaceMissions: DesktopDaemonFetchWorkspaceMissionsResultSchemaZ,
  fetchWorkspaceChangeDiff: DesktopDaemonFetchWorkspaceChangeDiffResultSchemaZ,
  promoteWorkspace: WorkspacePromoteHostResultSchemaZ,
  createWorkspacePane: WorkspacePaneCreateHostResultSchemaZ,
  mutateAppWindow: AppWindowMutationHostResultSchemaZ,
  invokeVerb: WorkspaceMultiplexerHostResultSchemaZ,
  issueTerminalAttachment: TerminalAttachmentIssueResultSchemaZ,
  issuePaneStream: PaneStreamIssueResultSchemaZ,
  fetchWidgetAsset: WidgetAssetResultSchemaZ,
};

/**
 * The resource names, in declaration order.
 *
 * This is the list a host iterates to build its bridge and a renderer iterates
 * to verify one. It is derived from {@link DAEMON_RESOURCE_RESULT_SCHEMAS}, so
 * it cannot fall behind the union.
 */
export const DAEMON_RESOURCE_KINDS = Object.keys(
  DAEMON_RESOURCE_RESULT_SCHEMAS,
) as readonly DaemonResourceKind[];

/**
 * Own keys only. `"toString" in record` is true for every object, and this
 * guard decides whether a renderer-supplied string names a resource at all.
 */
const DAEMON_RESOURCE_KIND_SET: ReadonlySet<string> = new Set(DAEMON_RESOURCE_KINDS);

export function isDaemonResourceKind(value: unknown): value is DaemonResourceKind {
  return typeof value === "string" && DAEMON_RESOURCE_KIND_SET.has(value);
}

/**
 * Resources whose work is observational and can therefore be retired without
 * creating an ambiguous "cancelled" result after a side effect committed.
 */
export const CANCELLABLE_DAEMON_RESOURCE_KINDS = [
  "capabilities",
  "listWorkspaces",
  "fetchFleetCatalog",
  "fetchWorkspaceCatalog",
  "startupReadiness",
  "fetchApplicationShell",
  "fetchWorkspaceFiles",
  "fetchWorkspaceFilePreview",
  "fetchWorkspaceChanges",
  "fetchWorkspaceMissions",
  "fetchWorkspaceChangeDiff",
  "fetchWidgetAsset",
] as const satisfies readonly DaemonResourceKind[];

export type CancellableDaemonResourceKind = (typeof CANCELLABLE_DAEMON_RESOURCE_KINDS)[number];

const CANCELLABLE_DAEMON_RESOURCE_KIND_SET: ReadonlySet<string> = new Set(
  CANCELLABLE_DAEMON_RESOURCE_KINDS,
);

export function isCancellableDaemonResourceKind(
  value: DaemonResourceKind,
): value is CancellableDaemonResourceKind {
  return CANCELLABLE_DAEMON_RESOURCE_KIND_SET.has(value);
}

/**
 * Which catalog field the daemon's route for a workspace resource is keyed on.
 *
 * This is the session-versus-workspace hazard, declared once. The daemon is not
 * uniform: `/api/project/:name/application-shell` takes a raw tmux SESSION
 * name, while the files and changes routes under the same prefix take a
 * WORKSPACE name. Getting it wrong is a silent 404, not a typed refusal, and it
 * shipped once.
 *
 * Every client previously chose per call site — the broker by interpolating
 * `workspace.sessionName` in one method and letting a shared helper interpolate
 * `workspace.workspaceName` in four others, the development host by passing a
 * `"sessionName" | "workspaceName"` string literal. Both now read the choice
 * from here, so there is exactly one place the answer can be wrong and the
 * compiler requires every workspace-keyed resource to state it.
 */
export const DAEMON_WORKSPACE_ROUTE_KEYS = {
  fetchApplicationShell: "sessionName",
  fetchWorkspaceFiles: "workspaceName",
  fetchWorkspaceFilePreview: "workspaceName",
  fetchWorkspaceChanges: "workspaceName",
  fetchWorkspaceMissions: "workspaceName",
  fetchWorkspaceChangeDiff: "workspaceName",
} as const;

export type DaemonWorkspaceResourceKind = keyof typeof DAEMON_WORKSPACE_ROUTE_KEYS;
export type DaemonWorkspaceRouteKey =
  (typeof DAEMON_WORKSPACE_ROUTE_KEYS)[DaemonWorkspaceResourceKind];

/** A catalog entry carries both names; the table above picks which one a route uses. */
export interface DaemonWorkspaceCatalogNames {
  readonly workspaceName: string;
  readonly sessionName: string;
}

/** The route parameter for one workspace resource. The only place either name is chosen. */
export function daemonWorkspaceRouteName(
  resource: DaemonWorkspaceResourceKind,
  entry: DaemonWorkspaceCatalogNames,
): string {
  return entry[DAEMON_WORKSPACE_ROUTE_KEYS[resource]];
}

/**
 * The renderer-facing method surface, derived from the union.
 *
 * `host.daemon.fetchWorkspaceChanges(request)` still reads exactly as it did
 * when fifteen methods were declared by hand — the ergonomics stores and
 * components were written against are unchanged — but no one maintains the
 * list any more.
 */
export type DaemonResourceMethods = {
  readonly [K in DaemonResourceKind]: DaemonResourceRequestFor<K> extends { request: infer R }
    ? K extends CancellableDaemonResourceKind
      ? (request: R, signal?: AbortSignal) => Promise<DaemonResourceResult<K>>
      : (request: R) => Promise<DaemonResourceResult<K>>
    : K extends CancellableDaemonResourceKind
      ? (signal?: AbortSignal) => Promise<DaemonResourceResult<K>>
      : () => Promise<DaemonResourceResult<K>>;
};

/** One dispatcher over the union: what a host implements once instead of fifteen times. */
export type DaemonResourceDispatcher = <K extends DaemonResourceKind>(
  request: DaemonResourceRequestFor<K>,
  signal?: AbortSignal,
) => Promise<DaemonResourceResult<K>>;

const REQUESTLESS_DAEMON_RESOURCES: ReadonlySet<DaemonResourceKind> = new Set([
  "capabilities",
  "refreshConnection",
  "listWorkspaces",
  "fetchFleetCatalog",
  "fetchWorkspaceCatalog",
  "startupReadiness",
]);

/**
 * Build the named methods over one dispatcher.
 *
 * Shared by all three hosts (preload bridge, browser preview, development web
 * host) so none of them re-lists the resources.
 */
export function createDaemonResourceMethods(
  dispatch: (request: DaemonResourceRequest, signal?: AbortSignal) => Promise<unknown>,
): DaemonResourceMethods {
  const methods: Record<string, (request?: unknown, signal?: AbortSignal) => Promise<unknown>> = {};
  for (const resource of DAEMON_RESOURCE_KINDS) {
    methods[resource] = (request?: unknown, signal?: AbortSignal) => {
      if (REQUESTLESS_DAEMON_RESOURCES.has(resource)) {
        const requestSignal = isCancellableDaemonResourceKind(resource)
          ? (request as AbortSignal | undefined)
          : undefined;
        return requestSignal === undefined
          ? dispatch({ resource } as DaemonResourceRequest)
          : dispatch({ resource } as DaemonResourceRequest, requestSignal);
      }
      const requestSignal = isCancellableDaemonResourceKind(resource) ? signal : undefined;
      return requestSignal === undefined
        ? dispatch({ resource, request } as DaemonResourceRequest)
        : dispatch({ resource, request } as DaemonResourceRequest, requestSignal);
    };
  }
  return methods as unknown as DaemonResourceMethods;
}
