/**
 * Cmd+P (Ctrl+P on non-mac) quick-switcher overlay.
 *
 * Centered palette modal — Portal + fuzzy search input + result list.
 * Combines registered projects (`/api/projects`) with running tmux
 * sessions (`/api/sessions`), deduped by name. Last-used selections
 * are tracked in localStorage so the most recently opened projects
 * float to the top. Selecting a row navigates to `/project/<name>`.
 *
 * Owns its own keydown handler so it's reachable from any route when
 * mounted once at the app root.
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
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import { fetchProjects, fetchSessions, type RegisteredProject } from "@/lib/api";
import { projectsBusTick, useProjectsBus } from "@/lib/projectsBus";
import { registerKeybinds } from "@/lib/keybinds";

const MAX_RESULT_ROWS = 60;
const LAST_USED_KEY = "tmux-ide.v2.last-used-projects.v1";

interface SwitcherRow {
  name: string;
  dir: string;
  running: boolean;
  registered: boolean;
  branch: string | null;
  lastUsedAt: number; // 0 if never opened
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

function writeLastUsed(map: Record<string, number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_USED_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled — silent */
  }
}

/** Bump `name`'s last-used timestamp. Exported for callers that
 *  navigate into a project (e.g. the project route on mount). */
export function recordProjectOpened(name: string): void {
  const map = readLastUsed();
  map[name] = Date.now();
  writeLastUsed(map);
}

function homeCollapsed(dir: string): string {
  const home =
    typeof window !== "undefined" && (window as { __HOME__?: string }).__HOME__
      ? (window as { __HOME__?: string }).__HOME__!
      : "";
  if (home && dir.startsWith(home)) return "~" + dir.slice(home.length);
  return dir;
}

/** Lowercase substring match weighted toward the basename. */
function matchScore(query: string, row: SwitcherRow): number {
  if (!query) return 1; // everything passes when query is empty
  const q = query.toLowerCase();
  const name = row.name.toLowerCase();
  const dir = row.dir.toLowerCase();
  const basename = dir.split("/").pop() ?? "";
  if (name === q) return 1000;
  if (name.startsWith(q)) return 500;
  if (basename.startsWith(q)) return 400;
  if (name.includes(q)) return 200;
  if (basename.includes(q)) return 150;
  if (dir.includes(q)) return 50;
  return 0;
}

// Module-level open signal so non-window-key triggers (e.g. the
// top-bar click affordance) can drive the same overlay.
const [open, setOpen] = createSignal(false);

/** Open the global Cmd+P quick-switcher from anywhere. */
export function openProjectQuickSwitcher(): void {
  setOpen(true);
}

export function ProjectQuickSwitcher(): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [focusIndex, setFocusIndex] = createSignal(0);
  const [lastUsed, setLastUsed] = createSignal<Record<string, number>>(readLastUsed());
  const navigate = useNavigate();
  let inputRef: HTMLInputElement | undefined;

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

  const rows = createMemo<SwitcherRow[]>(() => {
    const byName = new Map<string, SwitcherRow>();
    const recents = lastUsed();
    for (const p of projects()) {
      byName.set(p.name, {
        name: p.name,
        dir: p.dir,
        running: false,
        registered: true,
        branch: p.gitBranch,
        lastUsedAt: recents[p.name] ?? 0,
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
          running: true,
          registered: false,
          branch: null,
          lastUsedAt: recents[s.name] ?? 0,
        });
      }
    }
    return [...byName.values()];
  });

  const filteredRows = createMemo<SwitcherRow[]>(() => {
    const q = query().trim();
    const scored = rows()
      .map((row) => ({ row, score: matchScore(q, row) }))
      .filter((entry) => entry.score > 0);
    scored.sort((a, b) => {
      // Sort by last-used desc first (when no query), then by score, then by name.
      if (!q) {
        if (a.row.lastUsedAt !== b.row.lastUsedAt) return b.row.lastUsedAt - a.row.lastUsedAt;
      } else if (a.score !== b.score) {
        return b.score - a.score;
      } else if (a.row.lastUsedAt !== b.row.lastUsedAt) {
        return b.row.lastUsedAt - a.row.lastUsedAt;
      }
      return a.row.name.localeCompare(b.row.name);
    });
    return scored.slice(0, MAX_RESULT_ROWS).map((entry) => entry.row);
  });

  // Reset focus row when filter changes.
  createEffect(() => {
    filteredRows();
    setFocusIndex(0);
  });

  // External openers (TopBar click, etc.) toggle the module-level
  // `open` signal directly; mirror the keybind's open-side bookkeeping
  // so the overlay is ready to use whether triggered by key or click.
  createEffect(() => {
    if (!open()) return;
    setQuery("");
    setLastUsed(readLastUsed());
    void refetchProjects();
    void refetchSessions();
    queueMicrotask(() => inputRef?.focus());
  });

  // Escape closes — owned locally; opens come from the keybind
  // registry (Cmd+P) and the module-level `openProjectQuickSwitcher`.
  function onWindowKey(event: KeyboardEvent): void {
    if (open() && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onWindowKey);
    const dispose = registerKeybinds({
      id: "project.quick-switcher",
      label: "Quick switch project",
      group: "Global",
      scope: "global",
      combo: { key: "p" },
      run: () => setOpen(!open()),
    });
    onCleanup(() => {
      window.removeEventListener("keydown", onWindowKey);
      dispose();
    });
  });

  function activate(row: SwitcherRow): void {
    setOpen(false);
    recordProjectOpened(row.name);
    setLastUsed(readLastUsed());
    navigate(`/project/${encodeURIComponent(row.name)}`);
  }

  function onInputKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const list = filteredRows();
      const idx = focusIndex();
      if (list[idx]) activate(list[idx]);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((i) => Math.min(filteredRows().length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    }
  }

  return (
    <Show when={open()}>
      <Portal>
        <div
          data-testid="project-quick-switcher-backdrop"
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-label="Switch project"
            data-testid="project-quick-switcher"
            class="flex w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <input
              ref={inputRef}
              data-testid="project-quick-switcher-input"
              type="text"
              placeholder="Switch project…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onInputKey}
              class="border-b border-[var(--border)] bg-transparent px-3 py-2 text-md text-[var(--fg)] outline-none"
            />
            <ul role="listbox" class="max-h-[50vh] min-h-[40px] overflow-y-auto">
              <Show
                when={filteredRows().length > 0}
                fallback={<li class="px-3 py-2 text-sm text-[var(--dim)]">No projects match.</li>}
              >
                <For each={filteredRows()}>
                  {(row, index) => {
                    const focused = () => index() === focusIndex();
                    return (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={focused()}
                          data-testid={`project-quick-switcher-row-${row.name}`}
                          data-focused={focused() ? "true" : undefined}
                          onClick={() => activate(row)}
                          onMouseEnter={() => setFocusIndex(index())}
                          class={
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-base " +
                            (focused()
                              ? "bg-[var(--surface-hover)] text-[var(--accent)]"
                              : "text-[var(--fg)] hover:bg-[var(--surface-hover)]")
                          }
                        >
                          <span
                            aria-hidden="true"
                            class={
                              "h-1.5 w-1.5 shrink-0 rounded-full " +
                              (row.running ? "bg-[var(--green,#7cb342)]" : "bg-transparent")
                            }
                            title={row.running ? "Running" : undefined}
                          />
                          <span class="truncate font-mono">{row.name}</span>
                          <Show when={row.branch}>
                            <span class="truncate text-xs text-[var(--dim)]">{row.branch}</span>
                          </Show>
                          <span class="ml-auto truncate text-xs text-[var(--dim)]">
                            {homeCollapsed(row.dir)}
                          </span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </Show>
            </ul>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
