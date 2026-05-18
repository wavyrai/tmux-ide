import type {
  AgentProvider,
  ChatThreadUsageSummary,
  ComposerTerminalPane,
  ContentBlock,
  MessagesTimelineRow,
  ProposedPlanSummary,
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

export function chatThreadGet(
  runtime: ApiRuntime,
  id: string,
): Promise<{ thread: ThreadState; timeline?: MessagesTimelineRow[] }> {
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

/**
 * Edit a prior user turn in place: the daemon cancels any live
 * session, truncates the thread back to (and including) the targeted
 * user message, then dispatches the replacement content as a fresh
 * turn. Returns the new prompt id + how many trailing messages were
 * dropped so the caller can reconcile its local store.
 */
export function chatSessionEditFromTurn(
  runtime: ApiRuntime,
  threadId: string,
  userMessageId: string,
  content: ContentBlock[],
): Promise<{ accepted: true; promptId: string; truncatedCount: number }> {
  return postAction(runtime, "chat.session.editFromTurn", {
    threadId,
    userMessageId,
    content,
  });
}

/**
 * Create a fresh thread. Used by the "Implement plan in a new thread"
 * action to spin up a sibling thread under the same project/provider
 * before seeding it with the implementation prompt.
 */
export function chatThreadCreate(
  runtime: ApiRuntime,
  input: { provider: AgentProvider; projectDir?: string; title?: string },
): Promise<{ thread: ThreadState }> {
  return postAction(runtime, "chat.thread.create", input);
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

/**
 * Plan store routes.
 *
 * The daemon exposes these as REST endpoints (not actions) under
 * `/api/threads/:threadId/plans` — list, approve, reject. Modify
 * doesn't exist on the daemon yet (see audit §4 D3); chat-solid
 * surfaces a "modify" affordance that prefills the composer with the
 * plan markdown instead, so the user can edit + send manually.
 */

function planHeaders(runtime: ApiRuntime, contentType = false): Headers {
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", "application/json");
  if (runtime.bearerToken) headers.set("Authorization", `Bearer ${runtime.bearerToken}`);
  return headers;
}

export async function chatPlanList(
  runtime: ApiRuntime,
  threadId: string,
): Promise<{ plans: ProposedPlanSummary[] }> {
  const url = `${runtime.apiBaseUrl}/api/threads/${encodeURIComponent(threadId)}/plans`;
  const res = await fetch(url, { headers: planHeaders(runtime), cache: "no-store" });
  if (!res.ok) {
    throw new ChatSolidApiError(`Failed to fetch plans (HTTP ${res.status})`, "plan_fetch_failed", {
      status: res.status,
    });
  }
  const data = (await res.json()) as { plans?: ProposedPlanSummary[] };
  return { plans: Array.isArray(data.plans) ? data.plans : [] };
}

export async function chatPlanApprove(
  runtime: ApiRuntime,
  threadId: string,
  planId: string,
): Promise<{ plan: ProposedPlanSummary; turnId: string }> {
  const url = `${runtime.apiBaseUrl}/api/threads/${encodeURIComponent(threadId)}/plans/${encodeURIComponent(planId)}/approve`;
  const res = await fetch(url, {
    method: "POST",
    headers: planHeaders(runtime, true),
    body: JSON.stringify({}),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: { error?: string; code?: string } | null = null;
    try {
      detail = (await res.json()) as { error?: string; code?: string };
    } catch {
      // ignore — fall back to generic message
    }
    throw new ChatSolidApiError(
      detail?.error ?? `Failed to approve plan (HTTP ${res.status})`,
      detail?.code ?? "plan_approve_failed",
      { status: res.status },
    );
  }
  return (await res.json()) as { plan: ProposedPlanSummary; turnId: string };
}

export async function chatPlanReject(
  runtime: ApiRuntime,
  threadId: string,
  planId: string,
  reason?: string,
): Promise<{ plan: ProposedPlanSummary }> {
  const url = `${runtime.apiBaseUrl}/api/threads/${encodeURIComponent(threadId)}/plans/${encodeURIComponent(planId)}/reject`;
  const body = reason !== undefined ? { reason } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: planHeaders(runtime, true),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    let detail: { error?: string; code?: string } | null = null;
    try {
      detail = (await res.json()) as { error?: string; code?: string };
    } catch {
      // ignore
    }
    throw new ChatSolidApiError(
      detail?.error ?? `Failed to reject plan (HTTP ${res.status})`,
      detail?.code ?? "plan_reject_failed",
      { status: res.status },
    );
  }
  return (await res.json()) as { plan: ProposedPlanSummary };
}

export function withAuthQuery(url: string, bearerToken: string | null): string {
  if (!bearerToken) return url;
  const parsed = new URL(url, window.location.href);
  if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", bearerToken);
  return parsed.toString();
}
