/**
 * ChatView — Solid-native host for `@tmux-ide/chat-solid` with a
 * t3-style multi-thread rail.
 *
 * The rail lists every thread tagged with the current project's
 * workspace dir (sorted by `updatedAt` desc), supports create /
 * rename / delete, and persists the last selected thread per project
 * in localStorage so a reload restores it. Selecting a thread does a
 * clean keyed remount of the chat-solid surface against the new
 * `threadId` — no full page reload, and no client-side message
 * reduction (the server-materialized core from f0d048c owns the
 * timeline).
 *
 * Live rail updates ride the daemon's `chat.thread.index` WS frame:
 * any title/updatedAt change re-sorts and re-labels the rail without
 * a manual refresh.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { mount, type ChatHandle } from "@tmux-ide/chat-solid";
import { API_BASE } from "@/lib/api";
import { resolveAuthToken, withWsBase } from "@/lib/appProtocol";
import { highlightFences } from "@/lib/syntax/markdownShiki";

interface ChatViewProps {
  projectName: string;
  /** Optional explicit thread id — selected on first load if present. */
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

interface ThreadRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
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

async function resolveProjectDir(projectName: string): Promise<string | null> {
  // The session/registry endpoint surfaces the workspace's absolute
  // dir alongside its name. We use it to scope chat threads to a
  // single project — without this, `chat.thread.list({})` returned
  // every thread across every project and the dashboard mounted the
  // first one regardless of which project was open.
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
    const body = (await res.json()) as { sessions?: Array<{ name: string; dir?: string }> };
    const session = body.sessions?.find((s) => s.name === projectName);
    if (session?.dir) return session.dir;
  } catch {
    // fallthrough to projects registry
  }
  try {
    const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(projectName)}`, {
      cache: "no-store",
    });
    const body = (await res.json()) as { project?: { dir?: string } };
    if (body.project?.dir) return body.project.dir;
  } catch {
    // give up — chat falls back to the global (untagged) thread view.
  }
  return null;
}

function sortThreads(rows: ReadonlyArray<ThreadRow>): ThreadRow[] {
  return [...rows].sort((a, b) => {
    const byUpdated = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
    if (byUpdated !== 0) return byUpdated;
    const byCreated = (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    if (byCreated !== 0) return byCreated;
    return a.id.localeCompare(b.id);
  });
}

function toRow(t: {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}): ThreadRow {
  return {
    id: t.id,
    title: (t.title ?? "").trim() || "New chat",
    createdAt: t.createdAt ?? "",
    updatedAt: t.updatedAt ?? t.createdAt ?? "",
  };
}

function lastThreadStorageKey(projectDir: string | null): string {
  return `tmux-ide:chat:last-thread:${projectDir ?? "__global__"}`;
}

function readLastThreadId(projectDir: string | null): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(lastThreadStorageKey(projectDir));
  } catch {
    return null;
  }
}

function writeLastThreadId(projectDir: string | null, id: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    const key = lastThreadStorageKey(projectDir);
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    /* quota / privacy mode — silently no-op */
  }
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 45_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

type ErrorKind = "offline" | "daemon";

interface ErrorState {
  kind: ErrorKind;
  detail: string;
}

function classifyError(err: unknown): ErrorState {
  const message = err instanceof Error ? err.message : String(err);
  // `fetch` rejects with a TypeError on connection failure (DNS /
  // connection refused / CORS) — those never reached the daemon.
  // Anything else came back through it (Zod failure, etc.).
  const offline = err instanceof TypeError || /failed to fetch/i.test(message);
  return { kind: offline ? "offline" : "daemon", detail: message };
}

export function ChatView(props: ChatViewProps) {
  let container!: HTMLDivElement;
  let handle: ChatHandle | null = null;
  let socket: WebSocket | null = null;
  let cancelled = false;

  const [projectDir, setProjectDir] = createSignal<string | null>(null);
  const [threads, setThreads] = createSignal<ThreadRow[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<ErrorState | null>(null);
  const [attempting, setAttempting] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null);

  const sorted = createMemo(() => sortThreads(threads()));

  function selectThread(id: string | null): void {
    setSelectedId(id);
    writeLastThreadId(projectDir(), id);
  }

  /** Pick the next thread after the current list changes (delete /
   *  external removal): keep the selection if it still exists, else
   *  fall to the most-recent thread, else clear (→ empty state). */
  function reconcileSelection(rows: ThreadRow[]): void {
    const current = selectedId();
    if (current && rows.some((t) => t.id === current)) return;
    const next = sortThreads(rows)[0]?.id ?? null;
    selectThread(next);
  }

  async function loadThreads(): Promise<ThreadRow[]> {
    const dir = projectDir();
    const listInput = dir ? { projectDir: dir } : {};
    const { threads: list } = await postAction<{ threads: ThreadRow[] }>(
      "chat.thread.list",
      listInput,
    );
    return list.map(toRow);
  }

  async function init(): Promise<void> {
    setAttempting(true);
    setError(null);
    try {
      const dir = await resolveProjectDir(props.projectName);
      if (cancelled) return;
      setProjectDir(dir);
      const rows = await loadThreads();
      if (cancelled) return;
      setThreads(rows);

      // Restore order of preference: explicit prop → persisted
      // last-selected (if still present) → most-recent thread.
      const persisted = readLastThreadId(dir);
      const initial =
        (props.threadId && rows.some((t) => t.id === props.threadId) ? props.threadId : null) ??
        (persisted && rows.some((t) => t.id === persisted) ? persisted : null) ??
        sortThreads(rows)[0]?.id ??
        null;
      selectThread(initial);
      setLoading(false);
      openIndexSocket();
    } catch (err) {
      if (!cancelled) {
        setError(classifyError(err));
        setLoading(false);
      }
    } finally {
      if (!cancelled) setAttempting(false);
    }
  }

  /** Live rail: the daemon broadcasts the full thread index on every
   *  lifecycle transition (create / rename / delete / message). We
   *  filter to this project's dir and replace the rail wholesale so
   *  titles + ordering stay current without a manual refresh. */
  function openIndexSocket(): void {
    if (cancelled || socket) return;
    let url: string;
    try {
      url = withWsBase("/ws/events");
    } catch {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if ((frame as { type?: string }).type !== "chat.thread.index") return;
      const raw = (frame as { threads?: Array<Record<string, unknown>> }).threads;
      if (!Array.isArray(raw)) return;
      const dir = projectDir();
      const rows = raw
        // Mirror `chat.thread.list`: project-scoped when we resolved a
        // dir, otherwise the unfiltered (legacy global) view.
        .filter((t) => (dir ? t.projectDir === dir : true))
        .map((t) =>
          toRow({
            id: String(t.id),
            title: typeof t.title === "string" ? t.title : undefined,
            createdAt: typeof t.createdAt === "string" ? t.createdAt : undefined,
            updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : undefined,
          }),
        );
      setThreads(rows);
      reconcileSelection(rows);
    });
    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  async function createThread(): Promise<void> {
    if (creating()) return;
    setCreating(true);
    try {
      const dir = projectDir();
      const input: { provider: { kind: string }; projectDir?: string } = {
        provider: { kind: "claude-code" },
      };
      if (dir) input.projectDir = dir;
      const { thread } = await postAction<{ thread: ThreadRow }>("chat.thread.create", input);
      if (cancelled) return;
      const row = toRow(thread);
      setThreads((prev) => [row, ...prev.filter((t) => t.id !== row.id)]);
      selectThread(row.id);
    } catch (err) {
      if (!cancelled) setError(classifyError(err));
    } finally {
      if (!cancelled) setCreating(false);
    }
  }

  function beginRename(row: ThreadRow): void {
    setRenamingId(row.id);
    setRenameDraft(row.title);
    setConfirmDeleteId(null);
  }

  async function commitRename(id: string): Promise<void> {
    const title = renameDraft().trim();
    setRenamingId(null);
    const current = threads().find((t) => t.id === id);
    if (!title || !current || title === current.title) return;
    // Optimistic — the WS index event will reconcile authoritatively.
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    try {
      await postAction("chat.thread.rename", { id, title });
    } catch (err) {
      if (!cancelled) setError(classifyError(err));
    }
  }

  async function deleteThread(id: string): Promise<void> {
    setConfirmDeleteId(null);
    const remaining = threads().filter((t) => t.id !== id);
    setThreads(remaining);
    reconcileSelection(remaining);
    try {
      await postAction("chat.thread.delete", { id });
    } catch (err) {
      if (!cancelled) setError(classifyError(err));
    }
  }

  // Keyed remount: a fresh chat-solid surface per selected thread.
  // chat-solid exposes `setThreadId`, but a clean unmount/mount keeps
  // the server-materialized renderer from carrying any prior thread's
  // transient state across the switch.
  createEffect(
    on(selectedId, (id) => {
      handle?.unmount();
      handle = null;
      if (!id || !container) return;
      handle = mount(container, {
        threadId: id,
        sessionName: props.projectName,
        apiBaseUrl: API_BASE,
        wsUrl: withWsBase("/ws/events"),
        bearerToken: resolveAuthToken(),
        highlightCodeFences: highlightFences,
        onDelete: (threadId) => setConfirmDeleteId(threadId),
      });
    }),
  );

  onMount(() => {
    void init();
  });

  onCleanup(() => {
    cancelled = true;
    handle?.unmount();
    handle = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
  });

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 flex-1">
      <aside class="flex h-full w-60 min-w-[15rem] flex-shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
        <div class="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3">
          <span class="text-[12px] font-medium text-[var(--fg)]">Chats</span>
          <button
            type="button"
            data-testid="v2-chat-new"
            disabled={creating() || loading()}
            onClick={() => void createThread()}
            class="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title="New chat"
          >
            {creating() ? "…" : "+ New"}
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto py-1">
          <Show
            when={sorted().length > 0}
            fallback={
              <div class="px-3 py-4 text-[11px] leading-relaxed text-[var(--dim)]">
                {loading() ? "Loading…" : "No chats yet."}
              </div>
            }
          >
            <For each={sorted()}>
              {(row) => {
                const isActive = () => row.id === selectedId();
                const isRenaming = () => row.id === renamingId();
                const isConfirming = () => row.id === confirmDeleteId();
                return (
                  <div
                    data-testid="v2-chat-thread-row"
                    data-active={isActive() ? "true" : "false"}
                    class="group mx-1 mb-0.5 rounded px-2 py-1.5 transition-colors"
                    classList={{
                      "bg-[var(--surface-active)] text-[var(--fg)]": isActive(),
                      "text-[var(--fg-secondary)] hover:bg-[var(--surface)]": !isActive(),
                    }}
                  >
                    <Show
                      when={isRenaming()}
                      fallback={
                        <button
                          type="button"
                          class="block w-full cursor-pointer text-left"
                          onClick={() => selectThread(row.id)}
                          ondblclick={() => beginRename(row)}
                        >
                          <span class="block truncate text-[12px]">{row.title}</span>
                          <span class="mt-0.5 block text-[10px] text-[var(--dim)]">
                            {formatRelative(row.updatedAt)}
                          </span>
                        </button>
                      }
                    >
                      <input
                        class="w-full rounded border border-[var(--accent)] bg-[var(--bg)] px-1 py-0.5 text-[12px] text-[var(--fg)] outline-none"
                        value={renameDraft()}
                        onInput={(e) => setRenameDraft(e.currentTarget.value)}
                        onBlur={() => void commitRename(row.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(row.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        autofocus
                      />
                    </Show>
                    <Show when={!isRenaming()}>
                      <div
                        class="mt-1 flex items-center gap-2 transition-opacity group-hover:opacity-100"
                        classList={{
                          "opacity-100": isActive() || isConfirming(),
                          "opacity-0": !isActive() && !isConfirming(),
                        }}
                      >
                        <Show
                          when={!isConfirming()}
                          fallback={
                            <>
                              <span class="text-[10px] text-[var(--dim)]">Delete?</span>
                              <button
                                type="button"
                                data-testid="v2-chat-thread-delete-confirm"
                                class="text-[10px] text-[var(--red)] hover:underline"
                                onClick={() => void deleteThread(row.id)}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                class="text-[10px] text-[var(--dim)] hover:underline"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                No
                              </button>
                            </>
                          }
                        >
                          <button
                            type="button"
                            data-testid="v2-chat-thread-rename"
                            class="text-[10px] text-[var(--dim)] hover:text-[var(--accent)]"
                            onClick={() => beginRename(row)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            data-testid="v2-chat-thread-delete"
                            class="text-[10px] text-[var(--dim)] hover:text-[var(--red)]"
                            onClick={() => {
                              setConfirmDeleteId(row.id);
                              setRenamingId(null);
                            }}
                          >
                            Delete
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </aside>

      <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <Show when={loading() && !error()}>
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
                {e().kind === "offline" ? "Couldn't reach the daemon" : "Couldn't load chat"}
              </div>
              <div class="max-w-md text-[12px] leading-relaxed">
                {e().kind === "offline"
                  ? "The chat surface needs the tmux-ide daemon running. Start it with tmux-ide command-center, then retry."
                  : "The daemon answered with an error. Retry to try again."}
              </div>
              <button
                type="button"
                data-testid="v2-chat-retry"
                disabled={attempting()}
                onClick={() => void init()}
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
        <Show when={!loading() && !error() && !selectedId()}>
          <div
            data-testid="v2-chat-empty"
            class="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <div class="text-[15px] font-medium text-[var(--fg)]">Pick a thread to continue</div>
            <div class="max-w-sm text-[12px] leading-relaxed text-[var(--fg-secondary)]">
              Select an existing chat from the rail, or start a new one to get going.
            </div>
            <button
              type="button"
              data-testid="v2-chat-empty-new"
              disabled={creating()}
              onClick={() => void createThread()}
              class="mt-1 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[12px] text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creating() ? "Creating…" : "New chat"}
            </button>
          </div>
        </Show>
        <div
          ref={container}
          data-testid="v2-chat-view"
          class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
          style={{
            display: !loading() && !error() && selectedId() ? "flex" : "none",
          }}
        />
      </div>
    </div>
  );
}
