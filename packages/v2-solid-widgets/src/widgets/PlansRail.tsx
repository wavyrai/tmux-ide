/**
 * PlansRail — Solid port of dashboard/components/plans/PlansView.tsx's
 * `PlanListNavigator`. Renders the left rail: search, sort, grouped plan
 * sections (pending / in-progress / done / archived), each row showing a
 * status-color dot + title + status pill + owner / updated / tags meta.
 *
 * Polls `/api/project/:name/plans` every 5 seconds. The currently selected
 * plan is owned by the React host (passed via `selectedFile` in options);
 * row clicks fire `onSelect(filename)` so the host can swap the detail.
 *
 * Inline styles use CSS variables (`--bg-weak`, `--border`, `--accent`,
 * etc.) — the dashboard's globals.css supplies the values, so the rail
 * picks up theme switches without any extra wiring.
 */
import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { fetchProjectPlans, type PlanStatus, type PlanSummary } from "../api";
import type { PlansRailMountOptions } from "../types";

type PlansRailEntry =
  | { kind: "group-header"; key: string; status: PlanStatus; count: number }
  | { kind: "plan"; key: string; plan: PlanSummary };

interface PlansRailViewProps {
  options: () => PlansRailMountOptions;
}

type PlanSort = "recent" | "status" | "title" | "owner";

const RAIL_STATUSES: PlanStatus[] = ["in-progress", "pending", "done", "archived"];
const STATUS_ORDER: Record<PlanStatus, number> = {
  "in-progress": 0,
  pending: 1,
  done: 2,
  archived: 3,
};
const STATUS_DOT: Record<PlanStatus, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--dim)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};
const STATUS_PILL_BG: Record<PlanStatus, string> = {
  "in-progress": "color-mix(in oklab, var(--yellow) 15%, transparent)",
  pending: "color-mix(in oklab, var(--dim) 15%, transparent)",
  done: "color-mix(in oklab, var(--green) 15%, transparent)",
  archived: "color-mix(in oklab, var(--dimmer) 15%, transparent)",
};
const STATUS_PILL_FG: Record<PlanStatus, string> = {
  "in-progress": "var(--yellow)",
  pending: "var(--fg-secondary)",
  done: "var(--green)",
  archived: "var(--dimmer)",
};

function statusLabel(status: PlanStatus): string {
  return status === "in-progress" ? "in progress" : status;
}

function planFilename(plan: PlanSummary): string {
  return plan.path || `${plan.name}.md`;
}

function planOwner(plan: PlanSummary): string {
  return plan.owner?.trim() || "unowned";
}

function planTimestamp(plan: PlanSummary): number {
  const raw = plan.updated ?? plan.completed;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "not updated";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return String(value);
  const ms = Date.now() - t;
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function PlansRailView(props: PlansRailViewProps) {
  const [plans, setPlans] = createSignal<PlanSummary[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<PlanSort>("recent");
  const [collapsed, setCollapsed] = createSignal<Partial<Record<PlanStatus, boolean>>>({});

  async function refresh() {
    try {
      const data = await fetchProjectPlans(props.options());
      setPlans(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    onCleanup(() => clearInterval(interval));
  });

  const visiblePlans = createMemo<PlanSummary[]>(() => {
    const q = query().toLowerCase().trim();
    const filtered = q
      ? plans().filter((p) => {
          const title = (p.title || p.name).toLowerCase();
          const owner = (p.owner ?? "").toLowerCase();
          const tags = (p.tags ?? []).join(" ").toLowerCase();
          return title.includes(q) || owner.includes(q) || tags.includes(q);
        })
      : plans();
    const sorted = [...filtered];
    switch (sort()) {
      case "recent":
        sorted.sort((a, b) => planTimestamp(b) - planTimestamp(a));
        break;
      case "status":
        sorted.sort(
          (a, b) =>
            STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
            (a.title || a.name).localeCompare(b.title || b.name),
        );
        break;
      case "title":
        sorted.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
        break;
      case "owner":
        sorted.sort((a, b) => planOwner(a).localeCompare(planOwner(b)));
        break;
    }
    return sorted;
  });

  const planGroups = createMemo(() =>
    RAIL_STATUSES.map((status) => ({
      status,
      plans: visiblePlans().filter((p) => p.status === status),
    })),
  );

  // Flatten the grouped plan list to feed the virtualizer with a
  // single linear stream of (group-header | plan) entries. Collapsed
  // groups contribute only their header.
  const railEntries = createMemo<PlansRailEntry[]>(() => {
    const out: PlansRailEntry[] = [];
    for (const group of planGroups()) {
      out.push({
        kind: "group-header",
        key: `H:${group.status}`,
        status: group.status,
        count: group.plans.length,
      });
      if (collapsed()[group.status]) continue;
      for (const plan of group.plans) {
        out.push({ kind: "plan", key: `P:${planFilename(plan)}`, plan });
      }
    }
    return out;
  });

  const [railEl, setRailEl] = createSignal<HTMLDivElement | null>(null);
  const railVirtualizer = createVirtualizer({
    get count() {
      return railEntries().length;
    },
    getScrollElement: () => railEl(),
    // Group headers ≈ 32px, plan rows ≈ 60px (title + meta line).
    estimateSize: (i) => (railEntries()[i]?.kind === "group-header" ? 32 : 60),
    overscan: 6,
    getItemKey: (i) => railEntries()[i]?.key ?? i,
  });

  function toggleGroup(status: PlanStatus) {
    setCollapsed((cur) => ({ ...cur, [status]: !cur[status] }));
  }

  function handleSelect(file: string) {
    props.options().onSelect?.(file);
  }

  function handleCreate() {
    props.options().onCreate?.();
  }

  return (
    <div
      data-testid="plans-rail-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg-weak)",
        color: "var(--fg)",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
      }}
    >
      {/* Header — label, count, search, sort */}
      <div
        style={{
          padding: "var(--space-3)",
          "border-bottom": "1px solid var(--border)",
          "flex-shrink": "0",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "var(--space-2)",
            "margin-bottom": "8px",
            "font-size": "var(--text-sm)",
            color: "var(--dim)",
          }}
        >
          <span>plans</span>
          <span style={{ "margin-left": "auto", "font-variant-numeric": "tabular-nums" }}>
            {visiblePlans().length}/{plans().length}
          </span>
        </div>
        <input
          data-testid="plans-rail-search"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="search plans"
          style={{
            "box-sizing": "border-box",
            "margin-bottom": "8px",
            height: "32px",
            width: "100%",
            "border-radius": "6px",
            border: "1px solid var(--border)",
            "background-color": "var(--bg-strong)",
            padding: "0 var(--space-2)",
            "font-size": "var(--text-base)",
            color: "var(--fg)",
            outline: "none",
          }}
        />
        <select
          data-testid="plans-rail-sort"
          value={sort()}
          onChange={(e) => setSort(e.currentTarget.value as PlanSort)}
          style={{
            "box-sizing": "border-box",
            height: "32px",
            width: "100%",
            "border-radius": "6px",
            border: "1px solid var(--border)",
            "background-color": "var(--bg-strong)",
            padding: "0 var(--space-2)",
            "font-size": "var(--text-base)",
            color: "var(--fg-secondary)",
            outline: "none",
          }}
        >
          <option value="recent">recently updated</option>
          <option value="status">status</option>
          <option value="title">title</option>
          <option value="owner">owner</option>
        </select>
      </div>

      {/* Body — grouped sections, OR the offline empty state when the
          daemon is unreachable and we don't have stale plans to show.
          A transient failure with stale plans in hand keeps the list
          visible; only a cold-start error swaps in the empty state. */}
      <Show when={error() && plans().length === 0}>
        <div
          data-testid="plans-rail-offline"
          style={{
            flex: "1",
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            "justify-content": "center",
            gap: "var(--space-2)",
            padding: "var(--space-6) var(--space-4)",
            "text-align": "center",
            color: "var(--dim)",
          }}
        >
          <div style={{ color: "var(--fg-secondary)", "font-size": "var(--text-base)" }}>
            Couldn't reach the daemon
          </div>
          <div style={{ "font-size": "var(--text-xs)" }}>
            The plans rail will refresh automatically once the connection is back.
          </div>
        </div>
      </Show>
      <div
        ref={setRailEl}
        data-testid="plans-rail-list"
        style={{
          "min-height": "0",
          flex: "1",
          "overflow-y": "auto",
          display: error() && plans().length === 0 ? "none" : "block",
          position: "relative",
        }}
      >
        <div
          data-testid="plans-rail-spacer"
          style={{
            height: `${railVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={railVirtualizer.getVirtualItems()}>
            {(vItem) => {
              const entry = () => railEntries()[vItem.index];
              return (
                <Show when={entry()}>
                  <div
                    data-index={vItem.index}
                    ref={(el) => railVirtualizer.measureElement(el)}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <Show when={entry()!.kind === "group-header"}>
                      {(() => {
                        const e = entry()! as Extract<PlansRailEntry, { kind: "group-header" }>;
                        const isCollapsed = () => Boolean(collapsed()[e.status]);
                        return (
                          <button
                            type="button"
                            onClick={() => toggleGroup(e.status)}
                            aria-expanded={!isCollapsed()}
                            style={{
                              display: "flex",
                              "align-items": "center",
                              gap: "var(--space-2)",
                              height: "32px",
                              width: "100%",
                              padding: "0 var(--space-3)",
                              "text-align": "left",
                              "font-size": "var(--text-xs)",
                              "text-transform": "uppercase",
                              "letter-spacing": "0.08em",
                              color: "var(--dim)",
                              background: "transparent",
                              border: "none",
                              "border-bottom": "1px solid var(--border-weak)",
                              cursor: "pointer",
                            }}
                          >
                            <span style={{ width: "12px", color: "var(--dimmer)" }}>
                              {isCollapsed() ? "+" : "-"}
                            </span>
                            <span>{statusLabel(e.status)}</span>
                            <span
                              style={{
                                "margin-left": "auto",
                                "font-variant-numeric": "tabular-nums",
                              }}
                            >
                              {e.count}
                            </span>
                          </button>
                        );
                      })()}
                    </Show>
                    <Show when={entry()!.kind === "plan"}>
                      {(() => {
                        const plan = (entry()! as Extract<PlansRailEntry, { kind: "plan" }>).plan;
                        const file = planFilename(plan);
                        const isSelected = () => file === props.options().selectedFile;
                        return (
                          <button
                            type="button"
                            data-testid="plans-rail-item"
                            data-plan-file={file}
                            data-plan-status={plan.status}
                            onClick={() => handleSelect(file)}
                            style={{
                              display: "block",
                              width: "100%",
                              padding: "var(--space-2) var(--space-3)",
                              "text-align": "left",
                              border: "none",
                              background: isSelected() ? "var(--surface-active)" : "transparent",
                              cursor: "pointer",
                              transition: "background-color 80ms ease",
                              "font-family": "inherit",
                              "font-size": "inherit",
                              color: "inherit",
                            }}
                            onMouseEnter={(ev) => {
                              if (!isSelected()) {
                                ev.currentTarget.style.background = "var(--surface-hover)";
                              }
                            }}
                            onMouseLeave={(ev) => {
                              if (!isSelected()) {
                                ev.currentTarget.style.background = "transparent";
                              }
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                "align-items": "center",
                                gap: "var(--space-2)",
                              }}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  height: "6px",
                                  width: "6px",
                                  "flex-shrink": "0",
                                  "border-radius": "9999px",
                                  background: STATUS_DOT[plan.status],
                                }}
                              />
                              <span
                                style={{
                                  "min-width": "0",
                                  flex: "1",
                                  overflow: "hidden",
                                  "text-overflow": "ellipsis",
                                  "white-space": "nowrap",
                                  "font-size": "var(--text-base)",
                                  color: "var(--fg)",
                                }}
                              >
                                {plan.title || plan.name}
                              </span>
                              <span
                                style={{
                                  "flex-shrink": "0",
                                  "border-radius": "9999px",
                                  padding: "var(--space-1) var(--space-2)",
                                  "font-size": "var(--text-xs)",
                                  background: STATUS_PILL_BG[plan.status],
                                  color: STATUS_PILL_FG[plan.status],
                                }}
                              >
                                {statusLabel(plan.status)}
                              </span>
                            </div>
                            <div
                              style={{
                                "margin-top": "4px",
                                display: "flex",
                                "min-width": "0",
                                "align-items": "center",
                                gap: "var(--space-2)",
                                "font-size": "var(--text-xs)",
                                color: "var(--dimmer)",
                              }}
                            >
                              <span
                                style={{
                                  overflow: "hidden",
                                  "text-overflow": "ellipsis",
                                  "white-space": "nowrap",
                                }}
                              >
                                @{planOwner(plan)}
                              </span>
                              <span>·</span>
                              <span
                                style={{
                                  "flex-shrink": "0",
                                  "font-variant-numeric": "tabular-nums",
                                }}
                              >
                                {formatRelativeTime(plan.updated ?? plan.completed)}
                              </span>
                              <For each={(plan.tags ?? []).slice(0, 2)}>
                                {(tag) => (
                                  <span
                                    style={{
                                      "min-width": "0",
                                      "max-width": "80px",
                                      overflow: "hidden",
                                      "text-overflow": "ellipsis",
                                      "white-space": "nowrap",
                                      "border-radius": "4px",
                                      background: "var(--surface)",
                                      padding: "0 4px",
                                      color: "var(--fg-secondary)",
                                    }}
                                  >
                                    #{tag}
                                  </span>
                                )}
                              </For>
                            </div>
                          </button>
                        );
                      })()}
                    </Show>
                  </div>
                </Show>
              );
            }}
          </For>
        </div>
      </div>

      {/* Footer — New plan */}
      <div
        style={{
          padding: "var(--space-3)",
          "border-top": "1px solid var(--border)",
          "flex-shrink": "0",
        }}
      >
        <button
          type="button"
          data-testid="plans-rail-create"
          onClick={handleCreate}
          style={{
            height: "32px",
            width: "100%",
            "border-radius": "6px",
            border: "1px solid var(--border)",
            "background-color": "var(--bg-strong)",
            "font-size": "var(--text-sm)",
            color: "var(--fg-secondary)",
            cursor: "pointer",
            "font-family": "inherit",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--accent)";
            e.currentTarget.style.color = "var(--accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--fg-secondary)";
          }}
        >
          New plan
        </button>
      </div>
    </div>
  );
}
