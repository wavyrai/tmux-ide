/**
 * ChatView — Solid-native host for `@tmux-ide/chat-solid`.
 *
 * Resolves a real threadId before mounting chat-solid: lists existing
 * threads and reuses the most recent, or creates a fresh one with the
 * default provider. Mounting chat-solid with an empty threadId
 * triggers `chat.thread.get` against `id: ""`, which the daemon's Zod
 * schema rejects with `Input failed schema validation`.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { mount, type ChatHandle } from "@tmux-ide/chat-solid";
import { API_BASE } from "@/lib/api";
import { resolveAuthToken, withWsBase } from "@/lib/appProtocol";

interface ChatViewProps {
  projectName: string;
  /** Optional explicit thread id (e.g. selected from a future ChatRail). */
  threadId?: string;
}

interface ActionOkEnvelope<T> {
  ok: true;
  result: T;
}
interface ActionErrEnvelope {
  ok: false;
  error: { code: string; message: string };
}

async function postAction<T>(name: string, input: unknown): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = resolveAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API_BASE}/api/v2/action/${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    cache: "no-store",
  });
  const body = (await res.json()) as ActionOkEnvelope<T> | ActionErrEnvelope;
  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function resolveThreadId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { threads } = await postAction<{
    threads: Array<{ id: string; updatedAt?: string }>;
  }>("chat.thread.list", {});
  if (threads.length > 0) {
    const sorted = [...threads].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    return sorted[0]!.id;
  }
  const { thread } = await postAction<{ thread: { id: string } }>("chat.thread.create", {
    provider: { kind: "claude-code" },
  });
  return thread.id;
}

type ErrorKind = "offline" | "daemon";

interface ErrorState {
  kind: ErrorKind;
  detail: string;
}

function classifyError(err: unknown): ErrorState {
  const message = err instanceof Error ? err.message : String(err);
  // `fetch` rejects with a TypeError on connection failure (DNS / connection
  // refused / CORS) — those never reached the daemon. Anything else came
  // back through it (Zod failure, missing provider, etc.).
  const offline = err instanceof TypeError || /failed to fetch/i.test(message);
  return { kind: offline ? "offline" : "daemon", detail: message };
}

export function ChatView(props: ChatViewProps) {
  let container!: HTMLDivElement;
  let handle: ChatHandle | null = null;
  const [error, setError] = createSignal<ErrorState | null>(null);
  const [ready, setReady] = createSignal(false);
  const [attempting, setAttempting] = createSignal(false);
  let cancelled = false;

  async function connect(): Promise<void> {
    setAttempting(true);
    setError(null);
    try {
      const id = await resolveThreadId(props.threadId);
      if (cancelled) return;
      handle?.unmount();
      handle = mount(container, {
        threadId: id,
        sessionName: props.projectName,
        apiBaseUrl: API_BASE,
        wsUrl: withWsBase("/ws"),
        bearerToken: resolveAuthToken(),
      });
      setReady(true);
    } catch (err) {
      if (!cancelled) setError(classifyError(err));
    } finally {
      if (!cancelled) setAttempting(false);
    }
  }

  onMount(() => {
    void connect();
  });

  onCleanup(() => {
    cancelled = true;
    handle?.unmount();
    handle = null;
  });

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Show when={!ready() && !error()}>
        <div class="flex h-full min-h-0 items-center justify-center text-[13px] text-[var(--fg-secondary)]">
          Loading chat…
        </div>
      </Show>
      <Show when={error()}>
        {(e) => (
          <div
            data-testid="v2-chat-error"
            data-chat-error-kind={e().kind}
            class="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center text-[var(--fg-secondary)]"
          >
            <div class="text-[13px] font-medium text-[var(--fg)]">
              {e().kind === "offline" ? "Couldn't reach the daemon" : "Couldn't start chat"}
            </div>
            <div class="max-w-md text-[12px] leading-relaxed">
              {e().kind === "offline"
                ? "The chat surface needs the tmux-ide daemon running. Start it with tmux-ide command-center, then retry."
                : "The daemon answered but didn't return a thread. Retry to try a fresh one."}
            </div>
            <button
              type="button"
              data-testid="v2-chat-retry"
              disabled={attempting()}
              onClick={() => void connect()}
              class="mt-1 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[11px] text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {attempting() ? "Retrying…" : "Try again"}
            </button>
            <details class="text-[10px] text-[var(--dim)]">
              <summary class="cursor-pointer">technical detail</summary>
              <code class="mt-1 block whitespace-pre-wrap font-mono">{e().detail}</code>
            </details>
          </div>
        )}
      </Show>
      <div
        ref={container}
        data-testid="v2-chat-view"
        class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
        style={{ display: ready() ? "flex" : "none" }}
      />
    </div>
  );
}
