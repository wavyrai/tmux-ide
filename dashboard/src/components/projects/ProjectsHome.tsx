/**
 * Welcome screen at `/`. Two-column layout: recently active on the
 * left, full registered list on the right. Per-row "Open" navigates
 * into `/project/:name`; per-row "Remove" calls `DELETE
 * /api/projects/:name` after a confirm. The "New project" button
 * pushes the existing /setup wizard.
 */

import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import {
  fetchProjects,
  fetchSessions,
  registerProject,
  unregisterProject,
  type RegisteredProject,
  ApiError,
} from "@/lib/api";
import { recordProjectOpened } from "@/components/projects/ProjectQuickSwitcher";
import { projectsBusTick, useProjectsBus } from "@/lib/projectsBus";

const LAST_USED_KEY = "tmux-ide.v2.last-used-projects.v1";

interface HomeRow {
  name: string;
  dir: string;
  branch: string | null;
  running: boolean;
  registered: boolean;
  lastUsedAt: number;
  registeredAt: string;
}

function readLastUsed(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAST_USED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function homeCollapsed(dir: string): string {
  // No reliable HOME inside the browser; collapse the common macOS
  // shape so the right-hand column doesn't get too wide.
  return dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

export function ProjectsHome(): JSX.Element {
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const [addOpen, setAddOpen] = createSignal(false);
  const [addDir, setAddDir] = createSignal("");
  const [addBusy, setAddBusy] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);

  useProjectsBus();

  const [projectsResource, { refetch: refetchProjects }] = createResource(
    projectsBusTick,
    async () => {
      try {
        return await Effect.runPromise(fetchProjects());
      } catch {
        return [] as readonly RegisteredProject[];
      }
    },
  );

  const [sessionsResource, { refetch: refetchSessions }] = createResource(
    projectsBusTick,
    async () => {
      try {
        return await Effect.runPromise(fetchSessions());
      } catch {
        return [] as readonly { name: string; dir: string }[];
      }
    },
  );

  const projects = (): readonly RegisteredProject[] => projectsResource() ?? [];
  const sessions = (): readonly { name: string; dir: string }[] => sessionsResource() ?? [];

  const rows = createMemo<HomeRow[]>(() => {
    const recents = readLastUsed();
    const byName = new Map<string, HomeRow>();
    for (const p of projects()) {
      byName.set(p.name, {
        name: p.name,
        dir: p.dir,
        branch: p.gitBranch,
        running: false,
        registered: true,
        lastUsedAt: recents[p.name] ?? 0,
        registeredAt: p.registeredAt,
      });
    }
    for (const s of sessions()) {
      const existing = byName.get(s.name);
      if (existing) {
        existing.running = true;
      } else {
        byName.set(s.name, {
          name: s.name,
          dir: s.dir,
          branch: null,
          running: true,
          registered: false,
          lastUsedAt: recents[s.name] ?? 0,
          registeredAt: "",
        });
      }
    }
    return [...byName.values()];
  });

  const recentRows = createMemo<HomeRow[]>(() => {
    return rows()
      .filter((row) => row.lastUsedAt > 0)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 6);
  });

  const allRows = createMemo<HomeRow[]>(() => {
    return [...rows()].sort((a, b) => {
      if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      if (a.registeredAt !== b.registeredAt) {
        return b.registeredAt.localeCompare(a.registeredAt);
      }
      return a.name.localeCompare(b.name);
    });
  });

  function open(name: string): void {
    recordProjectOpened(name);
    navigate(`/project/${encodeURIComponent(name)}`);
  }

  async function remove(name: string): Promise<void> {
    try {
      await Effect.runPromise(unregisterProject(name));
    } finally {
      setPendingDelete(null);
      // WS `projects.changed` will refetch; fall back to a manual
      // refetch in case the bus is down.
      void refetchProjects();
      void refetchSessions();
    }
  }

  async function addExisting(): Promise<void> {
    const dir = addDir().trim();
    if (!dir) {
      setAddError("Enter an absolute folder path.");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await Effect.runPromise(registerProject({ dir }));
      setAddDir("");
      setAddOpen(false);
      void refetchProjects();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setAddError(message);
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <div
      data-testid="projects-home"
      class="flex h-full min-h-0 w-full flex-1 flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div class="flex items-baseline gap-3">
          <h1 class="text-[15px] font-medium">tmux-ide</h1>
          <span class="text-sm text-[var(--dim)]">
            Press{" "}
            <kbd class="rounded border border-[var(--border)] px-1 py-0.5 font-mono text-xs">
              ⌘P
            </kbd>{" "}
            to switch projects
          </span>
        </div>
        <div class="flex items-center gap-2">
          <A
            href="/widgets"
            class="rounded border border-[var(--border)] px-3 py-1 text-base text-[var(--fg)] hover:bg-[var(--surface-hover)]"
            data-testid="projects-home-widgets-link"
          >
            Widgets gallery
          </A>
          <button
            type="button"
            data-testid="projects-home-add-existing"
            onClick={() => {
              setAddOpen((v) => !v);
              setAddError(null);
            }}
            class="rounded border border-[var(--border)] px-3 py-1 text-base text-[var(--fg)] hover:bg-[var(--surface-hover)]"
          >
            Add existing folder
          </button>
          <A
            href="/setup"
            class="rounded bg-[var(--accent)] px-3 py-1 text-base font-medium text-[var(--accent-fg,var(--bg))] hover:opacity-90"
            data-testid="projects-home-new"
          >
            + New project
          </A>
        </div>
      </header>
      <Show when={addOpen()}>
        <form
          data-testid="projects-home-add-form"
          class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void addExisting();
          }}
        >
          <label class="text-sm text-[var(--dim)]" for="projects-home-add-dir">
            Folder path
          </label>
          <input
            id="projects-home-add-dir"
            data-testid="projects-home-add-dir"
            type="text"
            spellcheck={false}
            placeholder="/absolute/path/to/project"
            value={addDir()}
            onInput={(e) => setAddDir(e.currentTarget.value)}
            class="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-base text-[var(--fg)] outline-none"
          />
          <button
            type="submit"
            data-testid="projects-home-add-submit"
            disabled={addBusy()}
            class="rounded bg-[var(--accent)] px-3 py-1 text-base font-medium text-[var(--accent-fg,var(--bg))] disabled:opacity-50"
          >
            {addBusy() ? "Adding…" : "Register"}
          </button>
          <button
            type="button"
            onClick={() => {
              setAddOpen(false);
              setAddDir("");
              setAddError(null);
            }}
            class="rounded px-2 py-1 text-sm text-[var(--dim)] hover:text-[var(--fg)]"
          >
            Cancel
          </button>
          <Show when={addError()}>
            <span class="text-sm text-[var(--red,#cc6666)]" role="alert">
              {addError()}
            </span>
          </Show>
        </form>
      </Show>

      <main class="grid flex-1 min-h-0 grid-cols-1 gap-6 overflow-y-auto px-6 py-6 lg:grid-cols-[minmax(260px,360px)_1fr]">
        <section class="flex flex-col gap-3" aria-labelledby="recent-heading">
          <h2
            id="recent-heading"
            class="text-xs font-medium uppercase tracking-wider text-[var(--dim)]"
          >
            Recently active
          </h2>
          <Show
            when={recentRows().length > 0}
            fallback={
              <div class="rounded border border-dashed border-[var(--border)] px-3 py-4 text-base text-[var(--dim)]">
                No recent projects yet. Open one from the list to see it here.
              </div>
            }
          >
            <ul class="flex flex-col gap-2">
              <For each={recentRows()}>
                {(row) => (
                  <li>
                    <button
                      type="button"
                      data-testid={`projects-home-recent-${row.name}`}
                      onClick={() => open(row.name)}
                      class="flex w-full flex-col gap-1 rounded border border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2 text-left hover:bg-[var(--surface-hover)]"
                    >
                      <div class="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          class={
                            "h-1.5 w-1.5 rounded-full " +
                            (row.running ? "bg-[var(--green,#7cb342)]" : "bg-[var(--dim)]/40")
                          }
                        />
                        <span class="truncate font-medium text-md">{row.name}</span>
                      </div>
                      <span class="truncate text-sm text-[var(--dim)]">
                        {homeCollapsed(row.dir)}
                      </span>
                      <Show when={row.branch}>
                        <span class="text-xs text-[var(--dim)]">{row.branch}</span>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <section class="flex flex-col gap-3" aria-labelledby="all-heading">
          <div class="flex items-baseline justify-between">
            <h2
              id="all-heading"
              class="text-xs font-medium uppercase tracking-wider text-[var(--dim)]"
            >
              All projects
            </h2>
            <span class="text-xs text-[var(--dim)]">{allRows().length} total</span>
          </div>
          <Show
            when={allRows().length > 0}
            fallback={
              <div class="rounded border border-dashed border-[var(--border)] px-6 py-12 text-center text-base text-[var(--dim)]">
                <p class="mb-3">No projects registered yet.</p>
                <A
                  href="/setup"
                  class="inline-block rounded bg-[var(--accent)] px-3 py-1 text-base font-medium text-[var(--accent-fg,var(--bg))]"
                >
                  Create your first project
                </A>
              </div>
            }
          >
            <ul class="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-strong)]">
              <For each={allRows()}>
                {(row) => (
                  <li
                    data-testid={`projects-home-row-${row.name}`}
                    class="flex items-center gap-3 px-3 py-2 hover:bg-[var(--surface-hover)]"
                  >
                    <span
                      aria-hidden="true"
                      class={
                        "h-1.5 w-1.5 shrink-0 rounded-full " +
                        (row.running ? "bg-[var(--green,#7cb342)]" : "bg-[var(--dim)]/40")
                      }
                      title={row.running ? "Running" : undefined}
                    />
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 flex-col text-left"
                      onClick={() => open(row.name)}
                    >
                      <span class="truncate font-mono text-base">{row.name}</span>
                      <span class="truncate text-xs text-[var(--dim)]">
                        {homeCollapsed(row.dir)}
                      </span>
                    </button>
                    <Show when={row.branch}>
                      <span class="hidden truncate text-xs text-[var(--dim)] sm:inline">
                        {row.branch}
                      </span>
                    </Show>
                    <Show when={row.registered}>
                      <Show
                        when={pendingDelete() === row.name}
                        fallback={
                          <button
                            type="button"
                            data-testid={`projects-home-remove-${row.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(row.name);
                            }}
                            class="rounded px-2 py-0.5 text-xs text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
                            aria-label={`Remove ${row.name} from registry`}
                          >
                            Remove
                          </button>
                        }
                      >
                        <div class="flex items-center gap-1">
                          <button
                            type="button"
                            data-testid={`projects-home-remove-confirm-${row.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(row.name);
                            }}
                            class="rounded bg-[var(--red,#cc6666)]/15 px-2 py-0.5 text-xs text-[var(--red,#cc6666)] hover:bg-[var(--red,#cc6666)]/25"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(null);
                            }}
                            class="rounded px-2 py-0.5 text-xs text-[var(--dim)] hover:bg-[var(--surface-hover)]"
                          >
                            Cancel
                          </button>
                        </div>
                      </Show>
                    </Show>
                    <button
                      type="button"
                      data-testid={`projects-home-open-${row.name}`}
                      onClick={() => open(row.name)}
                      class="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                    >
                      Open
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </main>
    </div>
  );
}
