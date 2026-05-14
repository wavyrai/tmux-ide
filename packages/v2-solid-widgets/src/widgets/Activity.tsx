/**
 * Activity — Solid port of dashboard/components/activity/ActivityView.tsx.
 *
 * Stream-driven timeline. The React host owns the event list (sourced
 * from useSessionStream / the WebSocket bus) and pushes it through
 * `setOptions({ events })`. The widget owns the filter chip state, the
 * search query, the live-tail toggle, and the KPI filter — all in
 * Solid signals. New events append at the top via createMemo; only the
 * affected rows re-render thanks to Solid's fine-grained reactivity.
 *
 * Visual hierarchy mirrors the React version: KPI strip → search +
 * Live + filter chips → day-grouped sections → event rows with dot +
 * pill + message + agent chip + taskId + relative time.
 *
 * t3 alignment (context/t3code/apps/web/):
 *   - Design tokens only (var(--bg), var(--accent), var(--surface),
 *     var(--green/yellow/red/cyan/dim)) — no hardcoded hex anywhere.
 *     Replaces the React version's two rgba() literals with
 *     color-mix(in srgb, var(--bg) 90%, var(--accent)) so theme
 *     switches cascade.
 *   - Semantic data-* hooks: data-activity-section, data-activity-kpi,
 *     data-activity-event[-type], data-activity-filter,
 *     data-activity-live.
 *   - Compact 22px rows + monospace timestamps match the React view.
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { ActivityEvent, ActivityMountOptions } from "../types";

type TimelineEntry =
  | { kind: "day-header"; key: string; label: string; count: number }
  | { kind: "event"; key: string; event: ActivityEvent; isFirstInGroup: boolean };

function eventKey(event: ActivityEvent, fallbackIndex: number): string {
  // Events lack a stable id field — compose one from timestamp + type
  // + agent + taskId so virtualizer reconcile keeps stable identity
  // across re-renders.
  return `${event.timestamp}|${event.type}|${event.agent ?? ""}|${event.taskId ?? ""}|${fallbackIndex}`;
}

interface ActivityViewProps {
  options: () => ActivityMountOptions;
}

type KpiFilter = "all" | "hour" | "day" | "agents" | "types";

interface EventMeta {
  label: string;
  color: string;
}

const EVENT_META: Record<string, EventMeta> = {
  dispatch: { label: "dispatch", color: "var(--accent)" },
  completion: { label: "complete", color: "var(--green)" },
  error: { label: "error", color: "var(--red)" },
  stall: { label: "stall", color: "var(--yellow)" },
  retry: { label: "retry", color: "var(--yellow)" },
  reconcile: { label: "reconcile", color: "var(--cyan, var(--accent))" },
  task_created: { label: "task created", color: "var(--dim)" },
  status_change: { label: "status", color: "var(--dim)" },
};
const DEFAULT_META: EventMeta = { label: "event", color: "var(--dim)" };

function metaFor(type: string): EventMeta {
  return EVENT_META[type] ?? DEFAULT_META;
}

function eventTime(event: ActivityEvent): number {
  const t = new Date(event.timestamp).getTime();
  return Number.isFinite(t) ? t : 0;
}

function formatMessage(event: ActivityEvent): string {
  if (event.message) return event.message;
  const parts: string[] = [];
  if (event.agent) parts.push(event.agent);
  if (event.type === "dispatch") parts.push("dispatched");
  if (event.type === "completion") parts.push("completed");
  if (event.type === "stall") parts.push("stalled on");
  if (event.type === "retry") parts.push("retrying");
  if (event.type === "reconcile") parts.push("released");
  if (event.taskId) parts.push(`task ${event.taskId}`);
  return parts.join(" ") || event.type;
}

function formatRelative(event: ActivityEvent): string {
  if (event.relative) return event.relative;
  const delta = Date.now() - eventTime(event);
  if (!Number.isFinite(delta)) return "";
  if (delta < 60_000) return `${Math.max(0, Math.floor(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function fullTimestamp(event: ActivityEvent): string {
  const d = new Date(event.timestamp);
  if (Number.isNaN(d.getTime())) return event.timestamp;
  return d.toLocaleString();
}

function dayKey(t: number): string {
  return new Date(t).toDateString();
}

function dayLabel(key: string): string {
  const day = new Date(key);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Active-pill background tint via color-mix on the role color — replaces
// the React version's rgba() literals so theme switches still work.
function pillTint(color: string): string {
  return `color-mix(in srgb, var(--bg) 90%, ${color})`;
}

export function ActivityView(props: ActivityViewProps) {
  const [kpiFilter, setKpiFilter] = createSignal<KpiFilter>("all");
  const [selectedTypes, setSelectedTypes] = createSignal<Set<string>>(new Set());
  const [query, setQuery] = createSignal("");
  const [live, setLive] = createSignal(true);

  const rawEvents = createMemo<ReadonlyArray<ActivityEvent>>(() => props.options().events ?? []);
  const hideHeartbeats = createMemo(() => props.options().hideHeartbeats !== false);

  // Base event list: drop heartbeats (unless flagged off), sort newest-first.
  const baseEvents = createMemo<ActivityEvent[]>(() => {
    const filter = hideHeartbeats();
    return [...rawEvents()]
      .filter((e) => !filter || e.type !== "agent_heartbeat")
      .sort((a, b) => eventTime(b) - eventTime(a));
  });

  const stats = createMemo(() => {
    const now = Date.now();
    const base = baseEvents();
    const hour = base.filter((e) => now - eventTime(e) <= 3_600_000).length;
    const day = base.filter((e) => now - eventTime(e) <= 86_400_000).length;
    const agents = new Set(base.flatMap((e) => (e.agent ? [e.agent] : [])));
    const types = new Set(base.map((e) => e.type));
    return { total: base.length, hour, day, agents: agents.size, types: types.size };
  });

  const eventTypes = createMemo(() =>
    Array.from(new Set(baseEvents().map((e) => e.type))).sort((a, b) => a.localeCompare(b)),
  );

  const filteredEvents = createMemo<ActivityEvent[]>(() => {
    const now = Date.now();
    const q = query().trim().toLowerCase();
    const selected = selectedTypes();
    const kpi = kpiFilter();
    return baseEvents().filter((e) => {
      const t = eventTime(e);
      if (kpi === "hour" && now - t > 3_600_000) return false;
      if (kpi === "day" && now - t > 86_400_000) return false;
      if (kpi === "agents" && !e.agent) return false;
      if (kpi === "types" && !e.type) return false;
      if (selected.size > 0 && !selected.has(e.type)) return false;
      if (!q) return true;
      const hay = [formatMessage(e), e.agent ?? "", e.type, e.taskId ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  });

  const groups = createMemo(() => {
    const map = new Map<string, ActivityEvent[]>();
    for (const e of filteredEvents()) {
      const key = dayKey(eventTime(e));
      const rows = map.get(key) ?? [];
      rows.push(e);
      map.set(key, rows);
    }
    return Array.from(map.entries()).map(([key, rows]) => ({
      key,
      label: dayLabel(key),
      rows,
    }));
  });

  // Flatten the day-grouped event list into a single linear entry
  // stream the virtualizer can slice against. A 10k-event timeline
  // becomes a flat array of headers + events instead of nested For
  // loops rendering every row.
  const entries = createMemo<TimelineEntry[]>(() => {
    const out: TimelineEntry[] = [];
    let idx = 0;
    for (const group of groups()) {
      out.push({
        kind: "day-header",
        key: `H:${group.key}`,
        label: group.label,
        count: group.rows.length,
      });
      group.rows.forEach((event, i) => {
        out.push({
          kind: "event",
          key: `E:${group.key}:${eventKey(event, idx)}`,
          event,
          isFirstInGroup: i === 0,
        });
        idx += 1;
      });
    }
    return out;
  });

  const [timelineEl, setTimelineEl] = createSignal<HTMLDivElement | null>(null);
  const virtualizer = createVirtualizer({
    get count() {
      return entries().length;
    },
    getScrollElement: () => timelineEl(),
    estimateSize: (i) => (entries()[i]?.kind === "day-header" ? 28 : 52),
    overscan: 6,
    getItemKey: (i) => entries()[i]?.key ?? i,
  });

  // Memo wrappers for reactivity inside <For each={...}>.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const virtualTotalSize = createMemo(() => virtualizer.getTotalSize());

  function toggleType(type: string) {
    setSelectedTypes((cur) => {
      const next = new Set(cur);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function hasActiveFilters() {
    return selectedTypes().size > 0 || query().length > 0 || kpiFilter() !== "all";
  }

  function clearAll() {
    setKpiFilter("all");
    setSelectedTypes(new Set<string>());
    setQuery("");
  }

  return (
    <div
      data-testid="activity-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-family-mono, var(--font-mono))",
        "font-size": "12px",
      }}
    >
      <div
        style={{
          padding: "16px 16px 12px",
          display: "flex",
          "flex-direction": "column",
          gap: "20px",
          "flex-shrink": "0",
        }}
      >
        {/* KPI strip */}
        <section
          data-activity-section="kpis"
          style={{
            display: "grid",
            "grid-template-columns": "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "8px",
          }}
        >
          <KpiButton
            label="total events"
            value={stats().total}
            active={kpiFilter() === "all"}
            onClick={() => setKpiFilter("all")}
            id="all"
          />
          <KpiButton
            label="last hour"
            value={stats().hour}
            active={kpiFilter() === "hour"}
            onClick={() => setKpiFilter("hour")}
            color="var(--accent)"
            id="hour"
          />
          <KpiButton
            label="last 24h"
            value={stats().day}
            active={kpiFilter() === "day"}
            onClick={() => setKpiFilter("day")}
            color="var(--cyan, var(--accent))"
            id="day"
          />
          <KpiButton
            label="unique agents"
            value={stats().agents}
            active={kpiFilter() === "agents"}
            onClick={() => setKpiFilter("agents")}
            color="var(--green)"
            id="agents"
          />
          <KpiButton
            label="event types"
            value={stats().types}
            active={kpiFilter() === "types"}
            onClick={() => setKpiFilter("types")}
            color="var(--yellow)"
            id="types"
          />
        </section>

        {/* Filter chip row */}
        <section
          data-activity-section="filters"
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            "align-items": "center",
            gap: "8px",
          }}
        >
          <input
            data-testid="activity-search"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search events"
            style={{
              flex: "1 1 220px",
              "min-width": "0",
              height: "32px",
              "border-radius": "6px",
              border: "1px solid var(--border-weak, var(--border))",
              background: "var(--bg-strong, var(--surface))",
              padding: "0 12px",
              color: "var(--fg)",
              "font-family": "inherit",
              "font-size": "12px",
              outline: "none",
            }}
          />
          <button
            type="button"
            data-testid="activity-live"
            data-activity-live={live() ? "on" : "off"}
            onClick={() => setLive((v) => !v)}
            style={{
              height: "32px",
              padding: "0 12px",
              "border-radius": "6px",
              border: `1px solid ${live() ? "var(--green)" : "var(--border-weak, var(--border))"}`,
              background: live() ? pillTint("var(--green)") : "var(--bg-strong, var(--surface))",
              color: live() ? "var(--green)" : "var(--dim)",
              "font-size": "11px",
              "text-transform": "uppercase",
              "letter-spacing": "0.08em",
              "font-family": "inherit",
              cursor: "pointer",
            }}
          >
            Live
          </button>
          <For each={eventTypes()}>
            {(type) => {
              const meta = metaFor(type);
              const active = () => selectedTypes().has(type);
              return (
                <button
                  type="button"
                  data-activity-filter={type}
                  data-activity-filter-active={active() ? "true" : "false"}
                  onClick={() => toggleType(type)}
                  style={{
                    height: "28px",
                    padding: "0 8px",
                    "border-radius": "6px",
                    border: `1px solid ${active() ? "var(--accent)" : "var(--border-weak, var(--border))"}`,
                    background: active()
                      ? "var(--surface-active, var(--surface))"
                      : "var(--bg-strong, var(--surface))",
                    color: active() ? "var(--accent)" : meta.color,
                    "font-size": "11px",
                    "font-family": "inherit",
                    cursor: "pointer",
                  }}
                >
                  {type.replaceAll("_", " ")}
                </button>
              );
            }}
          </For>
          <Show when={hasActiveFilters()}>
            <button
              type="button"
              data-testid="activity-clear"
              onClick={clearAll}
              style={{
                height: "28px",
                padding: "0 8px",
                "border-radius": "6px",
                border: "1px solid var(--border-weak, var(--border))",
                background: "transparent",
                color: "var(--dim)",
                "font-size": "11px",
                "font-family": "inherit",
                cursor: "pointer",
              }}
            >
              clear
            </button>
          </Show>
        </section>
      </div>

      {/* Virtualized event timeline. The day-grouped entries are
       *  flattened (`entries()`) so the virtualizer slices a flat
       *  list of headers + events. Only the rows in the viewport
       *  (plus overscan) actually live in the DOM. */}
      <Show
        when={groups().length > 0}
        fallback={
          <div
            data-testid="activity-empty"
            style={{
              padding: "32px",
              "text-align": "center",
              color: "var(--dim)",
            }}
          >
            <div style={{ "margin-bottom": "4px", color: "var(--fg-secondary, var(--fg))" }}>
              No activity yet
            </div>
            <div style={{ "font-size": "11px" }}>
              New dispatches, completions, retries, and errors will appear here.
            </div>
          </div>
        }
      >
        <section
          ref={setTimelineEl}
          data-activity-section="timeline"
          style={{
            flex: "1",
            "min-height": "0",
            "overflow-y": "auto",
            padding: "0 16px 16px",
            position: "relative",
          }}
        >
          <div
            data-testid="activity-timeline-spacer"
            style={{
              height: `${virtualTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            <For each={virtualItems()}>
              {(vItem) => {
                const entry = createMemo(() => entries()[vItem.index]!, undefined, {
                  equals: (a, b) => !!a && !!b && a.key === b.key,
                });
                return (
                  <div
                    data-index={vItem.index}
                    ref={(el) => virtualizer.measureElement(el)}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <TimelineRow entry={entry()} />
                  </div>
                );
              }}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

interface TimelineRowProps {
  entry: TimelineEntry;
}

function TimelineRow(props: TimelineRowProps) {
  return (
    <Show when={props.entry} keyed>
      {(entry) =>
        entry.kind === "day-header" ? (
          <div
            data-activity-day={entry.key}
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              background: "var(--bg)",
              padding: "8px 0 4px",
              "font-size": "10px",
              "text-transform": "uppercase",
              "letter-spacing": "0.08em",
              color: "var(--dim)",
            }}
          >
            <span>{entry.label}</span>
            <span style={{ "font-variant-numeric": "tabular-nums" }}>{entry.count}</span>
          </div>
        ) : (
          <EventRow event={entry.event} isFirstInGroup={entry.isFirstInGroup} />
        )
      }
    </Show>
  );
}

function EventRow(props: { event: ActivityEvent; isFirstInGroup: boolean }) {
  return (
    <Show when={props.event} keyed>
      {(event) => {
        const meta = metaFor(event.type);
        const label = meta.label.replaceAll("_", " ");
        return (
          <div data-activity-day-row>
            <div
              data-testid="activity-event"
              data-activity-event-type={event.type}
              style={{
                display: "grid",
                "grid-template-columns": "10px minmax(0, 1fr) auto",
                "align-items": "center",
                gap: "12px",
                padding: "8px 12px",
                "border-radius": "6px",
                border: "1px solid var(--border-weak, var(--border))",
                "border-top": props.isFirstInGroup
                  ? "1px solid var(--border-weak, var(--border))"
                  : "none",
                "border-top-left-radius": props.isFirstInGroup ? "6px" : "0",
                "border-top-right-radius": props.isFirstInGroup ? "6px" : "0",
                background: "var(--bg-strong, var(--surface))",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--surface-hover, var(--surface))";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-strong, var(--surface))";
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  height: "8px",
                  width: "8px",
                  "border-radius": "9999px",
                  background: meta.color,
                }}
              />
              <div style={{ "min-width": "0" }}>
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    "min-width": "0",
                  }}
                >
                  <span
                    data-activity-pill
                    style={{
                      "flex-shrink": "0",
                      padding: "1px 6px",
                      "border-radius": "9999px",
                      background: pillTint(meta.color),
                      color: meta.color,
                      "font-size": "10px",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.05em",
                    }}
                  >
                    {label}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      "font-size": "12px",
                      color: "var(--fg)",
                    }}
                  >
                    {formatMessage(event)}
                  </span>
                </div>
                <Show when={event.agent || event.taskId}>
                  <div
                    style={{
                      "margin-top": "4px",
                      display: "flex",
                      "align-items": "center",
                      gap: "8px",
                      "min-width": "0",
                      "font-size": "10px",
                      color: "var(--dim)",
                    }}
                  >
                    <Show when={event.agent}>
                      <span
                        style={{
                          "border-radius": "4px",
                          background: "var(--surface)",
                          padding: "1px 6px",
                          color: "var(--cyan, var(--accent))",
                        }}
                      >
                        @{event.agent}
                      </span>
                    </Show>
                    <Show when={event.taskId}>
                      <code
                        style={{
                          "font-family": "inherit",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        {event.taskId}
                      </code>
                    </Show>
                  </div>
                </Show>
              </div>
              <time
                dateTime={event.timestamp}
                title={fullTimestamp(event)}
                style={{
                  "text-align": "right",
                  "font-size": "11px",
                  "font-variant-numeric": "tabular-nums",
                  color: "var(--dim)",
                }}
              >
                {formatRelative(event)}
              </time>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

function KpiButton(props: {
  id: string;
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      data-activity-kpi={props.id}
      data-activity-kpi-active={props.active ? "true" : "false"}
      onClick={props.onClick}
      style={{
        "border-radius": "6px",
        border: `1px solid ${props.active ? "var(--accent)" : "var(--border)"}`,
        background: props.active ? "var(--surface-active, var(--surface))" : "var(--surface)",
        padding: "10px 12px",
        cursor: "pointer",
        "text-align": "left",
        "font-family": "inherit",
      }}
    >
      <div
        style={{
          "font-size": "10px",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
          color: "var(--dim)",
          "margin-bottom": "4px",
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          "font-size": "18px",
          "font-weight": "500",
          color: props.color ?? "var(--fg)",
          "font-variant-numeric": "tabular-nums",
        }}
      >
        {props.value}
      </div>
    </button>
  );
}
