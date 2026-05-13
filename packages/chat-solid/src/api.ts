import type {
  AgentProvider,
  ChatThreadUsageSummary,
  ComposerTerminalPane,
  ContentBlock,
  ThreadIndexEntry,
  ThreadState,
} from "./types";

export interface ApiRuntime {
  apiBaseUrl: string;
  bearerToken: string | null;
}

interface ActionOkEnvelope<T> {
  ok: true;
  result: T;
}

interface ActionErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

type ActionEnvelope<T> = ActionOkEnvelope<T> | ActionErrorEnvelope;

export class ChatSolidApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, code = "internal", details?: unknown) {
    super(message);
    this.name = "ChatSolidApiError";
    this.code = code;
    this.details = details ?? null;
  }
}

export interface PermissionRespondInput {
  threadId: string;
  requestId: string;
  optionId: string;
}

export interface ChatContextCaptureTerminalInput {
  sessionName: string;
  paneId: string;
}

export interface ChatContextCaptureTerminalResult {
  pane: { id: string; title: string };
  content: string;
  capturedAt: string;
}

interface ProjectPane {
  id: string;
  title: string;
  currentCommand?: string;
}

export async function postAction<T>(runtime: ApiRuntime, name: string, input: unknown): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (runtime.bearerToken) headers.set("Authorization", `Bearer ${runtime.bearerToken}`);
  const res = await fetch(`${runtime.apiBaseUrl}/api/v2/action/${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    cache: "no-store",
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // handled below
  }

  if (!body || typeof body !== "object" || !("ok" in body)) {
    throw new ChatSolidApiError(`Action "${name}" returned HTTP ${res.status}`, "internal", {
      status: res.status,
    });
  }
  const envelope = body as ActionEnvelope<T>;
  if (!envelope.ok) {
    throw new ChatSolidApiError(
      envelope.error.message,
      envelope.error.code,
      envelope.error.details,
    );
  }
  return envelope.result;
}

export function chatThreadGet(runtime: ApiRuntime, id: string): Promise<{ thread: ThreadState }> {
  return postAction(runtime, "chat.thread.get", { id });
}

export function chatThreadUsage(
  runtime: ApiRuntime,
  id: string,
): Promise<{ usage: ChatThreadUsageSummary | null }> {
  return postAction(runtime, "chat.thread.usage", { id });
}

export function chatThreadRename(
  runtime: ApiRuntime,
  id: string,
  title: string,
): Promise<{ thread: ThreadIndexEntry }> {
  return postAction(runtime, "chat.thread.rename", { id, title });
}

/**
 * Swap the provider on an existing thread. The daemon clears the live
 * ACP/Codex client; the next `chat.session.send` re-spawns under the
 * new provider. The header reflects the change once the host refreshes
 * thread state (typically by re-emitting mount options).
 */
export function chatThreadSetProvider(
  runtime: ApiRuntime,
  id: string,
  provider: AgentProvider,
): Promise<{ thread: ThreadIndexEntry }> {
  return postAction(runtime, "chat.thread.setProvider", { id, provider });
}

export function chatSessionSend(
  runtime: ApiRuntime,
  threadId: string,
  content: ContentBlock[],
): Promise<{ accepted: true; promptId: string }> {
  return postAction(runtime, "chat.session.send", { threadId, content });
}

export function chatSessionCancel(
  runtime: ApiRuntime,
  threadId: string,
): Promise<{ cancelled: true }> {
  return postAction(runtime, "chat.session.cancel", { threadId });
}

export async function chatPermissionRespond(
  runtime: ApiRuntime,
  input: PermissionRespondInput,
): Promise<void> {
  await postAction<{ responded: true }>(runtime, "chat.permission.respond", input);
}

export function chatContextCaptureTerminal(
  runtime: ApiRuntime,
  input: ChatContextCaptureTerminalInput,
): Promise<ChatContextCaptureTerminalResult> {
  return postAction(runtime, "chat.context.captureTerminal", input);
}

/**
 * Wire shape from `GET /api/chat/providers`. Mirrors the daemon's
 * `ProviderInfo` (packages/daemon/src/chat/provider-discovery.ts) —
 * inlined here so chat-solid doesn't depend on daemon types directly.
 */
export interface ProviderInfo {
  kind: "claude-code" | "codex" | "gemini" | (string & {});
  name: string;
  description: string;
  available: boolean;
  binary?: string;
  version?: string;
  error?: string;
}

/**
 * Discovery of provider binaries on PATH. Used by ProviderStatusBanner
 * to surface availability problems (red dot + retry) and by
 * ProviderModelPicker to populate its dropdown.
 *
 * The daemon's discovery endpoint is REST, not an action, so this
 * helper goes through plain fetch rather than `postAction`.
 */
export async function chatProvidersList(
  runtime: ApiRuntime,
): Promise<{ providers: ProviderInfo[] }> {
  const url = `${runtime.apiBaseUrl}/api/chat/providers`;
  const headers: Record<string, string> = {};
  if (runtime.bearerToken) headers["Authorization"] = `Bearer ${runtime.bearerToken}`;
  const res = await fetch(url, { cache: "no-store", headers });
  if (!res.ok) {
    throw new ChatSolidApiError(
      `Failed to fetch providers (HTTP ${res.status})`,
      "providers_fetch_failed",
    );
  }
  const data = (await res.json()) as { providers?: ProviderInfo[] };
  return { providers: Array.isArray(data.providers) ? data.providers : [] };
}

export async function fetchProjectPanes(
  runtime: ApiRuntime,
  sessionName: string,
): Promise<ComposerTerminalPane[]> {
  const headers = new Headers();
  if (runtime.bearerToken) headers.set("Authorization", `Bearer ${runtime.bearerToken}`);
  const res = await fetch(
    `${runtime.apiBaseUrl}/api/project/${encodeURIComponent(sessionName)}/panes`,
    {
      headers,
      cache: "no-store",
    },
  );

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // handled below
  }

  if (
    !res.ok ||
    !body ||
    typeof body !== "object" ||
    !Array.isArray((body as { panes?: unknown }).panes)
  ) {
    throw new ChatSolidApiError(`Unable to load panes for session "${sessionName}"`, "internal", {
      status: res.status,
    });
  }

  return ((body as { panes: ProjectPane[] }).panes ?? []).map((pane) => ({
    paneId: pane.id,
    paneTitle: pane.title || pane.id,
    sessionName,
    currentCommand: pane.currentCommand,
  }));
}

export function withAuthQuery(url: string, bearerToken: string | null): string {
  if (!bearerToken) return url;
  const parsed = new URL(url, window.location.href);
  if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", bearerToken);
  return parsed.toString();
}
