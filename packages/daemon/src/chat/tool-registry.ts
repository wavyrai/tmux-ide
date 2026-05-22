import type { z } from "zod";
import { createTmuxTools, type TmuxToolDeps, type ToolResult } from "./tools/tmux.ts";
import { createLspTools, type LspBackend } from "./tools/lsp.ts";
import { createTmuxideTools, type CreateTmuxideToolsOptions } from "./tools/tmuxide.ts";

export interface ChatTool<TIn = unknown, TOut = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TIn>;
  jsonSchema: Record<string, unknown>;
  handler: (input: TIn) => Promise<ToolResult<TOut>>;
}

export interface ChatToolRegistry {
  /** All registered tools, keyed by tool name. */
  readonly tools: ReadonlyMap<string, ChatTool>;
  list(): ChatTool[];
  get<TIn = unknown, TOut = unknown>(name: string): ChatTool<TIn, TOut> | undefined;
  /** ACP-style advertisement payload: name, description, JSON schema for inputs. */
  advertise(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface BuildChatToolRegistryOptions {
  session: string;
  tmuxDeps?: TmuxToolDeps;
  /** Workspace root for `lsp.*` tools. When omitted (or null), the
   *  registry skips registering the LSP suite — the daemon mounts the
   *  REST endpoints anyway, but tool-loop agents need this set to
   *  invoke them. */
  lsp?: {
    sessionDir: string;
    /** Optional test override for the LSP backend. Production leaves
     *  it unset and the default impl calls the in-process LSP client
     *  registry shipped with G21-P1. */
    backend?: LspBackend;
    /** Test override for the realpath resolver. */
    resolveRoot?: (sessionDir: string) => string;
  };
  /** When set, registers the `tmuxide.*` self-introspection/control
   *  suite. Omitted by default — the suite needs an approval requester
   *  wired to the chat permission flow, so a session can't get it for
   *  free. `session` defaults to the registry's `session`. */
  tmuxide?: Omit<CreateTmuxideToolsOptions, "session"> & { session?: string };
  /** Additional tools to register beyond the built-in suites. */
  extraTools?: ChatTool[];
}

/**
 * Build a ChatToolRegistry for a given tmux session. Always registers the
 * three built-in tmux ops (`send_to_pane`, `read_pane`, `capture_pane`) so
 * the chat agent (ACP or codex) can orchestrate panes. When `lsp` is set,
 * also registers `lsp.hover` / `lsp.definition` / `lsp.references` /
 * `lsp.diagnostics` so the agent can navigate code via the language
 * servers G21-P1 stood up.
 */
export function buildChatToolRegistry(opts: BuildChatToolRegistryOptions): ChatToolRegistry {
  const tmuxTools = createTmuxTools(opts.session, opts.tmuxDeps);
  const all: ChatTool[] = [
    tmuxTools.send_to_pane as unknown as ChatTool,
    tmuxTools.read_pane as unknown as ChatTool,
    tmuxTools.capture_pane as unknown as ChatTool,
  ];
  if (opts.lsp) {
    const lspTools = createLspTools({
      sessionDir: opts.lsp.sessionDir,
      ...(opts.lsp.backend ? { lspBackend: opts.lsp.backend } : {}),
      ...(opts.lsp.resolveRoot ? { resolveRoot: opts.lsp.resolveRoot } : {}),
    });
    all.push(
      lspTools["lsp.hover"] as unknown as ChatTool,
      lspTools["lsp.definition"] as unknown as ChatTool,
      lspTools["lsp.references"] as unknown as ChatTool,
      lspTools["lsp.diagnostics"] as unknown as ChatTool,
    );
  }
  if (opts.tmuxide) {
    const { session: tmuxideSession, ...tmuxideRest } = opts.tmuxide;
    const tmuxideTools = createTmuxideTools({
      session: tmuxideSession ?? opts.session,
      ...tmuxideRest,
    });
    all.push(...Object.values(tmuxideTools));
  }
  if (opts.extraTools) all.push(...opts.extraTools);
  const map = new Map<string, ChatTool>();
  for (const tool of all) {
    if (map.has(tool.name)) {
      throw new Error(`Duplicate chat tool registration: ${tool.name}`);
    }
    map.set(tool.name, tool);
  }
  return {
    tools: map,
    list: () => Array.from(map.values()),
    get: <TIn = unknown, TOut = unknown>(name: string) =>
      map.get(name) as ChatTool<TIn, TOut> | undefined,
    advertise: () =>
      Array.from(map.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.jsonSchema,
      })),
  };
}

export { createTmuxTools } from "./tools/tmux.ts";
export { createLspTools } from "./tools/lsp.ts";
export { createTmuxideTools, makePermissionApprovalRequester } from "./tools/tmuxide.ts";
export type {
  CreateTmuxideToolsOptions,
  TmuxideClassification,
  TmuxideApprovalRequest,
  TmuxideApprovalDecision,
  TmuxideApprovalRequester,
  PermissionApprovalDeps,
} from "./tools/tmuxide.ts";
export type {
  TmuxToolDeps,
  ToolResult,
  SendToPaneInput,
  SendToPaneOutput,
  ReadPaneInput,
  ReadPaneOutput,
  CapturePaneInput,
  CapturePaneOutput,
} from "./tools/tmux.ts";
export type {
  CreateLspToolsOptions,
  LspBackend,
  LspPositionInput,
  LspDiagnosticsInput,
  LspHoverOutput,
  LspDefinitionOutput,
  LspReferencesOutput,
  LspDiagnosticsOutput,
} from "./tools/lsp.ts";
