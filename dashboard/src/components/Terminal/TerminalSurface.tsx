/**
 * TerminalSurface — the multi-terminal panel (G20-P2).
 *
 * Owns:
 *   - The tab strip across the top (name + close + "+").
 *   - The active-tab signal (persisted to localStorage so reloads
 *     land on the same tab).
 *   - The PaneSizingProvider scope so every background session in
 *     the strip gets the active pane's geometry.
 *
 * Delegates to:
 *   - `useTerminals(sessionName)` from `lib/pty/registry.ts` for the
 *     canonical list (daemon source of truth).
 *   - `createTerminal / renameTerminal / deleteTerminal` actions for
 *     mutations. The Solid resource refetches after each.
 *   - `<PtyPane sessionId={activeId} />` to render the visible
 *     terminal.
 *
 * No xterm work happens in this component — that lives in PtyPane.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Effect, Exit, Cause } from "effect";
import { Plus, X } from "lucide-solid";
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
import { PtyPane } from "./PtyPane";

interface TerminalSurfaceProps {
  /** tmux-ide session name. Also used as the storage namespace for
   *  the active-tab persistence. */
  projectName: string;
  /** Working directory the default shell tab spawns in. Defaults to
   *  the session.name — the daemon's PtyBridge falls back to cwd. */
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

export function TerminalSurface(props: TerminalSurfaceProps) {
  const sessionAccessor = () => props.projectName;
  const terminals = useTerminals(sessionAccessor);

  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renamingValue, setRenamingValue] = createSignal("");
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
    const next =
      stored && list.some((t) => t.id === stored) ? stored : list[0]!.id;
    setActiveId(next);
    writeActiveId(props.projectName, next);
  });

  async function seedDefaultShell() {
    const id = await defaultShellTerminalId({
      projectId: props.projectName,
      scopeId: props.cwd ?? props.projectName,
    });
    const created = await runEffect(
      createTerminal(props.projectName, {
        id,
        scopeId: props.cwd ?? props.projectName,
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

  const allSessionIds = createMemo<readonly string[]>(() =>
    (terminals() ?? []).map((t) => t.id),
  );

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
        scopeId: props.cwd ?? props.projectName,
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
      class="flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--bg)] text-[12px] text-[var(--fg)] focus:outline-none"
    >
      <header
        data-testid="terminal-tab-strip"
        class="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-strong)] px-2"
      >
        <For each={terminals() ?? []}>
          {(t) => {
            const isActive = () => activeId() === t.id;
            return (
              <div
                data-testid={`terminal-tab-${t.id}`}
                data-active={isActive() ? "true" : "false"}
                data-running={t.runtime.running ? "true" : "false"}
                class={
                  "group flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] " +
                  (isActive()
                    ? "bg-[var(--surface)] text-[var(--fg)]"
                    : "text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))]")
                }
              >
                <Show
                  when={renaming() === t.id}
                  fallback={
                    <button
                      type="button"
                      data-testid={`terminal-tab-label-${t.id}`}
                      onClick={() => {
                        setActiveId(t.id);
                        writeActiveId(props.projectName, t.id);
                      }}
                      onDblClick={() => startRename(t)}
                      class="max-w-32 truncate text-left"
                      title={t.name}
                    >
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
                    </button>
                  }
                >
                  <input
                    type="text"
                    data-testid={`terminal-tab-rename-${t.id}`}
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
                    class="w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1 text-[11px] text-[var(--fg)]"
                  />
                </Show>
                <button
                  type="button"
                  data-testid={`terminal-tab-close-${t.id}`}
                  onClick={() => void handleClose(t.id)}
                  disabled={busy()}
                  class="opacity-0 transition-opacity group-hover:opacity-60 hover:opacity-100"
                  aria-label={`Close ${t.name}`}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            );
          }}
        </For>
        <button
          type="button"
          data-testid="terminal-tab-new"
          onClick={() => void handleNewTab()}
          disabled={busy()}
          aria-label="New terminal"
          class="ml-1 inline-flex h-6 w-6 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] hover:text-[var(--fg)] disabled:opacity-50"
          title="New terminal (⌘T)"
        >
          <Plus size={12} aria-hidden="true" />
        </button>
        <Show when={error()}>
          <span
            data-testid="terminal-surface-error"
            class="ml-2 truncate text-[10px] text-[var(--danger,#d34)]"
          >
            {error()}
          </span>
        </Show>
      </header>

      <div class="min-h-0 flex-1">
        <PaneSizingProvider paneId={`terminals-${props.projectName}`} sessionIds={allSessionIds()}>
          <Show
            when={activeTerminal()}
            fallback={
              <div
                data-testid="terminal-surface-empty"
                class="flex h-full items-center justify-center text-[var(--dim)]"
              >
                <Show when={terminals.loading} fallback="No terminals — click + to start one.">
                  Loading terminals…
                </Show>
              </div>
            }
          >
            {(t) => (
              <PtyPane
                sessionId={t().id}
                options={{
                  cwd: props.cwd,
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
