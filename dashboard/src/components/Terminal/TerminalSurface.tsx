/**
 * TerminalSurface — the multi-terminal panel.
 *
 * The rail mirrors `ChatView.tsx`'s thread rail 1:1 (vertical aside,
 * "+ New" button, double-click rename, hover Rename / Delete with
 * inline Yes/No confirm, active highlight, per-project localStorage
 * for the last selected tab) so the multi-{chat,terminal} UX feels
 * identical across the two surfaces.
 *
 * Project cwd: the surface resolves the workspace dir for
 * `projectName` (via the same /api/sessions → /api/projects/:name
 * fallback ChatView uses) and threads it into every PtyPane's
 * FrontendPty connect options as `cwd`. The daemon ws-route forwards
 * the init frame's `cwd` to node-pty's spawn options, so each PTY
 * starts in the project directory instead of the daemon's cwd.
 *
 * Delegates to:
 *   - `useTerminals(sessionName)` from `lib/pty/registry.ts` for the
 *     canonical list (daemon source of truth).
 *   - `createTerminal / renameTerminal / deleteTerminal` for mutations.
 *   - `<PtyPane sessionId={activeId} options={{cwd}} />` to render
 *     the visible terminal.
 *
 * No xterm work happens in this component — that lives in PtyPane.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Effect, Exit, Cause } from "effect";
import type { TerminalWithRuntime } from "@tmux-ide/contracts";
import {
  createTerminal,
  defaultShellTerminalId,
  deleteTerminal,
  renameTerminal,
  useTerminals,
} from "@/lib/pty/registry";
import { releaseSession } from "@/lib/pty/sessionPool";
import { PaneSizingProvider } from "@/lib/pty/PaneSizingContext";
import {
  detectIsMacPlatform,
  resolveTabIndexShortcut,
  shouldCloseCurrentTab,
  shouldOpenNewTab,
} from "@/lib/pty/tabKeybindings";
import { API_BASE } from "@/lib/api";
import { PtyPane } from "./PtyPane";

interface TerminalSurfaceProps {
  /** tmux-ide session name. Also used as the storage namespace for
   *  the active-tab persistence. */
  projectName: string;
  /** Optional cwd override. When omitted the surface resolves the
   *  workspace dir for `projectName` itself; the override is mostly
   *  there for tests that want a deterministic cwd without mocking
   *  the discovery endpoints. */
  cwd?: string;
}

const ACTIVE_STORAGE_PREFIX = "tmux-ide.terminal.active.";

function readActiveId(projectName: string): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_STORAGE_PREFIX + projectName);
  } catch {
    return null;
  }
}

function writeActiveId(projectName: string, id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_STORAGE_PREFIX + projectName, id);
  } catch {
    // localStorage may be denied — non-fatal.
  }
}

/**
 * Resolve the workspace directory for a project. Mirrors the lookup
 * ChatView uses so terminals and chat agree on what "this project's
 * dir" means.
 */
async function resolveProjectDir(projectName: string): Promise<string | null> {
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
    // give up — terminal spawns without an explicit cwd; daemon falls
    // back to its own working directory.
  }
  return null;
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  const sessionAccessor = () => props.projectName;
  const terminals = useTerminals(sessionAccessor);

  // Resolve once per projectName change. The override prop wins so
  // tests can pin a deterministic cwd; otherwise we hit the daemon's
  // discovery endpoints (same path ChatView uses).
  const [resolvedDir] = createResource(sessionAccessor, async (name) => {
    if (props.cwd) return props.cwd;
    return resolveProjectDir(name);
  });

  /** The cwd we hand to a freshly-spawning PTY. `props.cwd` overrides
   *  the resolver; otherwise we use the resolved workspace dir. May
   *  be undefined while the resource is still loading — PtyPane only
   *  forwards `cwd` to the init frame when it's a string. */
  const effectiveCwd = (): string | undefined => props.cwd ?? resolvedDir() ?? undefined;

  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renamingValue, setRenamingValue] = createSignal("");
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let seededDefault = false;

  // Drive active-tab selection from the resource. First-arrival reads
  // the persisted id from localStorage; later changes only override
  // when the current id has vanished from the list.
  createEffect(() => {
    const list = terminals();
    if (!list) return;
    if (list.length === 0) {
      // Empty list → seed the deterministic default shell tab once.
      if (seededDefault) return;
      seededDefault = true;
      void seedDefaultShell();
      return;
    }
    const current = activeId();
    if (current && list.some((t) => t.id === current)) return;
    const stored = readActiveId(props.projectName);
    const next = stored && list.some((t) => t.id === stored) ? stored : list[0]!.id;
    setActiveId(next);
    writeActiveId(props.projectName, next);
  });

  function scopeForCreate(): string {
    // Scope the deterministic-id for the default shell tab by cwd
    // when we have one; otherwise fall back to the project name so
    // pre-resolve tabs still produce a stable id.
    return effectiveCwd() ?? props.projectName;
  }

  async function seedDefaultShell() {
    const id = await defaultShellTerminalId({
      projectId: props.projectName,
      scopeId: scopeForCreate(),
    });
    const created = await runEffect(
      createTerminal(props.projectName, {
        id,
        scopeId: scopeForCreate(),
        name: "shell",
        kind: "shell",
        script: "$SHELL -l",
      }),
    );
    if (created) {
      await terminals.refetch();
      setActiveId(created.id);
      writeActiveId(props.projectName, created.id);
    }
  }

  let surfaceRoot!: HTMLDivElement;
  const isMacPlatform = detectIsMacPlatform();

  onMount(() => {
    // Fire an explicit refetch so the createResource baseline is
    // current even if the URL/session prop didn't change. Matches the
    // bridge pattern used elsewhere in the dashboard.
    void terminals.refetch();

    // Tab keybinds — scoped to the surface root so Cmd+T / Cmd+W
    // outside the panel still hit their global handlers (e.g. the
    // browser's "new tab" gets Cmd+T when the user clicked away).
    const onKeyDown = (e: KeyboardEvent) => {
      const focus = document.activeElement as Node | null;
      if (!focus || !surfaceRoot.contains(focus)) return;
      if (shouldOpenNewTab(e, isMacPlatform)) {
        e.preventDefault();
        void handleNewTab();
        return;
      }
      if (shouldCloseCurrentTab(e, isMacPlatform)) {
        // Don't close while inline-renaming — Cmd+W during a rename
        // should commit/cancel via the input handler instead.
        if (renaming()) return;
        const id = activeId();
        if (!id) return;
        e.preventDefault();
        // Keybinds bypass the inline Yes/No confirm (the confirm UX
        // exists to guard against stray mouse clicks, not a chord
        // the user explicitly typed).
        void handleClose(id);
        return;
      }
      const tabIdx = resolveTabIndexShortcut(e, isMacPlatform);
      if (tabIdx !== null) {
        const list = terminals();
        if (!list) return;
        const target = list[tabIdx];
        if (!target) return;
        e.preventDefault();
        setActiveId(target.id);
        writeActiveId(props.projectName, target.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
    });
  });

  const allSessionIds = createMemo<readonly string[]>(() => (terminals() ?? []).map((t) => t.id));

  async function runEffect<T>(eff: Effect.Effect<T, unknown>): Promise<T | null> {
    setError(null);
    const exit = await Effect.runPromiseExit(eff);
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    const message =
      failure._tag === "Some" && failure.value && typeof failure.value === "object"
        ? ((failure.value as { message?: string }).message ?? "Action failed")
        : "Action failed";
    setError(message);
    return null;
  }

  async function handleNewTab() {
    if (busy()) return;
    setBusy(true);
    const list = terminals() ?? [];
    const name = `shell ${list.length + 1}`;
    const created = await runEffect(
      createTerminal(props.projectName, {
        scopeId: scopeForCreate(),
        name,
        kind: "shell",
      }),
    );
    setBusy(false);
    if (!created) return;
    await terminals.refetch();
    setActiveId(created.id);
    writeActiveId(props.projectName, created.id);
  }

  async function handleClose(id: string) {
    if (busy()) return;
    setBusy(true);
    setConfirmDeleteId(null);
    const ok = await runEffect(deleteTerminal(props.projectName, id));
    setBusy(false);
    if (ok === null) return;
    // Tear down the local session too — closes the WS + disposes xterm.
    releaseSession(id);
    if (activeId() === id) {
      setActiveId(null);
    }
    await terminals.refetch();
  }

  function startRename(t: TerminalWithRuntime) {
    setRenaming(t.id);
    setRenamingValue(t.name);
    setConfirmDeleteId(null);
  }

  async function commitRename() {
    const id = renaming();
    const name = renamingValue().trim();
    setRenaming(null);
    if (!id || !name) return;
    setBusy(true);
    await runEffect(renameTerminal(props.projectName, id, { name }));
    setBusy(false);
    await terminals.refetch();
  }

  function selectTab(id: string) {
    setActiveId(id);
    writeActiveId(props.projectName, id);
    setConfirmDeleteId(null);
  }

  const activeTerminal = createMemo<TerminalWithRuntime | null>(() => {
    const list = terminals();
    const id = activeId();
    if (!list || !id) return null;
    return list.find((t) => t.id === id) ?? null;
  });

  return (
    <div
      ref={surfaceRoot}
      tabIndex={-1}
      data-testid="terminal-surface"
      data-session-name={props.projectName}
      data-project-dir={effectiveCwd() ?? ""}
      class="flex h-full min-h-0 w-full min-w-0 flex-1 bg-[var(--bg)] text-[12px] text-[var(--fg)] focus:outline-none"
    >
      <aside
        data-testid="terminal-rail"
        class="flex h-full w-60 min-w-[15rem] flex-shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]"
      >
        <div class="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-3">
          <span class="text-[12px] font-medium text-[var(--fg)]">Terminals</span>
          <button
            type="button"
            data-testid="terminal-tab-new"
            disabled={busy()}
            onClick={() => void handleNewTab()}
            class="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-[11px] text-[var(--fg)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title="New terminal (⌘T)"
          >
            {busy() ? "…" : "+ New"}
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto py-1">
          <Show
            when={(terminals() ?? []).length > 0}
            fallback={
              <div class="px-3 py-4 text-[11px] leading-relaxed text-[var(--dim)]">
                <Show when={terminals.loading} fallback="No terminals — click + New to start one.">
                  Loading terminals…
                </Show>
              </div>
            }
          >
            <For each={terminals() ?? []}>
              {(t) => {
                const isActive = () => activeId() === t.id;
                const isRenaming = () => renaming() === t.id;
                const isConfirming = () => confirmDeleteId() === t.id;
                return (
                  <div
                    data-testid={`terminal-tab-${t.id}`}
                    data-active={isActive() ? "true" : "false"}
                    data-running={t.runtime.running ? "true" : "false"}
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
                          data-testid={`terminal-tab-label-${t.id}`}
                          class="block w-full cursor-pointer text-left"
                          onClick={() => selectTab(t.id)}
                          onDblClick={() => startRename(t)}
                          title={t.name}
                        >
                          <span class="block truncate text-[12px]">
                            <Show when={t.runtime.running}>
                              <span
                                aria-hidden="true"
                                class="mr-1 text-[var(--accent)]"
                                title="running"
                              >
                                ●
                              </span>
                            </Show>
                            {t.name}
                          </span>
                        </button>
                      }
                    >
                      <input
                        type="text"
                        data-testid={`terminal-tab-rename-${t.id}`}
                        class="w-full rounded border border-[var(--accent)] bg-[var(--bg)] px-1 py-0.5 text-[12px] text-[var(--fg)] outline-none"
                        value={renamingValue()}
                        onInput={(e) => setRenamingValue(e.currentTarget.value)}
                        onBlur={() => void commitRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitRename();
                          } else if (e.key === "Escape") {
                            setRenaming(null);
                          }
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
                              <span class="text-[10px] text-[var(--dim)]">Close?</span>
                              <button
                                type="button"
                                data-testid={`terminal-tab-delete-confirm-${t.id}`}
                                class="text-[10px] text-[var(--red,#f55)] hover:underline"
                                onClick={() => void handleClose(t.id)}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                data-testid={`terminal-tab-delete-cancel-${t.id}`}
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
                            data-testid={`terminal-tab-rename-button-${t.id}`}
                            class="text-[10px] text-[var(--dim)] hover:text-[var(--accent)]"
                            onClick={() => startRename(t)}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            data-testid={`terminal-tab-close-${t.id}`}
                            class="text-[10px] text-[var(--dim)] hover:text-[var(--red,#f55)]"
                            onClick={() => {
                              setConfirmDeleteId(t.id);
                              setRenaming(null);
                            }}
                            disabled={busy()}
                            aria-label={`Close ${t.name}`}
                          >
                            Close
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
          <Show when={error()}>
            <div
              data-testid="terminal-surface-error"
              class="mx-1 mt-2 truncate rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[10px] text-[var(--danger,#d34)]"
            >
              {error()}
            </div>
          </Show>
        </div>
      </aside>

      <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <PaneSizingProvider paneId={`terminals-${props.projectName}`} sessionIds={allSessionIds()}>
          <Show
            when={activeTerminal()}
            fallback={
              <div
                data-testid="terminal-surface-empty"
                class="flex h-full items-center justify-center text-[var(--dim)]"
              >
                <Show when={terminals.loading} fallback="No terminals — click + New to start one.">
                  Loading terminals…
                </Show>
              </div>
            }
          >
            {(t) => (
              <PtyPane
                sessionId={t().id}
                options={{
                  ...(effectiveCwd() ? { cwd: effectiveCwd() } : {}),
                  // Default shell tab gets `$SHELL -l`; named tabs
                  // leave cmd unset so the daemon picks the user's
                  // login shell.
                  ...(t().scripted && t().kind === "shell"
                    ? { cmd: ["sh", "-c", "$SHELL -l || $SHELL"] }
                    : {}),
                }}
              />
            )}
          </Show>
        </PaneSizingProvider>
      </div>
    </div>
  );
}
