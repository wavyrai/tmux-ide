/**
 * Solid-side terminal registry (G20-P1).
 *
 * Mirrors `lib/git/` shape: an Effect-wrapped REST client plus a
 * Solid `useTerminals(sessionName)` resource. The hook owns the list +
 * runtime info; consumers (the tab strip in G20-P3) call
 * `createTerminal / renameTerminal / deleteTerminal` and the next
 * `terminals.changed` WS frame refreshes the resource.
 *
 * P1 ships the data path only — the active-tab + xterm mounting
 * lifecycle lands in P2 alongside `FrontendPty`. Until then this
 * surface is consumable by any UI that wants to enumerate / name /
 * scope PTY tabs without spawning xterm itself.
 */

import { createResource, type Resource } from "solid-js";
import { Effect, Data } from "effect";
import type {
  Terminal,
  TerminalCreateRequest,
  TerminalKind,
  TerminalListResponse,
  TerminalRenameRequest,
  TerminalWithRuntime,
} from "@tmux-ide/contracts";
import { createScriptTerminalId } from "@tmux-ide/contracts";
import { API_BASE } from "@/lib/api";

export class TerminalsApiError extends Data.TaggedError("TerminalsApiError")<{
  readonly status: number;
  readonly message: string;
}> {}

interface ErrorBody {
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as T & ErrorBody;
  if (!res.ok) {
    throw new TerminalsApiError({
      status: res.status,
      message: body.error ?? `HTTP ${res.status}`,
    });
  }
  return body;
}

function effect<T>(path: string, init?: RequestInit): Effect.Effect<T, TerminalsApiError> {
  return Effect.tryPromise({
    try: () => request<T>(path, init),
    catch: (cause) =>
      cause instanceof TerminalsApiError
        ? cause
        : new TerminalsApiError({
            status: 0,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}

// ---------------------------------------------------------------------
// Effect-wrapped operations
// ---------------------------------------------------------------------

export function fetchTerminals(
  sessionName: string,
): Effect.Effect<readonly TerminalWithRuntime[], TerminalsApiError> {
  return effect<TerminalListResponse>(
    `/api/project/${encodeURIComponent(sessionName)}/terminals`,
  ).pipe(Effect.map((b) => b.terminals));
}

export function createTerminal(
  sessionName: string,
  input: TerminalCreateRequest,
): Effect.Effect<Terminal, TerminalsApiError> {
  return effect<{ ok: true; terminal: Terminal }>(
    `/api/project/${encodeURIComponent(sessionName)}/terminals`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  ).pipe(Effect.map((b) => b.terminal));
}

export function renameTerminal(
  sessionName: string,
  id: string,
  body: TerminalRenameRequest,
): Effect.Effect<Terminal, TerminalsApiError> {
  return effect<{ ok: true; terminal: Terminal }>(
    `/api/project/${encodeURIComponent(sessionName)}/terminals/${encodeURIComponent(id)}/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ).pipe(Effect.map((b) => b.terminal));
}

export function deleteTerminal(
  sessionName: string,
  id: string,
): Effect.Effect<void, TerminalsApiError> {
  return effect<{ ok: true }>(
    `/api/project/${encodeURIComponent(sessionName)}/terminals/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  ).pipe(Effect.map(() => undefined));
}

// ---------------------------------------------------------------------
// Solid hook
// ---------------------------------------------------------------------

export type TerminalsResource = Resource<readonly TerminalWithRuntime[] | null> & {
  refetch: () => Promise<readonly TerminalWithRuntime[] | null | undefined>;
};

/** Reactive terminal list. Subscribers see the daemon's view of the
 *  tab strip — tabs + per-id runtime (running, cols, rows, replay
 *  bytes). Re-keyed on `sessionName` so a project switch refetches.
 *  P3 wires a `terminals.changed` WS subscription on top to trigger
 *  `refetch()` without polling. */
export function useTerminals(sessionName: () => string | null): TerminalsResource {
  const [resource, { refetch }] = createResource(sessionName, async (name) => {
    if (!name) return null;
    return Effect.runPromise(
      fetchTerminals(name).pipe(
        Effect.catchAll(() => Effect.succeed([] as readonly TerminalWithRuntime[])),
      ),
    );
  });
  (resource as TerminalsResource).refetch = async () => refetch();
  return resource as TerminalsResource;
}

/** Convenience: derive the deterministic id for a session's default
 *  shell tab. The tab strip in P3 calls this on first mount so
 *  reopening tmux-ide on the same session reuses the running shell. */
export function defaultShellTerminalId(args: {
  projectId: string;
  scopeId: string;
  shell?: string;
}): Promise<string> {
  return createScriptTerminalId({
    projectId: args.projectId,
    scopeId: args.scopeId,
    kind: "shell" as TerminalKind,
    script: args.shell ?? "$SHELL -l",
  });
}
