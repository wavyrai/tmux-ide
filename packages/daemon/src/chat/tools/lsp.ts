/**
 * LSP chat tools (G21-P2).
 *
 * Exposes four tools the agent (Claude Code, Codex, any ACP client) can
 * call to inspect code via the daemon's LSP service that G21-P1 shipped:
 *
 *   - `lsp.hover`        — markdown hover content for the symbol at the
 *                          given file/line/column.
 *   - `lsp.definition`   — workspace locations where the symbol is
 *                          defined.
 *   - `lsp.references`   — every reference (including the definition).
 *   - `lsp.diagnostics`  — file-scoped error/warning list. `line` and
 *                          `column` are accepted but ignored.
 *
 * Each tool accepts `{ file, line, column }` with **1-based** line and
 * column at the tool boundary — agents and humans both reason about
 * editor-style 1-based positions. The tool translates to the LSP
 * wire's 0-based form before calling the backend so the values that
 * land at the language server match the canonical protocol.
 *
 * Path sandbox: the daemon's `/api/project/:name/lsp/*` endpoints
 * already enforce that `file` lives under the session directory; the
 * tool re-enforces the same rule before delegating so the agent can't
 * pass a path that wasn't accessible via the REST surface either. A
 * defense-in-depth measure — neither tier alone should be the only
 * gate.
 *
 * Backend dispatch: by default the tools call the in-process LSP
 * client directly (no HTTP loopback). The wire shape returned to the
 * agent is identical to what `POST /api/project/:name/lsp/<verb>`
 * exposes — same payload field names, same null-or-array semantics.
 * Tests inject a stub backend via the `lspBackend` option so the wire
 * is exercised without standing up a real language server.
 */

import { z } from "zod";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { getLspClientForFile, type LspClient } from "../../lsp/registry.ts";
import type { ChatTool } from "../tool-registry.ts";
import type { ToolResult } from "./tmux.ts";

// ---------------------------------------------------------------------
// Tool-input schemas
// ---------------------------------------------------------------------

const PositionInputSchema = z.object({
  file: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative path to the file. Absolute paths and `..` traversals are rejected.",
    ),
  line: z.number().int().min(1).describe("Editor-style 1-based line number."),
  column: z.number().int().min(1).describe("Editor-style 1-based column number."),
});

const DiagnosticsInputSchema = z.object({
  file: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative path to the file. Absolute paths and `..` traversals are rejected.",
    ),
  // line + column are accepted for ergonomic parity with the other LSP
  // tools (so an agent can pass the same position object verbatim) but
  // diagnostics are file-scoped — they're ignored.
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
});

export type LspPositionInput = z.infer<typeof PositionInputSchema>;
export type LspDiagnosticsInput = z.infer<typeof DiagnosticsInputSchema>;

// ---------------------------------------------------------------------
// Output shapes — match the REST envelopes from G21-P1 verbatim so the
// agent sees the same payload regardless of which surface it routes
// through.
// ---------------------------------------------------------------------

export interface LspHoverOutput {
  file: string;
  hover: unknown;
}
export interface LspDefinitionOutput {
  file: string;
  definition: unknown;
}
export interface LspReferencesOutput {
  file: string;
  references: unknown;
}
export interface LspDiagnosticsOutput {
  file: string;
  diagnostics: unknown[];
}

// ---------------------------------------------------------------------
// Backend abstraction
// ---------------------------------------------------------------------

/** Pluggable boundary between the tool and the LSP runtime. The
 *  default implementation calls `getLspClientForFile` directly; tests
 *  inject a stub to exercise the wire without a real server. */
export interface LspBackend {
  hover(file: string, line: number, character: number): Promise<unknown>;
  definition(file: string, line: number, character: number): Promise<unknown>;
  references(file: string, line: number, character: number): Promise<unknown>;
  diagnostics(file: string): Promise<unknown[]>;
}

export interface CreateLspToolsOptions {
  /** Absolute path to the session's workspace root. Every tool input's
   *  `file` is resolved against this and must stay inside it. */
  sessionDir: string;
  /** Override the LSP backend. Production leaves it unset and the
   *  default impl uses the in-process LSP client. */
  lspBackend?: LspBackend;
  /** Test seam: override how a session root is resolved. Production
   *  uses `realpathSync` directly. */
  resolveRoot?: (sessionDir: string) => string;
}

export interface LspTools {
  "lsp.hover": ChatTool<LspPositionInput, LspHoverOutput>;
  "lsp.definition": ChatTool<LspPositionInput, LspDefinitionOutput>;
  "lsp.references": ChatTool<LspPositionInput, LspReferencesOutput>;
  "lsp.diagnostics": ChatTool<LspDiagnosticsInput, LspDiagnosticsOutput>;
}

/** Default backend: routes through the in-process LSP client registry
 *  with the same `getLspClientForFile` lookup the REST endpoints use.
 *  `root` is the realpath'd workspace directory captured at tool-
 *  construction time so every call shares one workspace key. */
function defaultBackend(root: string): LspBackend {
  const acquire = async (file: string): Promise<LspClient> => {
    const client = await getLspClientForFile(root, file);
    if (!client) {
      throw new Error("No LSP server registered for this file type");
    }
    return client;
  };
  return {
    async hover(file, line, character) {
      const client = await acquire(file);
      return client.hover(file, line, character);
    },
    async definition(file, line, character) {
      const client = await acquire(file);
      return client.definition(file, line, character);
    },
    async references(file, line, character) {
      const client = await acquire(file);
      return client.references(file, line, character);
    },
    async diagnostics(file) {
      const client = await acquire(file);
      await client.ensureOpen(file);
      return client.waitForDiagnostics(file, 1500);
    },
  };
}

// ---------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------

interface SandboxedTarget {
  ok: true;
  /** Absolute filesystem path that's inside the workspace root. */
  target: string;
}
interface SandboxFailure {
  ok: false;
  error: string;
}

function sandboxFile(root: string, file: string): SandboxedTarget | SandboxFailure {
  if (isAbsolute(file)) {
    return { ok: false, error: "Absolute paths are not allowed; use a workspace-relative path" };
  }
  for (const seg of file.split("/")) {
    if (seg === "..") {
      return { ok: false, error: "Path escapes workspace (contains '..')" };
    }
  }
  const requested = pathResolve(root, file);
  let target: string;
  try {
    target = realpathSync(requested);
  } catch {
    // The file may not exist yet (creating a new file) — fall back to
    // the requested path. The LSP client returns null naturally.
    target = requested;
  }
  if (!target.startsWith(root + "/") && target !== root) {
    return { ok: false, error: "Path escapes workspace" };
  }
  return { ok: true, target };
}

// ---------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------

function zodToJsonSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  name: string,
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return { title: name, additionalProperties: false, ...json };
}

async function safe<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return { ok: true, output: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------

export function createLspTools(opts: CreateLspToolsOptions): LspTools {
  // Resolve the workspace root once. The sandbox + the default
  // backend both need it; realpath is idempotent, so caching is safe.
  let resolvedRoot: string;
  try {
    resolvedRoot = (opts.resolveRoot ?? realpathSync)(opts.sessionDir);
  } catch {
    resolvedRoot = opts.sessionDir;
  }
  const backend = opts.lspBackend ?? defaultBackend(resolvedRoot);

  /** Translate a tool-level (1-based) position to the LSP wire's
   *  (0-based) form. */
  const toWire = (line: number, column: number) => ({
    line: line - 1,
    character: column - 1,
  });

  return {
    "lsp.hover": {
      name: "lsp.hover",
      description:
        "Get LSP hover info (type signature, documentation) for the symbol at the given position. `line` and `column` are 1-based, matching how editors display positions. Returns the raw LSP hover payload or null.",
      inputSchema: PositionInputSchema,
      jsonSchema: zodToJsonSchema(PositionInputSchema, "lsp.hover"),
      async handler(input) {
        return safe(async () => {
          const parsed = PositionInputSchema.parse(input);
          const sandbox = sandboxFile(resolvedRoot, parsed.file);
          if (!sandbox.ok) throw new Error(sandbox.error);
          const { line, character } = toWire(parsed.line, parsed.column);
          const hover = await backend.hover(sandbox.target, line, character);
          return { file: parsed.file, hover } satisfies LspHoverOutput;
        });
      },
    },
    "lsp.definition": {
      name: "lsp.definition",
      description:
        "Resolve the definition site of the symbol at the given position via LSP. `line` and `column` are 1-based. Returns the raw LSP location payload (a Location, LocationLink[], or null).",
      inputSchema: PositionInputSchema,
      jsonSchema: zodToJsonSchema(PositionInputSchema, "lsp.definition"),
      async handler(input) {
        return safe(async () => {
          const parsed = PositionInputSchema.parse(input);
          const sandbox = sandboxFile(resolvedRoot, parsed.file);
          if (!sandbox.ok) throw new Error(sandbox.error);
          const { line, character } = toWire(parsed.line, parsed.column);
          const definition = await backend.definition(sandbox.target, line, character);
          return { file: parsed.file, definition } satisfies LspDefinitionOutput;
        });
      },
    },
    "lsp.references": {
      name: "lsp.references",
      description:
        "List references to the symbol at the given position via LSP, including the declaration. `line` and `column` are 1-based. Returns the raw LSP Location[] or null.",
      inputSchema: PositionInputSchema,
      jsonSchema: zodToJsonSchema(PositionInputSchema, "lsp.references"),
      async handler(input) {
        return safe(async () => {
          const parsed = PositionInputSchema.parse(input);
          const sandbox = sandboxFile(resolvedRoot, parsed.file);
          if (!sandbox.ok) throw new Error(sandbox.error);
          const { line, character } = toWire(parsed.line, parsed.column);
          const references = await backend.references(sandbox.target, line, character);
          return { file: parsed.file, references } satisfies LspReferencesOutput;
        });
      },
    },
    "lsp.diagnostics": {
      name: "lsp.diagnostics",
      description:
        "Get the current LSP diagnostics (errors, warnings, hints) for a file. Opens the file in the language server and waits briefly for diagnostics to settle before returning. `line` and `column` are accepted for input-shape parity with the other lsp.* tools but are ignored.",
      inputSchema: DiagnosticsInputSchema,
      jsonSchema: zodToJsonSchema(DiagnosticsInputSchema, "lsp.diagnostics"),
      async handler(input) {
        return safe(async () => {
          const parsed = DiagnosticsInputSchema.parse(input);
          const sandbox = sandboxFile(resolvedRoot, parsed.file);
          if (!sandbox.ok) throw new Error(sandbox.error);
          const diagnostics = await backend.diagnostics(sandbox.target);
          return {
            file: parsed.file,
            diagnostics,
          } satisfies LspDiagnosticsOutput;
        });
      },
    },
  };
}
