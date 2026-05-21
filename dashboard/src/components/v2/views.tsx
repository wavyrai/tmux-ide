/**
 * Solid wrappers around each @tmux-ide/v2-solid-widgets mount factory.
 * The route file imports these and renders them per-view-id; data
 * comes from the polled fetchers in ./projectData.ts.
 *
 * The widgets are written prop-driven: we hand them an `options`
 * accessor and the host signal updates re-fire `setOptions` via the
 * generic [[WidgetHost]] component.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";
import { Pencil } from "lucide-solid";
import { registerKeybinds } from "@/lib/keybinds";
import {
  mountActivity,
  mountCostsDashboard,
  mountInspector,
  mountKanbanBoard,
  mountMissionControlDashboard,
  mountPlansRail,
  mountSkillsView,
  mountTasksView,
  type ActivityMountOptions,
  type CostsAgentEntry,
  type CostsDashboardMountOptions,
  type CostsDashboardSnapshot,
  type CostsMilestoneEntry,
  type CostsTimelineEntry,
  type DashboardAgent,
  type DashboardEvent,
  type DashboardMilestone,
  type DashboardTask,
  type InspectorMountOptions,
  type InspectorScope,
  type KanbanBoardMountOptions,
  type KanbanTask,
  type MissionControlDashboardMountOptions,
  type PlansPanelAuthorship,
  type PlansPanelMountOptions,
  type PlansRailMountOptions,
  type SkillsViewMountOptions,
  type SkillSummary,
  type TasksViewMountOptions,
  type TasksTask,
} from "@tmux-ide/v2-solid-widgets";
import { Terminal } from "@/components/Terminal";
import { API_BASE } from "@/lib/api";
import { renderMarkdownHighlighted } from "@/lib/syntax/markdownShiki";
import { ProblemsTab } from "./ProblemsTab";
import { totalDiagnosticsCount } from "@/lib/lsp/diagnostics-store";
import { TabStrip, type TabStripItem } from "@/components/ui/TabStrip";
import { WidgetHost } from "@tmux-ide/v2-solid-widgets";
import {
  createMetrics,
  createProjectDetail,
  createProjectEvents,
  fetchSkill,
  type ProjectDetailLike,
  type ProjectEventLike,
} from "./projectData";

interface ProjectProps {
  projectName: string;
}

/** Mission + Mission Control share the same dashboard surface for now. */
export function MissionControlView(props: ProjectProps): JSX.Element {
  const { detail } = createProjectDetail(() => props.projectName);
  const { events } = createProjectEvents(() => props.projectName);

  const options = createMemo<MissionControlDashboardMountOptions>(() => {
    const d: ProjectDetailLike | null = detail();
    const ev: ProjectEventLike[] = events();
    return {
      snapshot: {
        mission: d?.mission
          ? {
              title: d.mission.title ?? "",
              description: d.mission.description ?? "",
              status: d.mission.status ?? "",
              branch: d.mission.branch ?? null,
            }
          : null,
        validation: d?.validationSummary ?? null,
        milestones: ((d?.milestones ?? d?.mission?.milestones ?? []) as DashboardMilestone[]).map(
          (m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            order: m.order ?? 0,
            taskCount: m.taskCount ?? 0,
            tasksDone: m.tasksDone ?? 0,
          }),
        ),
        tasks: (d?.tasks ?? []).map<DashboardTask>((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          milestone: t.milestone ?? null,
          assignee: t.assignee ?? null,
        })),
        agents: (d?.agents ?? []) as DashboardAgent[],
        events: ev as DashboardEvent[],
      },
    };
  });

  return (
    <WidgetHost mount={mountMissionControlDashboard} options={options} class="h-full w-full" />
  );
}

export function KanbanBoardView(props: ProjectProps): JSX.Element {
  const { detail } = createProjectDetail(() => props.projectName);

  const options = createMemo<KanbanBoardMountOptions>(() => {
    const d = detail();
    const tasks: KanbanTask[] = (d?.tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? 3,
      assignee: t.assignee ?? null,
      goal: t.goal ?? null,
      milestone: t.milestone ?? null,
      depends_on: t.depends_on ?? [],
      tags: t.tags ?? [],
      description: t.description ?? null,
      created: t.created,
      updated: t.updated,
    }));
    return {
      tasks,
      density: "compact",
    };
  });

  return <WidgetHost mount={mountKanbanBoard} options={options} class="h-full w-full" />;
}

export function TasksDashboardView(props: ProjectProps): JSX.Element {
  const { detail } = createProjectDetail(() => props.projectName);

  const options = createMemo<TasksViewMountOptions>(() => {
    const d = detail();
    const tasks: TasksTask[] = (d?.tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority ?? 3,
      assignee: t.assignee ?? null,
      goal: t.goal ?? null,
      milestone: t.milestone ?? null,
      depends_on: t.depends_on ?? [],
      tags: t.tags ?? [],
      description: t.description ?? null,
      created: t.created,
      updated: t.updated,
      proof: t.proof,
    }));
    return {
      tasks,
      goals: (d?.goals ?? []).map((g) => ({ id: g.id, title: g.title })),
      milestones: (d?.milestones ?? []).map((m) => ({
        id: m.id,
        title: m.title,
        order: m.order ?? 0,
      })),
      density: "compact",
    };
  });

  return <WidgetHost mount={mountTasksView} options={options} class="h-full w-full" />;
}

export interface PlanEditController {
  editing: Accessor<boolean>;
  draft: Accessor<string>;
  setDraft: (next: string) => void;
  saving: Accessor<boolean>;
  saveError: Accessor<string | null>;
  savedAt: Accessor<number | null>;
  remoteUpdateAvailable: Accessor<boolean>;
  canEdit: Accessor<boolean>;
  beginEdit: () => void;
  cancelEdit: () => void;
  saveEdit: () => Promise<void>;
  discardLocal: () => void;
}

/**
 * Plan body renderer. The plan markdown used to dump into a raw
 * monospace `<pre>`; now it routes through the shared shiki markdown
 * pipeline so headings, tables, and fenced code render richly. The
 * synchronous fallback (chat-solid `renderMarkdown`) is replaced by
 * the highlighted HTML once the async shiki pass resolves.
 *
 * Edit mode: when `controller.editing()` is true, the rendered HTML is
 * swapped for a plain monospace textarea over the same content. Cmd+S
 * saves, Esc cancels. The header gets an Edit button (or Cancel/Save
 * pair while editing) plus a transient "Saved" tick.
 */
export function PlanBodyView(props: {
  plan: PlansPanelMountOptions["plan"];
  data: PlansPanelMountOptions["planData"];
  controller: PlanEditController;
}): JSX.Element {
  const [html, setHtml] = createSignal<string>("");
  createEffect(
    on(
      () => props.data?.content ?? "",
      (content) => {
        if (!content) {
          setHtml("");
          return;
        }
        let stale = false;
        void renderMarkdownHighlighted(content)
          .then((out) => {
            if (!stale) setHtml(out);
          })
          .catch(() => {
            if (!stale) setHtml("");
          });
        return () => {
          stale = true;
        };
      },
    ),
  );

  let textareaEl: HTMLTextAreaElement | undefined;
  createEffect(() => {
    if (props.controller.editing() && textareaEl) {
      // Autofocus + place caret at end of the draft.
      textareaEl.focus();
      const len = textareaEl.value.length;
      try {
        textareaEl.setSelectionRange(len, len);
      } catch {
        /* ignore — some browsers reject for non-text-area types */
      }
    }
  });

  function onTextareaKeyDown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void props.controller.saveEdit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.controller.cancelEdit();
    }
  }

  const savedRecently = createMemo<boolean>(() => {
    const at = props.controller.savedAt();
    if (at === null) return false;
    return Date.now() - at < 2500;
  });

  return (
    <div data-testid="plan-body" class="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <Show when={props.plan}>
        {(meta) => (
          <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong,var(--bg))] px-8 py-3">
            <h1 class="text-[13px] font-medium text-[var(--fg)]">{meta().title}</h1>
            <span class="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
              {meta().status}
            </span>
            <span class="flex-1" />
            <Show when={props.controller.saveError()}>
              {(err) => (
                <span
                  data-testid="plan-save-error"
                  class="truncate text-[11px] text-[var(--red,#cc6666)]"
                  title={err()}
                >
                  {err()}
                </span>
              )}
            </Show>
            <Show when={savedRecently()}>
              <span data-testid="plan-saved-toast" class="text-[11px] text-[var(--accent)]">
                Saved
              </span>
            </Show>
            <Show
              when={props.controller.editing()}
              fallback={
                <button
                  type="button"
                  data-testid="plan-edit-button"
                  disabled={!props.controller.canEdit()}
                  onClick={() => props.controller.beginEdit()}
                  class="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Edit plan (⌘E)"
                >
                  <Pencil class="h-3 w-3" aria-hidden="true" />
                  <span>Edit</span>
                </button>
              }
            >
              <button
                type="button"
                data-testid="plan-edit-cancel"
                onClick={() => props.controller.cancelEdit()}
                class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                title="Cancel (Esc)"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="plan-edit-save"
                disabled={props.controller.saving()}
                onClick={() => void props.controller.saveEdit()}
                class="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-2 py-1 text-[11px] text-[var(--bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                title="Save (⌘S)"
              >
                {props.controller.saving() ? "Saving…" : "Save"}
              </button>
            </Show>
          </header>
        )}
      </Show>
      <Show when={props.controller.editing() && props.controller.remoteUpdateAvailable()}>
        <div
          data-testid="plan-remote-update-banner"
          class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-active,var(--bg-strong))] px-8 py-2 text-[11px] text-[var(--fg-secondary)]"
        >
          <span class="flex-1">Remote update available — your local edit is unsaved.</span>
          <button
            type="button"
            data-testid="plan-remote-discard"
            onClick={() => props.controller.discardLocal()}
            class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Discard local
          </button>
        </div>
      </Show>
      <Show
        when={props.controller.editing()}
        fallback={
          <div class="min-h-0 flex-1 overflow-y-auto">
            <Show
              when={html()}
              fallback={
                <div class="flex h-40 items-center justify-center text-[12px] text-[var(--dim)]">
                  Rendering plan…
                </div>
              }
            >
              <div
                class="chat-markdown w-full max-w-3xl px-8 py-8"
                // eslint-disable-next-line solid/no-innerhtml
                innerHTML={html()}
              />
            </Show>
          </div>
        }
      >
        <textarea
          ref={(el) => (textareaEl = el)}
          data-testid="plan-edit-textarea"
          spellcheck={false}
          autocomplete="off"
          value={props.controller.draft()}
          onInput={(e) => props.controller.setDraft(e.currentTarget.value)}
          onKeyDown={onTextareaKeyDown}
          class="min-h-0 flex-1 resize-none border-0 bg-[var(--bg)] px-8 py-6 font-mono text-[12px] leading-[1.55] text-[var(--fg)] outline-none focus:outline-none"
        />
      </Show>
    </div>
  );
}

/**
 * Plans surface: rail on the left, panel body on the right. The rail
 * owns its own polling (it calls /api/project/:name/plans internally);
 * the panel is prop-driven, so we fetch the body when a selection
 * changes.
 */
export function PlansSurfaceView(props: ProjectProps): JSX.Element {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [planData, setPlanData] = createSignal<PlansPanelMountOptions["planData"]>(null);
  const [planMeta, setPlanMeta] = createSignal<PlansPanelMountOptions["plan"]>(null);
  const [editing, setEditing] = createSignal<boolean>(false);
  const [draft, setDraft] = createSignal<string>("");
  const [saving, setSaving] = createSignal<boolean>(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [savedAt, setSavedAt] = createSignal<number | null>(null);
  const [remoteUpdateAvailable, setRemoteUpdateAvailable] = createSignal<boolean>(false);

  async function loadPlanBody(filename: string, opts?: { silent?: boolean }): Promise<void> {
    try {
      const res = await fetch(
        `${API_BASE}/api/project/${encodeURIComponent(props.projectName)}/plans/${encodeURIComponent(filename)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as {
        plan?: { name?: string; path?: string; title?: string; status?: string };
        content?: string;
        authorship?: unknown;
        mtime?: number | null;
      };
      const incomingMtime = json.mtime ?? null;
      if (json.plan) {
        setPlanMeta({
          name: json.plan.name ?? filename,
          path: json.plan.path ?? filename,
          title: json.plan.title ?? filename,
          status: json.plan.status ?? "in-progress",
        });
      }
      // Don't stomp a user's in-progress edit. If the user is editing
      // and the remote mtime moved forward, surface a banner; the user
      // decides whether to keep the local draft or discard it.
      if (opts?.silent && editing()) {
        const knownMtime = planData()?.mtime ?? null;
        if (incomingMtime !== null && knownMtime !== null && incomingMtime > knownMtime) {
          setRemoteUpdateAvailable(true);
        }
        return;
      }
      setPlanData({
        content: json.content ?? "",
        authorship: (json.authorship as PlansPanelAuthorship | null | undefined) ?? null,
        mtime: incomingMtime,
      });
      setRemoteUpdateAvailable(false);
    } catch {
      /* ignore */
    }
  }

  // Periodic re-fetch — keeps the view honest when the file is rewritten
  // by another tool (Claude pane, manual edit on disk). The daemon does
  // not emit an SSE event for file-plan mtime, so polling is the only
  // mechanism. Light cadence — 5s — only while a plan is selected.
  createEffect(() => {
    const filename = selected();
    if (!filename) return;
    const interval = setInterval(() => {
      void loadPlanBody(filename, { silent: true });
    }, 5000);
    onCleanup(() => clearInterval(interval));
  });

  const canEdit = createMemo<boolean>(() => selected() !== null && planData() !== null);

  function beginEdit(): void {
    if (!canEdit() || editing()) return;
    setDraft(planData()?.content ?? "");
    setSaveError(null);
    setRemoteUpdateAvailable(false);
    setEditing(true);
  }

  function cancelEdit(): void {
    if (!editing()) return;
    const original = planData()?.content ?? "";
    const dirty = draft() !== original;
    if (dirty) {
      const ok =
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm("Discard unsaved changes to this plan?")
          : true;
      if (!ok) return;
    }
    setEditing(false);
    setDraft("");
    setSaveError(null);
  }

  async function saveEdit(): Promise<void> {
    const filename = selected();
    if (!filename || !editing()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `${API_BASE}/api/project/${encodeURIComponent(props.projectName)}/plans/${encodeURIComponent(filename)}/content`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: draft() }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = `Save failed (HTTP ${res.status})`;
        try {
          const json = JSON.parse(text) as { error?: string };
          if (json.error) message = json.error;
        } catch {
          if (text) message = text;
        }
        setSaveError(message);
        return;
      }
      setEditing(false);
      setSaveError(null);
      setSavedAt(Date.now());
      setRemoteUpdateAvailable(false);
      // Refetch so the rendered markdown reflects what the daemon
      // actually wrote (mtime + any normalization).
      await loadPlanBody(filename);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function discardLocal(): void {
    const filename = selected();
    setEditing(false);
    setDraft("");
    setSaveError(null);
    setRemoteUpdateAvailable(false);
    if (filename) void loadPlanBody(filename);
  }

  // Cmd+E enters edit mode when the plans view is the active surface
  // and a plan is selected. Gated by `when:` so global dispatch skips
  // it while editing (the textarea catches Cmd+S / Esc directly).
  onMount(() => {
    const dispose = registerKeybinds({
      id: "plans.editPlan",
      label: "Edit current plan",
      group: "Editor",
      scope: "global",
      combo: { key: "e" },
      when: () => canEdit() && !editing(),
      run: () => beginEdit(),
    });
    onCleanup(dispose);
  });

  const controller: PlanEditController = {
    editing,
    draft,
    setDraft,
    saving,
    saveError,
    savedAt,
    remoteUpdateAvailable,
    canEdit,
    beginEdit,
    cancelEdit,
    saveEdit,
    discardLocal,
  };

  const railOptions = createMemo<PlansRailMountOptions>(() => ({
    sessionName: props.projectName,
    apiBaseUrl: API_BASE,
    bearerToken: null,
    selectedFile: selected(),
    onSelect: (filename: string) => {
      if (editing() && draft() !== (planData()?.content ?? "")) {
        const ok =
          typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm("Discard unsaved changes to this plan?")
            : true;
        if (!ok) return;
      }
      setEditing(false);
      setDraft("");
      setSaveError(null);
      setRemoteUpdateAvailable(false);
      setSelected(filename);
      void loadPlanBody(filename);
    },
    onCreate: () => {
      /* host owns creation; not wired for placeholder pass */
    },
  }));

  return (
    <div
      class="grid h-full w-full min-h-0"
      style={{ "grid-template-columns": "260px minmax(0, 1fr)" }}
    >
      <aside class="overflow-hidden border-r border-[var(--border)]">
        <WidgetHost mount={mountPlansRail} options={railOptions} class="h-full w-full" />
      </aside>
      <main class="overflow-hidden">
        <Show
          when={selected()}
          fallback={
            <div class="flex h-full items-center justify-center p-6 text-[12px] text-[var(--dim)]">
              Select a plan from the rail to view it here.
            </div>
          }
        >
          <PlanBodyView plan={planMeta()} data={planData()} controller={controller} />
        </Show>
      </main>
    </div>
  );
}

export function SkillsSurfaceView(props: ProjectProps): JSX.Element {
  const [skills, setSkills] = createSignal<SkillSummary[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function loadList(): Promise<void> {
    try {
      const res = await fetch(
        `${API_BASE}/api/project/${encodeURIComponent(props.projectName)}/skills`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json()) as { skills?: SkillSummary[] };
      if (json.skills) setSkills(json.skills);
    } catch {
      /* ignore */
    }
  }

  async function hydrateSelected(name: string): Promise<void> {
    const skill = await fetchSkill(props.projectName, name);
    if (!skill) return;
    setSkills((prev) =>
      prev.map((s) =>
        s.name === skill.name
          ? {
              name: skill.name,
              role: skill.role,
              description: skill.description,
              specialties: skill.specialties,
              body: skill.body,
            }
          : s,
      ),
    );
  }

  onMount(() => {
    void loadList();
    pollTimer = setInterval(() => void loadList(), 8000);
    return () => {
      if (pollTimer) clearInterval(pollTimer);
    };
  });

  const options = createMemo<SkillsViewMountOptions>(() => ({
    skills: skills(),
    initialSelected: selected(),
    onSelect: (name: string) => {
      setSelected(name);
      void hydrateSelected(name);
    },
  }));

  return <WidgetHost mount={mountSkillsView} options={options} class="h-full w-full" />;
}

export function CostsView(props: ProjectProps): JSX.Element {
  const { metrics, loaded } = createMetrics(() => props.projectName);
  const options = createMemo<CostsDashboardMountOptions>(() => {
    const m = metrics();
    // Still in flight — let the widget render its loading spinner.
    if (!m && !loaded()) return { snapshot: null };
    // Daemon answered (success or failure) but produced no metrics —
    // pass a fully-shaped empty snapshot so the widget trips its
    // "No usage yet" empty state instead of hanging on the spinner.
    const snapshot: CostsDashboardSnapshot = {
      session: m?.session ?? { startedAt: null, durationMs: 0, status: "idle", agentCount: 0 },
      tasks: (m?.tasks as CostsDashboardSnapshot["tasks"]) ?? {
        total: 0,
        completed: 0,
        failed: 0,
        retried: 0,
        completionRate: 0,
        retryRate: 0,
        avgDurationMs: 0,
        medianDurationMs: 0,
        p90DurationMs: 0,
        byMilestone: [] as CostsMilestoneEntry[],
      },
      agents: (m?.agents as CostsAgentEntry[]) ?? [],
      mission: m?.mission ?? {
        title: null,
        status: null,
        milestonesCompleted: 0,
        validationPassRate: 0,
        wallClockMs: 0,
      },
      timeline: (m?.timeline as CostsTimelineEntry[]) ?? [],
    };
    return { snapshot };
  });

  return <WidgetHost mount={mountCostsDashboard} options={options} class="h-full w-full" />;
}

export function InspectorPaneView(props: {
  projectName: string;
  currentView: string;
}): JSX.Element {
  const { events } = createProjectEvents(() => props.projectName);
  const options = createMemo<InspectorMountOptions>(() => ({
    events: events(),
    currentView: props.currentView as InspectorScope,
    hideHeartbeats: true,
  }));
  return <WidgetHost mount={mountInspector} options={options} class="h-full w-full" />;
}

/**
 * BottomPanel: replaces the placeholder. Adds a tab strip for
 * Terminal / Output (Activity). The terminal preserves its existing
 * behaviour; Output mounts the Activity widget against the same event
 * stream the Inspector uses.
 */
export function BottomPanelView(props: ProjectProps): JSX.Element {
  type Tab = "terminal" | "problems" | "output";
  const [tab, setTab] = createSignal<Tab>("terminal");
  const { events } = createProjectEvents(() => props.projectName);
  const problemCount = createMemo<number>(() => totalDiagnosticsCount(2));

  const activityOptions = createMemo<ActivityMountOptions>(() => ({
    events: events(),
    hideHeartbeats: true,
  }));

  const tabs = createMemo<TabStripItem<Tab>[]>(() => [
    { id: "terminal", label: "terminal" },
    {
      id: "problems",
      label: "problems",
      badge:
        problemCount() > 0 ? (
          <span
            data-testid="v2-problems-badge"
            class="rounded bg-[var(--red,#cc6666)] px-1 text-[9px] font-mono text-[var(--bg)]"
          >
            {problemCount()}
          </span>
        ) : undefined,
    },
    { id: "output", label: "output" },
  ]);

  return (
    <div data-testid="v2-bottom-panel-host" class="flex h-full min-h-0 flex-col overflow-hidden">
      <TabStrip
        items={tabs()}
        activeId={tab()}
        onSelect={setTab}
        testid="v2-bottom-tab"
        ariaLabel="Bottom panel sections"
      />
      <div class="min-h-0 flex-1">
        <Show when={tab() === "terminal"}>
          <Terminal id={`v2-${props.projectName}`} showHeader={false} />
        </Show>
        <Show when={tab() === "problems"}>
          <ProblemsTab />
        </Show>
        <Show when={tab() === "output"}>
          <WidgetHost mount={mountActivity} options={activityOptions} class="h-full w-full" />
        </Show>
      </div>
    </div>
  );
}
