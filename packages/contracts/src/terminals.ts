/**
 * Multi-terminal registry contracts (G20-P1).
 *
 * A `Terminal` is a *named pool entry* — metadata about a PTY the
 * daemon may or may not have spawned yet. The daemon's existing
 * `/ws/pty/:id` endpoint owns the actual process lifecycle; this
 * registry exists so the UI can persist tab labels + restore them
 * across reloads, and so deterministic scope/script tabs collapse to
 * the same id (re-opens land on the running scrollback).
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type TerminalKind = "shell" | "setup" | "run" | "teardown";

export interface Terminal {
  /** Deterministic id for scope/script tabs; UUID for ad-hoc tabs. */
  id: string;
  /** Session name the terminal belongs to. */
  projectId: string;
  /** Sub-grouping inside a session (mission id, dir hash, …). Free-form. */
  scopeId: string;
  /** Free-text display name. The tab strip renames this without changing id. */
  name: string;
  kind: TerminalKind;
  createdAt: string;
  updatedAt: string;
  /** Set when the id was derived via `createScriptTerminalId` so the
   *  client can show a "shared script" badge in the tab strip. */
  scripted?: boolean;
}

/** Live runtime info — derived from the daemon's bridge registry, not
 *  the JSON store. Combined with `Terminal` for the list endpoint. */
export interface TerminalRuntime {
  running: boolean;
  cols?: number;
  rows?: number;
  /** Bytes available in the replay ring buffer when a client subscribes. */
  replayBytes?: number;
}

export interface TerminalWithRuntime extends Terminal {
  runtime: TerminalRuntime;
}

export interface TerminalListResponse {
  terminals: TerminalWithRuntime[];
}

// ---------------------------------------------------------------------
// Deterministic id
// ---------------------------------------------------------------------

/** Build a deterministic 32-char id from `(projectId, scopeId, kind,
 *  script)`. Two different callers asking for "the run script terminal
 *  for project X, scope Y, script Z" get the same id and land on the
 *  same bridge — which means scrollback survives a browser reload. */
export async function createScriptTerminalId(args: {
  projectId: string;
  scopeId?: string;
  /** Backward-compat alias for `scopeId`. */
  taskId?: string;
  kind: TerminalKind;
  script: string;
}): Promise<string> {
  const scope = args.scopeId ?? args.taskId;
  if (!scope) {
    throw new Error("createScriptTerminalId: scopeId (or taskId) is required");
  }
  const key = `${args.projectId}::${scope}::${args.kind}::${args.script}`;
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ---------------------------------------------------------------------
// Zod request schemas
// ---------------------------------------------------------------------

export const terminalKindSchema = z.enum(["shell", "setup", "run", "teardown"]);

export const terminalCreateRequestSchema = z
  .object({
    scopeId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(120),
    kind: terminalKindSchema.optional(),
    /** Provide for script tabs to opt into deterministic id collapse. */
    script: z.string().max(2048).optional(),
    /** Explicit id wins. Used by the dashboard to reserve a known id
     *  (e.g. the default shell tab derived from session.dir). */
    id: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/u, "id may only contain alphanumerics, '-', '_'")
      .optional(),
  })
  .refine((v) => v.kind !== undefined || v.script === undefined, {
    message: "script requires kind",
    path: ["script"],
  });
export type TerminalCreateRequest = z.infer<typeof terminalCreateRequestSchema>;

export const terminalRenameRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type TerminalRenameRequest = z.infer<typeof terminalRenameRequestSchema>;
