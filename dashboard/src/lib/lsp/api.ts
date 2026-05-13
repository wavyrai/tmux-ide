/**
 * Daemon LSP REST client — slim wrappers over the G21-P1 endpoints.
 *
 * Each helper resolves to the daemon's parsed JSON body or throws
 * an `LspApiError` with the server's `error` string (or a synthetic
 * status-only message for network failures).
 */

import { API_BASE } from "@/lib/api";

export class LspApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "LspApiError";
  }
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspMarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

export type LspHoverContents =
  | LspMarkupContent
  | string
  | Array<string | { language?: string; value: string }>;

export interface LspHover {
  contents: LspHoverContents;
  range?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // 1=Error, 2=Warning, 3=Information, 4=Hint
  code?: string | number;
  source?: string;
  message: string;
}

interface PositionBody {
  file: string;
  line: number;
  column: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LspApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      /* status-only message stands */
    }
    throw new LspApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export function lspHover(
  sessionName: string,
  body: PositionBody,
  signal?: AbortSignal,
): Promise<{ hover: LspHover | null }> {
  void signal; // browsers cancel fetches via signal; we don't pipe it through
                 // here because the underlying request is debounced & short.
  return postJson(`/api/project/${encodeURIComponent(sessionName)}/lsp/hover`, body);
}

export function lspDefinition(
  sessionName: string,
  body: PositionBody,
): Promise<{ definition: LspLocation | LspLocation[] | LspLocationLink[] | null }> {
  return postJson(
    `/api/project/${encodeURIComponent(sessionName)}/lsp/definition`,
    body,
  );
}

export function lspReferences(
  sessionName: string,
  body: PositionBody,
): Promise<{ references: LspLocation[] | null }> {
  return postJson(
    `/api/project/${encodeURIComponent(sessionName)}/lsp/references`,
    body,
  );
}

export function lspDiagnostics(
  sessionName: string,
  file: string,
): Promise<{ diagnostics: LspDiagnostic[] }> {
  return postJson(
    `/api/project/${encodeURIComponent(sessionName)}/lsp/diagnostics`,
    { file },
  );
}
