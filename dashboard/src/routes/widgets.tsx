/**
 * /widgets — Solid port of `dashboard/app/widgets/page.tsx`.
 *
 * Parity goals:
 *   - Same WIDGETS catalog (24 entries: 8 TUI + 16 Solid), ordered to
 *     match docs/widget-index.md so traceability is preserved.
 *   - Same data-testid surface so e2e specs can run unchanged against
 *     either build.
 *   - Same Tailwind utility classes — the design tokens are imported
 *     verbatim, so `bg-[var(--bg)]` etc. resolve identically.
 *
 * Differences from React:
 *   - `useState` → `createSignal`
 *   - `useMemo` → `createMemo`
 *   - `useEffect` → `onMount` / Effect runtime (`Effect.runPromise`)
 *   - Conditional render → `<Show>` / `<For>`
 *   - `<Link>` from next/link → `<A>` from `@solidjs/router`
 *   - `entry.Icon` as a component → Solid Dynamic via plain JSX (icons
 *     are Solid components already)
 */

import { createMemo, createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { A } from "@solidjs/router";
import { Effect } from "effect";
import { fetchSessions } from "@/lib/api";
import type { SessionOverview } from "@tmux-ide/contracts";
import {
  Activity,
  AppWindow,
  BarChart3,
  Boxes,
  CheckSquare,
  Code,
  Compass,
  CornerDownRight,
  Cpu,
  DollarSign,
  Eye,
  FileEdit,
  FileText,
  Files,
  Folder,
  GitCompare,
  Grid3X3,
  Inspect,
  KanbanSquare,
  ListChecks,
  ListTodo,
  Loader2,
  Map,
  MessagesSquare,
  Notebook,
  PanelsTopLeft,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from "lucide-solid";

type WidgetKind = "tui" | "solid";

// Solid lucide icons are plain components; typed as a generic Component
// so the icon slot accepts any of them without per-icon casting.
type IconComponent = Component<{ size?: number; strokeWidth?: number; class?: string }>;

interface WidgetEntry {
  id: string;
  name: string;
  kind: WidgetKind;
  description: string;
  /** Where clicking the tile lands the user. */
  href: string;
  Icon: IconComponent;
  /** `composite` flag for the chip color tier (richer multi-pane widgets). */
  composite?: boolean;
  /** Status hint from the catalog. */
  status?: "shipped" | "orphan";
}

// Ordered to match docs/widget-index.md for traceability.
const WIDGETS: WidgetEntry[] = [
  // ─── Daemon TUI widgets (8) ─────────────────────────────────────────
  {
    id: "changes",
    name: "changes",
    kind: "tui",
    description: "Git diff viewer for the working tree.",
    href: "/widget/changes",
    Icon: GitCompare,
  },
  {
    id: "config",
    name: "config",
    kind: "tui",
    description: "Interactive ide.yml editor (config tree TUI).",
    href: "/widget/config",
    Icon: Settings,
  },
  {
    id: "costs",
    name: "costs",
    kind: "tui",
    description: "Token + cost tracking per agent and per thread.",
    href: "/widget/costs",
    Icon: DollarSign,
  },
  {
    id: "explorer",
    name: "explorer",
    kind: "tui",
    description: "File tree navigator inside a tmux pane.",
    href: "/widget/explorer",
    Icon: Folder,
  },
  {
    id: "mission-control",
    name: "mission-control",
    kind: "tui",
    description: "Agent + task + event dashboard for the active session.",
    href: "/widget/mission-control",
    Icon: Compass,
    composite: true,
  },
  {
    id: "preview",
    name: "preview",
    kind: "tui",
    description: "Read-only file content preview.",
    href: "/widget/preview",
    Icon: Eye,
  },
  {
    id: "setup",
    name: "setup",
    kind: "tui",
    description: "Project setup wizard — detect stack, write ide.yml.",
    href: "/widget/setup",
    Icon: Wrench,
  },
  {
    id: "tasks",
    name: "tasks",
    kind: "tui",
    description: "Task list / detail / form (TUI flavor).",
    href: "/widget/tasks",
    Icon: ListChecks,
  },
  // ─── Solid DOM widgets (16) ─────────────────────────────────────────
  {
    id: "Activity",
    name: "Activity",
    kind: "solid",
    description: "Event timeline grouped by day with KPI strip + filters.",
    href: "/",
    Icon: Activity,
  },
  {
    id: "Changes",
    name: "Changes",
    kind: "solid",
    description: "Compact diff stats summary panel.",
    href: "/",
    Icon: GitCompare,
  },
  {
    id: "CommandPalette",
    name: "CommandPalette",
    kind: "solid",
    description: "Cmd+K unified search across providers, skills, tasks, threads.",
    href: "/",
    Icon: Search,
  },
  {
    id: "Costs",
    name: "Costs",
    kind: "solid",
    description: "Token + cost metrics. KPI cards + per-agent breakdown.",
    href: "/",
    Icon: BarChart3,
  },
  {
    id: "CostsDashboard",
    name: "CostsDashboard",
    kind: "solid",
    description: "Richer cost composite — multi-pane layout. May be unwired.",
    href: "/",
    Icon: BarChart3,
    composite: true,
    status: "orphan",
  },
  {
    id: "DiffsViewer",
    name: "DiffsViewer",
    kind: "solid",
    description: "File diffs with hunk navigation + side-by-side toggle.",
    href: "/",
    Icon: Code,
  },
  {
    id: "Explorer",
    name: "Explorer",
    kind: "solid",
    description: "Browser-side file tree with virtualized rows.",
    href: "/",
    Icon: Files,
  },
  {
    id: "ExplorerDashboard",
    name: "ExplorerDashboard",
    kind: "solid",
    description: "Richer explorer composite with detail pane. May be unwired.",
    href: "/",
    Icon: PanelsTopLeft,
    composite: true,
    status: "orphan",
  },
  {
    id: "Inspector",
    name: "Inspector",
    kind: "solid",
    description: "Right-rail event stream scoped to the current view.",
    href: "/",
    Icon: Inspect,
  },
  {
    id: "KanbanBoard",
    name: "KanbanBoard",
    kind: "solid",
    description: "Task kanban with status columns and drag-to-cycle.",
    href: "/",
    Icon: KanbanSquare,
  },
  {
    id: "MissionControl",
    name: "MissionControl",
    kind: "solid",
    description: "Agents + tasks + events composite for the active session.",
    href: "/",
    Icon: Map,
    composite: true,
  },
  {
    id: "MissionControlDashboard",
    name: "MissionControlDashboard",
    kind: "solid",
    description: "Richer mission composite with KPI lanes. May be unwired.",
    href: "/",
    Icon: Map,
    composite: true,
    status: "orphan",
  },
  {
    id: "PlansPanel",
    name: "PlansPanel",
    kind: "solid",
    description: "Plan body editor with per-section authorship borders.",
    href: "/",
    Icon: FileEdit,
  },
  {
    id: "PlansRail",
    name: "PlansRail",
    kind: "solid",
    description: "Left rail listing plans by status with search + sort.",
    href: "/",
    Icon: ListTodo,
  },
  {
    id: "SkillsView",
    name: "SkillsView",
    kind: "solid",
    description: "Project skills rail + body — renders skill markdown.",
    href: "/",
    Icon: Sparkles,
  },
  {
    id: "TasksView",
    name: "TasksView",
    kind: "solid",
    description: "Filterable task list — composite dashboard surface.",
    href: "/",
    Icon: CheckSquare,
  },
];

type KindFilter = "all" | "tui" | "solid" | "composite";

const FILTER_LABELS: Record<KindFilter, string> = {
  all: "All",
  solid: "Solid DOM",
  tui: "Daemon TUI",
  composite: "Composite",
};

const FILTER_ORDER: KindFilter[] = ["all", "solid", "tui", "composite"];

function matchesKind(entry: WidgetEntry, kind: KindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "composite") return Boolean(entry.composite);
  return entry.kind === kind;
}

function matchesSearch(entry: WidgetEntry, query: string): boolean {
  if (!query) return true;
  const haystack = `${entry.name} ${entry.description}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

// Pre-compute the counts once; the catalog is static.
const COUNTS = {
  all: WIDGETS.length,
  tui: WIDGETS.filter((w) => w.kind === "tui").length,
  solid: WIDGETS.filter((w) => w.kind === "solid").length,
  composite: WIDGETS.filter((w) => w.composite).length,
};

export function WidgetsRoute() {
  const [kindFilter, setKindFilter] = createSignal<KindFilter>("all");
  const [query, setQuery] = createSignal("");
  const [activeSession, setActiveSession] = createSignal<SessionOverview | null>(null);

  // TUI tiles need a real session+dir to render. Pick the first
  // registered workspace; `null` falls back to a / redirect.
  onMount(() => {
    let cancelled = false;
    const run = Effect.runPromise(fetchSessions());
    run
      .then((sessions) => {
        if (cancelled) return;
        setActiveSession(sessions[0] ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveSession(null);
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const filtered = createMemo(() =>
    WIDGETS.filter((w) => matchesKind(w, kindFilter()) && matchesSearch(w, query())),
  );

  return (
    <div
      data-testid="widgets-gallery-page"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header
        data-testid="widgets-gallery-header"
        class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-4 py-3 text-base"
      >
        <Grid3X3 size={16} class="text-[var(--accent)]" aria-hidden="true" />
        <h1 class="text-md font-medium text-[var(--fg)]">Widgets</h1>
        <span class="text-sm text-[var(--dim)]">
          ({filtered().length}/{WIDGETS.length})
        </span>
        <span class="flex-1" />
        <A
          href="/"
          class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          ← Back to v2
        </A>
      </header>

      <div
        data-testid="widgets-gallery-toolbar"
        class="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-4 py-2"
      >
        <input
          type="text"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search widgets"
          data-testid="widgets-gallery-search"
          class="h-7 w-64 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-base text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
        <div class="flex flex-wrap items-center gap-1">
          <For each={FILTER_ORDER}>
            {(kind) => {
              const active = () => kind === kindFilter();
              const count = COUNTS[kind];
              return (
                <button
                  type="button"
                  data-testid={`widgets-gallery-chip-${kind}`}
                  data-active={active() ? "true" : undefined}
                  onClick={() => setKindFilter(kind)}
                  class={
                    "h-7 cursor-pointer rounded-md border px-2 text-sm " +
                    (active()
                      ? "border-[var(--accent)] bg-[var(--surface-active)] text-[var(--accent)]"
                      : "border-[var(--border)] bg-[var(--surface)] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]")
                  }
                >
                  {FILTER_LABELS[kind]} ({count})
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <div
        data-testid="widgets-gallery-grid"
        class="grid flex-1 auto-rows-min gap-3 overflow-y-auto p-4"
        style={{ "grid-template-columns": "repeat(auto-fill, minmax(260px, 1fr))" }}
      >
        <For each={filtered()}>
          {(entry) => <WidgetTile entry={entry} activeSession={activeSession()} />}
        </For>
        <Show when={filtered().length === 0}>
          <div
            data-testid="widgets-gallery-empty"
            class="col-span-full flex h-32 items-center justify-center text-base text-[var(--dim)]"
          >
            No widgets match the current filters.
          </div>
        </Show>
      </div>
    </div>
  );
}

function WidgetTile(props: { entry: WidgetEntry; activeSession: SessionOverview | null }) {
  // TUI widget tiles deep-link to /widget/<name> which requires
  // ?session=NAME&dir=PATH. Without those params the target page errors
  // "WIDGET UNAVAILABLE — missing widget name, session, or dir query
  // params". Append them from the first registered workspace; if no
  // workspace exists yet, fall back to a friendly / redirect.
  const href = () => {
    if (props.entry.kind !== "tui") return props.entry.href;
    const s = props.activeSession;
    if (!s) return "/";
    return `${props.entry.href}?session=${encodeURIComponent(s.name)}&dir=${encodeURIComponent(s.dir)}`;
  };

  return (
    <A
      href={href()}
      data-testid="widget-tile"
      data-widget-id={props.entry.id}
      data-widget-kind={props.entry.kind}
      data-widget-composite={props.entry.composite ? "true" : undefined}
      class="group flex h-[200px] cursor-pointer flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--accent)]"
    >
      <div class="flex items-start gap-2">
        <span
          aria-hidden="true"
          class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-strong)] text-[var(--fg-secondary)] group-hover:border-[var(--accent)] group-hover:text-[var(--accent)]"
        >
          <Dynamic component={props.entry.Icon} size={16} strokeWidth={1.75} />
        </span>
        <div class="min-w-0 flex-1">
          <div
            class="truncate font-mono text-md text-[var(--fg)] group-hover:text-[var(--accent)]"
            data-testid="widget-tile-name"
          >
            {props.entry.name}
          </div>
          <div class="flex items-center gap-1.5">
            <CategoryBadge entry={props.entry} />
            <Show when={props.entry.status === "orphan"}>
              <span
                data-testid="widget-tile-status-orphan"
                class="rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--dim)]"
                title="Component exists but may be unwired"
              >
                orphan
              </span>
            </Show>
          </div>
        </div>
      </div>
      <p
        class="flex-1 overflow-hidden text-sm leading-relaxed text-[var(--fg-secondary)]"
        data-testid="widget-tile-description"
      >
        {props.entry.description}
      </p>
      <div class="flex items-center justify-between text-xs text-[var(--dim)]">
        <span class="font-mono">{props.entry.href}</span>
        <span class="inline-flex items-center gap-1 text-[var(--fg-secondary)] group-hover:text-[var(--accent)]">
          Open <CornerDownRight size={10} aria-hidden="true" />
        </span>
      </div>
    </A>
  );
}

function CategoryBadge(props: { entry: WidgetEntry }) {
  return (
    <Show
      when={props.entry.kind === "tui"}
      fallback={
        <Show
          when={props.entry.composite}
          fallback={
            <span
              data-testid="widget-tile-badge-solid"
              class="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--fg-secondary)]"
            >
              <SlidersHorizontal size={9} aria-hidden="true" />
              Solid
            </span>
          }
        >
          <span
            data-testid="widget-tile-badge-composite"
            class="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--surface-active)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--accent)]"
          >
            <Boxes size={9} aria-hidden="true" />
            Composite
          </span>
        </Show>
      }
    >
      <span
        data-testid="widget-tile-badge-tui"
        class="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-strong)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--dim)]"
      >
        <Cpu size={9} aria-hidden="true" />
        TUI
      </span>
    </Show>
  );
}

// Force-reference icons reserved for upcoming live previews so the
// import set stays in lockstep with the React source.
void AppWindow;
void FileText;
void Loader2;
void MessagesSquare;
void Notebook;
