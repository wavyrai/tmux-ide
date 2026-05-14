/**
 * Effect-wrapped REST client — Solid edition.
 *
 * Mirrors `dashboard/lib/api.ts` for the slice G16-P1 needs (just
 * `fetchSessions` so the widgets gallery can resolve a project name +
 * dir to pin TUI tile deep-links to). Each fetcher returns an
 * `Effect.Effect<TOk, ApiError>` so the widgets route can compose with
 * other effects later in Goal-16 without retrofitting.
 *
 * `resolveApiBase` is identical to the React side: env override wins,
 * SSR returns "" (this app is SPA-only so SSR never runs in
 * production), localhost gets pinned to 127.0.0.1 to skip the IPv6
 * stall.
 */

import { Effect, Data } from "effect";
import type { SessionOverview } from "@tmux-ide/contracts";

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: number;
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveApiBase(): string {
  const explicit = (import.meta as { env?: Record<string, string> }).env?.VITE_API_URL;
  if (explicit) return explicit;
  if (typeof window === "undefined") return "";
  const envPort = (import.meta as { env?: Record<string, string> }).env?.VITE_API_PORT;
  const port = envPort ?? "6060";
  const host = window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname;
  return `${window.location.protocol}//${host}:${port}`;
}

export const API_BASE: string = resolveApiBase();

/**
 * Effect-wrapped `fetch`. Maps a non-2xx response to a `ApiError` with
 * the daemon's error body when it can be parsed, otherwise a synthetic
 * status-only message. Network failures (DNS, connection refused) also
 * land on `ApiError` with `status: 0`.
 */
function request<T>(path: string, init?: RequestInit): Effect.Effect<T, ApiError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // Body wasn't JSON; the status-only message stands.
        }
        throw new ApiError({ status: res.status, message });
      }
      return (await res.json()) as T;
    },
    catch: (cause) =>
      cause instanceof ApiError
        ? cause
        : new ApiError({
            status: 0,
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
  });
}

/**
 * GET /api/sessions — list registered tmux-ide sessions. Widgets gallery
 * uses the first session's name + dir to pin TUI tile deep-links so
 * `/v2/widget/:name?session=&dir=` resolves to something real.
 */
export function fetchSessions(): Effect.Effect<readonly SessionOverview[], ApiError> {
  return request<{ sessions: SessionOverview[] }>("/api/sessions").pipe(
    Effect.map((data) => data.sessions ?? []),
  );
}

// ---------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------

export interface ProjectInspectDetected {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  frameworks: string[];
  devCommand: string | null;
  testCommand: string | null;
}

export interface ProjectInspect {
  name: string;
  dir: string;
  hasIdeYml: boolean;
  gitOrigin: string | null;
  gitBranch: string | null;
  detected: ProjectInspectDetected;
}

export function inspectDirectory(dir: string): Effect.Effect<ProjectInspect, ApiError> {
  return request<{ project: ProjectInspect }>("/api/filesystem/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir }),
  }).pipe(Effect.map((data) => data.project));
}

export interface OnboardProjectInput {
  dir: string;
  name?: string;
  agents: number;
  agentNames?: string[];
  devCommand?: string | null;
  testCommand?: string | null;
}

export interface OnboardedProject {
  name: string;
  dir: string;
}

export function onboardProject(
  input: OnboardProjectInput,
): Effect.Effect<OnboardedProject, ApiError> {
  return request<OnboardedProject>("/api/projects/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Fire a v2 typed action by name. The daemon's envelope is
 * `{ ok: true, data }` or `{ ok: false, error }`; we only surface
 * the wire-level success/failure here — the setup wizard maps that to
 * its dispatch-style state.
 */
export function dispatchAction(name: string, input: unknown): Effect.Effect<unknown, ApiError> {
  return request<{ ok: boolean; data?: unknown; error?: { message: string } }>(
    `/api/v2/action/${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  ).pipe(
    Effect.flatMap((envelope) =>
      envelope.ok
        ? Effect.succeed(envelope.data)
        : Effect.fail(
            new ApiError({
              status: 0,
              message: envelope.error?.message ?? `Action "${name}" failed`,
            }),
          ),
    ),
  );
}

// ---------------------------------------------------------------------
// File content — used by the Monaco model registry to fetch on-disk
// content for `disk://` models. The daemon sandboxes the path under
// the session's working directory (realpath-aware).
// ---------------------------------------------------------------------

export interface FilePreview {
  file: string;
  exists: boolean;
  content: string;
}

export function fetchFilePreview(
  sessionName: string,
  filePath: string,
): Effect.Effect<FilePreview, ApiError> {
  const normalized = filePath.replace(/^\/+/g, "");
  return request<FilePreview>(
    `/api/project/${encodeURIComponent(sessionName)}/preview/${encodeURI(normalized)}`,
  );
}

// ---------------------------------------------------------------------
// Git file content — used by the Monaco model registry to populate
// the `git://...` side of a StickyDiffEditor. Refs:
//   HEAD     — current branch tip
//   STAGED   — git index (the `:path` form)
//   WORKING  — working-tree mirror (the same content the disk:// URI
//              shows, but reachable via the same endpoint so callers
//              don't have to swap routes between the three sides)
//   <sha> / <branch>  — arbitrary ref (`origin/main`, a short SHA, etc.)
// ---------------------------------------------------------------------

export type GitRef = "HEAD" | "STAGED" | "WORKING" | (string & {});

export interface GitFileContent {
  path: string;
  ref: string;
  exists: boolean;
  content: string;
}

/**
 * Save a file's contents to disk via `PUT /api/project/:name/file`.
 * Used by the buffer-store's Cmd+S save action.
 */
export interface SaveFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export function saveFile(
  sessionName: string,
  filePath: string,
  content: string,
): Effect.Effect<SaveFileResult, ApiError> {
  const normalized = filePath.replace(/^\/+/g, "");
  const params = new URLSearchParams();
  params.set("path", normalized);
  return request<SaveFileResult>(
    `/api/project/${encodeURIComponent(sessionName)}/file?${params.toString()}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

export function fetchGitFile(
  sessionName: string,
  filePath: string,
  ref: GitRef = "HEAD",
): Effect.Effect<GitFileContent, ApiError> {
  const normalized = filePath.replace(/^\/+/g, "");
  const params = new URLSearchParams();
  params.set("path", normalized);
  params.set("ref", ref);
  return request<GitFileContent>(
    `/api/project/${encodeURIComponent(sessionName)}/git/file?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------
// File tree + diff — used by the Files / Diffs surfaces in the IDE
// shell. All three round-trip through the daemon's REST endpoints
// (`/api/project/:name/files`, `/diff`, `/diff/:file`); same data
// the v2-solid-widgets RPC client consumes, but Effect-typed for
// direct dashboard consumption.
// ---------------------------------------------------------------------

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

export function fetchProjectFiles(
  sessionName: string,
): Effect.Effect<ProjectFilesResponse, ApiError> {
  return request<ProjectFilesResponse>(
    `/api/project/${encodeURIComponent(sessionName)}/files`,
  ).pipe(
    Effect.map(
      (data) => (data ?? { tree: [], maxDepth: 0, truncated: false }) as ProjectFilesResponse,
    ),
  );
}

export interface DiffFileEntry {
  file: string;
  additions: number;
  deletions: number;
}

export interface DiffData {
  diff: string;
  files: DiffFileEntry[];
}

export function fetchProjectDiff(sessionName: string): Effect.Effect<DiffData, ApiError> {
  return request<DiffData>(`/api/project/${encodeURIComponent(sessionName)}/diff`).pipe(
    Effect.map((data) => data ?? { diff: "", files: [] }),
  );
}

export function fetchProjectFileDiff(
  sessionName: string,
  filePath: string,
): Effect.Effect<string, ApiError> {
  const normalized = filePath.replace(/^\/+/g, "");
  return request<{ diff: string }>(
    `/api/project/${encodeURIComponent(sessionName)}/diff/${encodeURI(normalized)}`,
  ).pipe(Effect.map((data) => data?.diff ?? ""));
}

// ---------------------------------------------------------------------
// Widget spawn — used by /v2/widget/[name] to ask the daemon where the
// widget binary lives + how to invoke it, then drive a Terminal via the
// same WS protocol the tmux panes use.
// ---------------------------------------------------------------------

export interface WidgetSpawnSpec {
  cwd: string;
  cmd: string[];
}

export function fetchWidgetSpawn(
  name: string,
  query: { session: string; dir: string; target?: string | null; theme?: unknown },
): Effect.Effect<WidgetSpawnSpec, ApiError> {
  const params = new URLSearchParams();
  params.set("session", query.session);
  params.set("dir", query.dir);
  if (query.target) params.set("target", query.target);
  if (query.theme !== undefined) params.set("theme", JSON.stringify(query.theme));
  return request<WidgetSpawnSpec>(
    `/api/widget/${encodeURIComponent(name)}/spawn?${params.toString()}`,
  );
}
