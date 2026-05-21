/**
 * Unified Cmd+K command palette (G16-P4).
 *
 * One overlay that aggregates four item kinds into a single fuzzy-
 * filterable list:
 *
 *   • Projects        — registered workspaces (/api/projects) and
 *                       running tmux sessions (/api/sessions); selecting
 *                       navigates to /v2/project/<name>.
 *   • Chat threads    — scoped to the current project's dir (via
 *                       chat.thread.list({projectDir})); selecting
 *                       navigates to ?view=chat and persists the
 *                       picked id under the same key ChatView reads
 *                       (`tmux-ide:chat:last-thread:<dir>`).
 *   • Terminals       — useTerminals(currentProjectName); selecting
 *                       navigates to ?view=terminal and persists the
 *                       id under TerminalSurface's
 *                       `tmux-ide.terminal.active.<name>` key.
 *   • Commands        — every globally-scoped entry in the keybind
 *                       registry (`@/lib/keybinds`), so the palette
 *                       and the cheat-sheet share one source of truth.
 *
 * The existing Cmd+P project quick-switcher is intentionally LEFT
 * IN PLACE — Cmd+P is the project-scoped shortcut, Cmd+K is the
 * unified palette. Cmd+Shift+P also opens this palette to match the
 * VS Code convention.
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
import { fetchProjects, fetchSessions, type RegisteredProject, API_BASE } from "@/lib/api";
import { resolveAuthToken } from "@/lib/appProtocol";
import { allKeybinds, formatCombo, type KeybindDescriptor } from "@/lib/keybinds";
import { currentProjectName } from "@/lib/currentProject";
import { useTerminals } from "@/lib/pty/registry";
import type { TerminalWithRuntime } from "@tmux-ide/contracts";

const MAX_RESULTS_PER_GROUP = 12;

type ItemKind = "command" | "project" | "thread" | "terminal";

interface PaletteItem {
  kind: ItemKind;
  /** Stable id for keying the row. */
  id: string;
  label: string;
  /** Secondary line (path / branch / detail). */
  detail?: string;
  /** Right-aligned shortcut text (e.g. `⌘B`). */
  shortcut?: string;
  /** Lucide-style mono glyph; kept tiny so the palette stays one-line. */
  glyph: string;
  activate: () => void;
  /** Free-text body used for fuzzy filtering. */
  searchText: string;
}

interface ChatThreadIndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  projectDir?: string;
}

const [open, setOpen] = createSignal(false);

/** Open the unified palette from anywhere (top bar, palette button, etc.). */
export function openCommandPalette(): void {
  setOpen(true);
}

export function closeCommandPalette(): void {
  setOpen(false);
}

export function isCommandPaletteOpen(): boolean {
  return open();
}

interface ActionEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

async function postAction<T>(name: string, input: unknown): Promise<T | null> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = resolveAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  try {
    const res = await fetch(`${API_BASE}/api/v2/action/${encodeURIComponent(name)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const body = (await res.json()) as ActionEnvelope<T>;
    if (!body.ok || !body.result) return null;
    return body.result;
  } catch {
    return null;
  }
}

async function resolveProjectDir(name: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
    const body = (await res.json()) as { sessions?: Array<{ name: string; dir?: string }> };
    const session = body.sessions?.find((s) => s.name === name);
    if (session?.dir) return session.dir;
  } catch {
    // fall through
  }
  try {
    const res = await fetch(`${API_BASE}/api/projects/${encodeURIComponent(name)}`, {
      cache: "no-store",
    });
    const body = (await res.json()) as { project?: { dir?: string } };
    if (body.project?.dir) return body.project.dir ?? null;
  } catch {
    // give up
  }
  return null;
}

/** Lowercase substring score — same shape as ProjectQuickSwitcher. */
function matchScore(query: string, haystack: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === q) return 1000;
  if (h.startsWith(q)) return 500;
  if (h.includes(q)) return 200;
  return 0;
}

/** localStorage helpers — mirror the keys ChatView + TerminalSurface
 *  already write so a palette pick lands exactly where a manual click
 *  would have. */
const TERMINAL_ACTIVE_PREFIX = "tmux-ide.terminal.active.";
function writeActiveTerminalId(projectName: string, id: string): void {
  try {
    window.localStorage.setItem(TERMINAL_ACTIVE_PREFIX + projectName, id);
  } catch {
    /* ignore */
  }
}

function chatLastThreadKey(projectDir: string | null): string {
  return `tmux-ide:chat:last-thread:${projectDir ?? "__global__"}`;
}

function writeLastChatThread(projectDir: string | null, threadId: string): void {
  try {
    window.localStorage.setItem(chatLastThreadKey(projectDir), threadId);
  } catch {
    /* ignore */
  }
}

export function CommandPalette(): JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  const [focusIndex, setFocusIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  // Projects / sessions — loaded once per palette open.
  const [projectsResource, { refetch: refetchProjects }] = createResource(
    () => open(),
    async (isOpen) => {
      if (!isOpen) return [] as readonly RegisteredProject[];
      try {
        return await Effect.runPromise(fetchProjects());
      } catch {
        return [] as readonly RegisteredProject[];
      }
    },
  );
  const [sessionsResource, { refetch: refetchSessions }] = createResource(
    () => open(),
    async (isOpen) => {
      if (!isOpen) return [] as readonly { name: string; dir: string }[];
      try {
        return await Effect.runPromise(fetchSessions());
      } catch {
        return [] as readonly { name: string; dir: string }[];
      }
    },
  );

  // Current-project chat thread list — re-fetches on open and on
  // project change.
  const [projectDir, setProjectDir] = createSignal<string | null>(null);
  createEffect(() => {
    const name = currentProjectName();
    if (!open() || !name) {
      setProjectDir(null);
      return;
    }
    void resolveProjectDir(name).then((dir) => setProjectDir(dir));
  });

  const [threadsResource, { refetch: refetchThreads }] = createResource(
    () => (open() ? projectDir() : null),
    async (dir) => {
      if (!dir) return [] as ChatThreadIndexEntry[];
      const result = await postAction<{ threads: ChatThreadIndexEntry[] }>("chat.thread.list", {
        projectDir: dir,
      });
      return result?.threads ?? [];
    },
  );

  // Terminals scoped to the current project — reuses the live resource
  // so the palette sees the same list the rail sees.
  const terminals = useTerminals(() => (open() ? currentProjectName() : null));

  // Reset query + focus + refetch on open.
  createEffect(() => {
    if (!open()) return;
    setQuery("");
    setFocusIndex(0);
    void refetchProjects();
    void refetchSessions();
    void refetchThreads();
    void terminals.refetch();
    queueMicrotask(() => inputRef?.focus());
  });

  function gotoView(view: "chat" | "terminal" | "files" | "search"): void {
    const name = currentProjectName();
    if (!name) return;
    const target =
      view === "files"
        ? `/v2/project/${encodeURIComponent(name)}`
        : `/v2/project/${encodeURIComponent(name)}?view=${view}`;
    navigate(target);
  }

  // Build the unified item list. Commands always show; the other
  // sources gate on data availability.
  const items = createMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];

    // --- Commands (keybind registry, scope: "global") ----------------
    const commands = allKeybinds().filter((b) => b.scope === "global");
    for (const cmd of commands) {
      out.push(commandToItem(cmd));
    }
    // Two extra command entries that don't have keyboard shortcuts of
    // their own but the spec lists as palette items.
    if (currentProjectName()) {
      out.push({
        kind: "command",
        id: "cmd:new-chat",
        label: "New chat",
        glyph: "✚",
        activate: () => {
          closeCommandPalette();
          gotoView("chat");
        },
        searchText: "new chat thread",
      });
      out.push({
        kind: "command",
        id: "cmd:new-terminal",
        label: "New terminal",
        glyph: "✚",
        activate: () => {
          closeCommandPalette();
          gotoView("terminal");
        },
        searchText: "new terminal pane",
      });
    }
    out.push({
      kind: "command",
      id: "cmd:open-settings",
      label: "Open Settings",
      glyph: "⚙",
      activate: () => {
        closeCommandPalette();
        navigate("/v2/settings");
      },
      searchText: "settings preferences",
    });
    out.push({
      kind: "command",
      id: "cmd:toggle-theme",
      label: "Switch theme (light/dark)",
      glyph: "◐",
      activate: () => {
        closeCommandPalette();
        const root = document.documentElement;
        const next = root.dataset.theme === "light" ? "dark" : "light";
        root.dataset.theme = next;
        try {
          window.localStorage.setItem("tmux-ide.v2.theme", next);
        } catch {
          /* ignore */
        }
      },
      searchText: "theme dark light toggle",
    });

    // --- Projects ----------------------------------------------------
    const projectByName = new Map<string, { name: string; dir: string; branch: string | null }>();
    for (const p of projectsResource() ?? []) {
      projectByName.set(p.name, { name: p.name, dir: p.dir, branch: p.gitBranch });
    }
    for (const s of sessionsResource() ?? []) {
      if (!projectByName.has(s.name)) {
        projectByName.set(s.name, { name: s.name, dir: s.dir, branch: null });
      }
    }
    for (const p of projectByName.values()) {
      out.push({
        kind: "project",
        id: `project:${p.name}`,
        label: p.name,
        detail: p.dir,
        glyph: "▣",
        activate: () => {
          closeCommandPalette();
          navigate(`/v2/project/${encodeURIComponent(p.name)}`);
        },
        searchText: `${p.name} ${p.dir} ${p.branch ?? ""}`.toLowerCase(),
      });
    }

    // --- Chat threads (current project) ------------------------------
    const threads = threadsResource() ?? [];
    const threadDir = projectDir();
    for (const t of threads) {
      out.push({
        kind: "thread",
        id: `thread:${t.id}`,
        label: t.title.trim() || "New chat",
        detail: "Chat",
        glyph: "💬",
        activate: () => {
          // Persist BEFORE closing the palette — `closeCommandPalette()`
          // flips `open` to false, which the projectDir effect watches
          // and immediately nulls; reading `projectDir()` after would
          // route the write to the global bucket.
          writeLastChatThread(threadDir, t.id);
          closeCommandPalette();
          gotoView("chat");
        },
        searchText: `${t.title} chat thread`.toLowerCase(),
      });
    }

    // --- Terminals (current project) ---------------------------------
    const projectName = currentProjectName();
    const terms = (terminals() ?? []) as readonly TerminalWithRuntime[];
    for (const t of terms) {
      out.push({
        kind: "terminal",
        id: `terminal:${t.id}`,
        label: t.name,
        detail: t.runtime.running ? "Terminal · running" : "Terminal",
        glyph: "▶",
        activate: () => {
          if (projectName) writeActiveTerminalId(projectName, t.id);
          closeCommandPalette();
          if (projectName) gotoView("terminal");
        },
        searchText: `${t.name} terminal`.toLowerCase(),
      });
    }

    return out;
  });

  const filtered = createMemo<PaletteItem[]>(() => {
    const q = query().trim();
    if (!q) {
      // No query → cap each group so the user sees a mix.
      const grouped = new Map<ItemKind, PaletteItem[]>();
      for (const item of items()) {
        const arr = grouped.get(item.kind) ?? [];
        if (arr.length < MAX_RESULTS_PER_GROUP) {
          arr.push(item);
          grouped.set(item.kind, arr);
        }
      }
      // Preferred order: commands → projects → threads → terminals.
      return [
        ...(grouped.get("command") ?? []),
        ...(grouped.get("project") ?? []),
        ...(grouped.get("thread") ?? []),
        ...(grouped.get("terminal") ?? []),
      ];
    }
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const item of items()) {
      const score = matchScore(q, item.searchText);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item).slice(0, MAX_RESULTS_PER_GROUP * 4);
  });

  // Reset focus row when filter changes.
  createEffect(() => {
    filtered();
    setFocusIndex(0);
  });

  function onWindowKey(event: KeyboardEvent): void {
    if (!open()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPalette();
    }
  }

  onMount(() => window.addEventListener("keydown", onWindowKey));
  onCleanup(() => window.removeEventListener("keydown", onWindowKey));

  function onInputKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const list = filtered();
      const idx = focusIndex();
      const target = list[idx];
      if (target) target.activate();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocusIndex((i) => Math.min(filtered().length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocusIndex((i) => Math.max(0, i - 1));
    }
  }

  return (
    <Show when={open()}>
      <Portal>
        <div
          data-testid="command-palette-backdrop"
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCommandPalette();
          }}
        >
          <div
            role="dialog"
            aria-label="Command palette"
            data-testid="command-palette"
            class="flex w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <input
              ref={inputRef}
              data-testid="command-palette-input"
              type="text"
              placeholder="Type a command, project, chat, or terminal…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onInputKey}
              class="border-b border-[var(--border)] bg-transparent px-3 py-2 text-[13px] text-[var(--fg)] outline-none"
            />
            <ul
              role="listbox"
              data-testid="command-palette-list"
              class="max-h-[60vh] min-h-[40px] overflow-y-auto"
            >
              <Show
                when={filtered().length > 0}
                fallback={<li class="px-3 py-2 text-[11px] text-[var(--dim)]">No matches.</li>}
              >
                <For each={filtered()}>
                  {(item, index) => {
                    const focused = () => index() === focusIndex();
                    return (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={focused()}
                          data-testid={`command-palette-row-${item.id}`}
                          data-kind={item.kind}
                          data-focused={focused() ? "true" : undefined}
                          onClick={() => item.activate()}
                          onMouseEnter={() => setFocusIndex(index())}
                          class={
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] " +
                            (focused()
                              ? "bg-[var(--surface-hover)] text-[var(--accent)]"
                              : "text-[var(--fg)] hover:bg-[var(--surface-hover)]")
                          }
                        >
                          <span
                            aria-hidden="true"
                            class="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[11px] text-[var(--dim)]"
                          >
                            {item.glyph}
                          </span>
                          <span class="truncate">{item.label}</span>
                          <Show when={item.detail}>
                            <span class="ml-auto truncate text-[10px] text-[var(--dim)]">
                              {item.detail}
                            </span>
                          </Show>
                          <Show when={item.shortcut}>
                            <span class="font-mono text-[10px] text-[var(--dim)]">
                              {item.shortcut}
                            </span>
                          </Show>
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

function commandToItem(cmd: KeybindDescriptor): PaletteItem {
  const shortcut = formatCombo(cmd.combo);
  return {
    kind: "command",
    id: `cmd:${cmd.id}`,
    label: cmd.label,
    glyph: "›",
    ...(shortcut ? { shortcut } : {}),
    activate: () => {
      closeCommandPalette();
      cmd.run();
    },
    searchText: `${cmd.label} ${cmd.group}`.toLowerCase(),
  };
}
