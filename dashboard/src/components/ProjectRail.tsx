/**
 * ProjectRail — leftmost narrow column for switching tmux-ide projects.
 *
 * Sits to the LEFT of the existing V2ActivityBar. Each row is a tmux
 * session pulled from `/api/sessions`, deduped with the registered
 * projects from `/api/projects` so a workspace that has no live tmux
 * server still appears. The rail re-renders on `projects.changed` /
 * `sessions.changed` WS frames via `projectsBusTick`.
 *
 * Click → Solid Router push to `/project/<name>` (no full reload).
 * The "+" entry at the bottom navigates to `/` (the welcome route owns
 * the add-project flow shipped in PROJECT-SWITCHER-1/2/3).
 *
 * The matching in-project ActivityBar (Files/Search/Diffs/Plans/...)
 * stays as the SECOND column — see `routes/project/[name].tsx`.
 */

import { createMemo, createResource, For, Show, type JSX } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { Effect } from "effect";
import { Plus } from "lucide-solid";
import { fetchProjects, fetchSessions, type RegisteredProject } from "@/lib/api";
import type { SessionOverview } from "@tmux-ide/contracts";
import { projectsBusTick, useProjectsBus } from "@/lib/projectsBus";
import { recordProjectOpened } from "@/components/projects/ProjectQuickSwitcher";

interface RailRow {
  name: string;
  dir: string;
  running: boolean;
}

/** Render the project rail; tests pass injected resources to avoid
 *  hitting the network. Production uses the two default fetchers. */
export interface ProjectRailProps {
  activeName?: string;
  /** Optional override — when provided, replaces both the sessions
   *  + projects fetch with this single source. Used in tests. */
  rowsOverride?: () => RailRow[];
}

export function ProjectRail(props: ProjectRailProps): JSX.Element {
  const params = useParams<{ name?: string }>();
  const navigate = useNavigate();
  const activeName = (): string | undefined =>
    props.activeName ?? (params.name ? decodeURIComponent(params.name) : undefined);

  useProjectsBus();

  const [sessionsResource] = createResource(projectsBusTick, async () => {
    try {
      return await Effect.runPromise(fetchSessions());
    } catch {
      return [] as readonly SessionOverview[];
    }
  });
  const [projectsResource] = createResource(projectsBusTick, async () => {
    try {
      return await Effect.runPromise(fetchProjects());
    } catch {
      return [] as readonly RegisteredProject[];
    }
  });

  const rows = createMemo<RailRow[]>(() => {
    if (props.rowsOverride) return [...props.rowsOverride()];
    const byName = new Map<string, RailRow>();
    for (const p of projectsResource() ?? []) {
      byName.set(p.name, { name: p.name, dir: p.dir, running: false });
    }
    for (const s of sessionsResource() ?? []) {
      const existing = byName.get(s.name);
      if (existing) existing.running = true;
      else byName.set(s.name, { name: s.name, dir: s.dir, running: true });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  function onActivate(row: RailRow): void {
    recordProjectOpened(row.name);
    navigate(`/project/${encodeURIComponent(row.name)}`);
  }

  return (
    <nav
      aria-label="Project switcher"
      data-testid="v2-project-rail"
      class="flex h-full w-11 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--bg-strongest,var(--bg-strong))] py-2"
    >
      <ul class="flex w-full flex-col items-center gap-1 overflow-y-auto px-1">
        <For each={rows()}>
          {(row) => {
            const active = (): boolean => row.name === activeName();
            return (
              <li class="w-full">
                <button
                  type="button"
                  title={row.name}
                  aria-label={`Switch to project ${row.name}`}
                  aria-pressed={active() || undefined}
                  data-testid={`v2-project-rail-row-${row.name}`}
                  data-active={active() ? "true" : undefined}
                  onClick={() => onActivate(row)}
                  class="group relative flex h-9 w-full items-center justify-center"
                >
                  <Show when={active()}>
                    <span
                      aria-hidden="true"
                      class="absolute left-0 top-1 bottom-1 w-[2px] bg-[var(--accent)]"
                    />
                  </Show>
                  <ProjectAvatar name={row.name} active={active()} />
                  <Show when={row.running}>
                    <span
                      aria-hidden="true"
                      title="Running"
                      class="absolute right-1 bottom-1 h-1.5 w-1.5 rounded-full bg-[var(--green,#7cb342)]"
                    />
                  </Show>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <div class="mt-auto w-full px-1 pt-2">
        <A
          href="/"
          title="Add project"
          aria-label="Add project"
          data-testid="v2-project-rail-add"
          class="flex h-9 w-full items-center justify-center rounded-md border border-dashed border-[var(--border)] text-[var(--dim)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        </A>
      </div>
    </nav>
  );
}

function ProjectAvatar(props: { name: string; active: boolean }) {
  const initial = (): string => {
    const ch = props.name.trim().charAt(0).toUpperCase();
    return ch || "?";
  };
  return (
    <span
      class={
        "flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold transition-colors " +
        (props.active
          ? "bg-[var(--accent)] text-[var(--bg)]"
          : "bg-[var(--bg-weak)] text-[var(--fg)] group-hover:bg-[var(--surface-hover)]")
      }
    >
      {initial()}
    </span>
  );
}
