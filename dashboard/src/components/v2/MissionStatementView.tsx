/**
 * MissionStatementView — the high-level "what are we trying to do"
 * surface. Separate from MissionControlView (the operational dashboard
 * with agents / runtime / events): this one shows mission text, goals
 * + acceptance criteria, and milestone progress only. No runtime KPIs,
 * no event stream, no agent rail — those live in mission-control.
 *
 * Data flows from the same /api/project/:name poll the other v2 views
 * use, via createProjectDetail.
 */

import { createMemo, For, Show, type JSX } from "solid-js";
import { createProjectDetail, type ProjectDetailLike } from "./projectData";

interface MissionStatementViewProps {
  projectName: string;
}

const STATUS_COLOR: Record<string, string> = {
  active: "var(--green)",
  "in-progress": "var(--accent)",
  validating: "var(--yellow)",
  review: "var(--yellow)",
  done: "var(--green)",
  todo: "var(--dim)",
  locked: "var(--dim)",
  planning: "var(--cyan, var(--accent))",
  blocked: "var(--red)",
};

const PRIORITY_LABEL: Record<number, string> = {
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

function statusColor(status: string | undefined): string {
  if (!status) return "var(--dim)";
  return STATUS_COLOR[status] ?? "var(--dim)";
}

function percent(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.round((num / denom) * 100);
}

export function MissionStatementView(props: MissionStatementViewProps): JSX.Element {
  const { detail } = createProjectDetail(() => props.projectName);

  const mission = createMemo(() => detail()?.mission ?? null);
  const validation = createMemo(() => detail()?.validationSummary ?? null);
  const milestones = createMemo(() => {
    const list = detail()?.milestones ?? detail()?.mission?.milestones ?? [];
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  });
  const goals = createMemo(() => {
    const list = detail()?.goals ?? [];
    return [...list].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  });

  return (
    <div
      data-testid="mission-statement-view"
      class="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--bg)] text-[var(--fg)]"
      style={{ "font-family": "var(--font-mono)", "font-size": "var(--text-base)" }}
    >
      <Show
        when={mission()}
        fallback={
          <div
            data-testid="mission-statement-empty"
            class="flex flex-1 items-center justify-center p-8 text-center text-[var(--dim)]"
          >
            <div>
              <div class="mb-2 text-[var(--fg-secondary)]">No active mission</div>
              <code class="inline-flex rounded bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg-secondary)]">
                tmux-ide mission set &lt;title&gt;
              </code>
            </div>
          </div>
        }
      >
        {(m) => (
          <div class="flex flex-col gap-4 p-4">
            <Hero mission={m()} />
            <Show when={validation()}>{(v) => <ValidationBar v={v()} />}</Show>
            <Show when={milestones().length > 0}>
              <Milestones items={milestones()} />
            </Show>
            <Show when={goals().length > 0}>
              <Goals items={goals()} />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

function Hero(props: { mission: NonNullable<ProjectDetailLike["mission"]> }): JSX.Element {
  return (
    <section
      data-mission-section="hero"
      class="rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--surface))] p-4"
    >
      <div class="mb-2 flex flex-wrap items-center gap-3">
        <span
          data-testid="mission-statement-title"
          class="text-[16px] font-semibold text-[var(--fg)]"
        >
          {props.mission.title ?? ""}
        </span>
        <Show when={props.mission.status}>
          <span
            data-mission-status={props.mission.status}
            class="rounded-full border px-2 py-[1px] text-xs uppercase tracking-wider"
            style={{
              "border-color": statusColor(props.mission.status),
              color: statusColor(props.mission.status),
            }}
          >
            {props.mission.status}
          </span>
        </Show>
        <Show when={props.mission.branch}>
          <span class="text-sm text-[var(--dim)]">⎇ {props.mission.branch}</span>
        </Show>
      </div>
      <Show when={props.mission.description}>
        <p class="m-0 whitespace-pre-wrap text-base leading-relaxed text-[var(--fg-secondary)]">
          {props.mission.description}
        </p>
      </Show>
    </section>
  );
}

function ValidationBar(props: {
  v: NonNullable<ProjectDetailLike["validationSummary"]>;
}): JSX.Element {
  const total = () => props.v.total;
  const passing = () => props.v.passing;
  const pct = () => percent(passing(), total());
  return (
    <section
      data-mission-section="validation"
      class="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <div class="mb-2 flex items-center gap-3 text-sm">
        <span class="text-xs uppercase tracking-wider text-[var(--dim)]">validation</span>
        <span class="font-medium tabular-nums text-[var(--fg)]">
          {passing()}/{total()} passing · {pct()}%
        </span>
        <span class="ml-auto flex gap-2 text-[var(--dim)]">
          <span>failing {props.v.failing}</span>
          <span>pending {props.v.pending}</span>
          <span>blocked {props.v.blocked}</span>
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct()}
        aria-valuemin={0}
        aria-valuemax={100}
        class="h-1 w-full overflow-hidden rounded bg-[var(--border)]"
      >
        <div
          class="h-full bg-[var(--green)] transition-[width] duration-200"
          style={{ width: `${pct()}%` }}
        />
      </div>
    </section>
  );
}

function Milestones(props: { items: NonNullable<ProjectDetailLike["milestones"]> }): JSX.Element {
  return (
    <section data-mission-section="milestones">
      <SectionLabel>Milestones</SectionLabel>
      <div class="flex flex-col gap-2">
        <For each={props.items}>
          {(m) => {
            const pct = () => percent(m.tasksDone ?? 0, m.taskCount ?? 0);
            return (
              <div
                data-mission-milestone={m.id}
                data-mission-milestone-status={m.status}
                class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-[10px]"
              >
                <div class="mb-1 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    class="inline-block h-2 w-2 rounded-full"
                    style={{ background: statusColor(m.status) }}
                  />
                  <span class="font-medium text-[var(--fg)]">{m.title}</span>
                  <span class="text-sm text-[var(--dim)]">{m.status}</span>
                  <span class="ml-auto tabular-nums text-sm text-[var(--dim)]">
                    {m.tasksDone ?? 0}/{m.taskCount ?? 0} · {pct()}%
                  </span>
                </div>
                <div class="h-1 w-full overflow-hidden rounded bg-[var(--border)]">
                  <div
                    class="h-full transition-[width] duration-200"
                    style={{ width: `${pct()}%`, background: statusColor(m.status) }}
                  />
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </section>
  );
}

function Goals(props: { items: NonNullable<ProjectDetailLike["goals"]> }): JSX.Element {
  return (
    <section data-mission-section="goals">
      <SectionLabel>Goals</SectionLabel>
      <div class="flex flex-col gap-2">
        <For each={props.items}>
          {(g) => (
            <article
              data-mission-goal={g.id}
              data-mission-goal-status={g.status}
              class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3"
            >
              <header class="mb-1 flex flex-wrap items-center gap-2">
                <span class="font-mono text-sm text-[var(--dim)]">{g.id}</span>
                <span class="font-medium text-[var(--fg)]">{g.title}</span>
                <Show when={typeof g.priority === "number"}>
                  <span class="rounded border border-[var(--border)] px-1 text-xs uppercase tracking-wider text-[var(--dim)]">
                    {PRIORITY_LABEL[g.priority ?? 99] ?? `P${g.priority}`}
                  </span>
                </Show>
                <Show when={g.status}>
                  <span
                    class="rounded-full border px-2 py-[1px] text-xs uppercase tracking-wider"
                    style={{ "border-color": statusColor(g.status), color: statusColor(g.status) }}
                  >
                    {g.status}
                  </span>
                </Show>
                <Show when={g.assignee}>
                  <span class="ml-auto text-xs text-[var(--dim)]">@{g.assignee}</span>
                </Show>
              </header>
              <Show when={g.description}>
                <p class="m-0 mb-2 whitespace-pre-wrap text-base leading-relaxed text-[var(--fg-secondary)]">
                  {g.description}
                </p>
              </Show>
              <Show when={g.acceptance}>
                <div
                  data-mission-goal-acceptance={g.id}
                  class="rounded border-l-2 border-[var(--accent)] bg-[var(--bg-strong,var(--surface))] px-3 py-2"
                >
                  <div class="mb-1 text-xs uppercase tracking-wider text-[var(--dim)]">
                    acceptance
                  </div>
                  <pre class="m-0 whitespace-pre-wrap font-mono text-sm leading-relaxed text-[var(--fg-secondary)]">
                    {g.acceptance}
                  </pre>
                </div>
              </Show>
            </article>
          )}
        </For>
      </div>
    </section>
  );
}

function SectionLabel(props: { children: string }): JSX.Element {
  return (
    <div class="mb-2 text-xs uppercase tracking-wider text-[var(--dim)]">{props.children}</div>
  );
}
