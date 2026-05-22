/**
 * Inspector — right-rail composite for the v2 IDE shell.
 *
 * Layout (~300px target width):
 *   ┌─────────────────────────────┐
 *   │  Inspector       12 [✕/▶]  │  ← header
 *   ├─────────────────────────────┤
 *   │                             │
 *   │  ActivityView (scoped)      │  ← middle, scrollable
 *   │                             │
 *   ├─────────────────────────────┤
 *   │  [all] errors completions  │  ← severity footer
 *   └─────────────────────────────┘
 *
 * The middle pane is the existing [[ActivityView]] — no fork. Scope
 * filtering is applied at *this* level by trimming the event list before
 * it's handed to ActivityView (so ActivityView's internal search /
 * KPI filters keep working as the user expects).
 *
 * Expanded / collapsed state is controlled-or-uncontrolled, matching the
 * pattern that V2ChatView, ChatV2Root, and PlansPanelBridge all use:
 *   - host passes `expanded` + `onToggleExpanded` → controlled
 *   - host omits both → widget owns the signal internally
 *
 * VSCode-style visual: --bg-weak background, --border separator on the
 * left edge, header / footer keep the chrome thin so the timeline gets
 * as much vertical real estate as possible.
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  ActivityEvent,
  InspectorMountOptions,
  InspectorScope,
  InspectorSeverityFilter,
} from "../types";
import { ActivityView } from "./Activity";

interface InspectorViewProps {
  options: () => InspectorMountOptions;
}

/**
 * Map a view name to the event types it cares about. Keys are coarse —
 * if a key is missing, the scope is treated as "all" (no filter).
 * Extend as new event kinds land in the daemon. The `*` wildcard is
 * tolerated but useless: `all` is the canonical bypass.
 */
const SCOPE_EVENT_TYPES: Partial<Record<InspectorScope, ReadonlySet<string>>> = {
  chat: new Set([
    "chat.thread.created",
    "chat.thread.update",
    "chat.thread.stop",
    "chat.checkpoint.created",
    "chat.permission.requested",
    "dispatch",
    "completion",
  ]),
  files: new Set(["file.changed", "file.created", "file.deleted", "fs.changed"]),
  tasks: new Set(["task_created", "status_change", "completion", "dispatch", "retry", "stall"]),
  plans: new Set(["plan.created", "plan.updated", "plan.completed", "plan_done"]),
  diffs: new Set(["chat.checkpoint.created", "diff.applied", "diff.reverted"]),
  mission: new Set(["mission.changed", "milestone.changed", "validation.changed"]),
  metrics: new Set(["completion", "retry", "stall", "error", "reconcile"]),
};

function scopeMatches(scope: InspectorScope | undefined, type: string): boolean {
  if (!scope || scope === "all") return true;
  const set = SCOPE_EVENT_TYPES[scope];
  if (!set) return true;
  return set.has(type);
}

const SEVERITY_TYPES: Record<Exclude<InspectorSeverityFilter, "all">, ReadonlySet<string>> = {
  errors: new Set(["error", "stall", "retry"]),
  completions: new Set(["completion", "plan_done", "task_completed"]),
};

function severityMatches(filter: InspectorSeverityFilter, type: string): boolean {
  if (filter === "all") return true;
  return SEVERITY_TYPES[filter].has(type);
}

function eventTime(event: ActivityEvent): number {
  const t = new Date(event.timestamp).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function InspectorView(props: InspectorViewProps) {
  // Uncontrolled fallbacks. The `controlled?` accessors below resolve to
  // host-owned state when options() provides it; otherwise to these.
  const [internalExpanded, setInternalExpanded] = createSignal(
    props.options().defaultExpanded ?? true,
  );
  const [severity, setSeverity] = createSignal<InspectorSeverityFilter>(
    props.options().defaultSeverityFilter ?? "all",
  );

  const expanded = createMemo<boolean>(() => {
    const opt = props.options().expanded;
    return typeof opt === "boolean" ? opt : internalExpanded();
  });

  function toggleExpanded() {
    const next = !expanded();
    const opt = props.options();
    if (typeof opt.expanded === "boolean") {
      // Controlled — the host owns state; just notify.
      opt.onToggleExpanded?.(next);
      return;
    }
    setInternalExpanded(next);
    opt.onToggleExpanded?.(next);
  }

  const allEvents = createMemo<ReadonlyArray<ActivityEvent>>(() => props.options().events ?? []);

  // Scope + severity trim — pure transform, applied before the events
  // hit ActivityView. ActivityView's own search/KPI chips keep working
  // on this trimmed set.
  const visibleEvents = createMemo<ReadonlyArray<ActivityEvent>>(() => {
    const scope = props.options().currentView;
    const sev = severity();
    return allEvents().filter((e) => scopeMatches(scope, e.type) && severityMatches(sev, e.type));
  });

  // Header count badge — number of events in scope (regardless of
  // severity), so the chip preview matches what "all" would show.
  const scopedCount = createMemo<number>(() => {
    const scope = props.options().currentView;
    let n = 0;
    for (const e of allEvents()) if (scopeMatches(scope, e.type)) n += 1;
    return n;
  });

  // Most-recent timestamp — used to feed an "updated <relative>" chip
  // in the header. Cheap O(n); the event list is bounded by the daemon
  // (last 100 by default per /api/project/:name/events).
  const latestTs = createMemo<number>(() => {
    let max = 0;
    for (const e of allEvents()) {
      const t = eventTime(e);
      if (t > max) max = t;
    }
    return max;
  });

  return (
    <div
      data-testid="inspector-solid"
      data-inspector-expanded={expanded() ? "true" : "false"}
      data-inspector-scope={props.options().currentView ?? "all"}
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg-weak, var(--bg))",
        "border-left": "1px solid var(--border)",
        color: "var(--fg)",
        "font-family": "var(--font-sans)",
        "font-size": "var(--text-base)",
      }}
    >
      {/* Header */}
      <header
        data-testid="inspector-header"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "var(--space-2)",
          height: "var(--chrome-h)",
          "flex-shrink": "0",
          padding: "0 var(--space-2)",
          "border-bottom": "1px solid var(--border)",
          "background-color": "var(--bg-strong, var(--bg))",
          "font-size": "var(--text-sm)",
        }}
      >
        <button
          type="button"
          data-testid="inspector-toggle"
          aria-expanded={expanded()}
          onClick={toggleExpanded}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--dim)",
            cursor: "pointer",
            "font-family": "inherit",
            "font-size": "var(--text-sm)",
            padding: "0",
            width: "16px",
            "text-align": "center",
          }}
          title={expanded() ? "Collapse" : "Expand"}
        >
          {expanded() ? "▾" : "▸"}
        </button>
        <span
          style={{
            "text-transform": "uppercase",
            "letter-spacing": "0.08em",
            color: "var(--fg-secondary, var(--fg))",
            "font-size": "var(--text-xs)",
          }}
        >
          Inspector
        </span>
        <Show when={(props.options().currentView ?? "all") !== "all"}>
          <span
            data-testid="inspector-scope-badge"
            style={{
              "border-radius": "9999px",
              padding: "0 var(--space-2)",
              "font-size": "var(--text-xs)",
              background: "var(--surface)",
              color: "var(--accent)",
            }}
          >
            {props.options().currentView}
          </span>
        </Show>
        <span style={{ flex: "1" }} />
        <span
          data-testid="inspector-count"
          style={{
            "font-variant-numeric": "tabular-nums",
            color: "var(--dim)",
            "font-size": "var(--text-xs)",
          }}
          title={`${scopedCount()} events in scope`}
        >
          {scopedCount()}
        </span>
        <Show when={latestTs() > 0}>
          <span
            data-testid="inspector-pulse"
            aria-hidden="true"
            style={{
              height: "6px",
              width: "6px",
              "border-radius": "9999px",
              background: "var(--green)",
            }}
          />
        </Show>
      </header>

      {/* Middle: scrollable scoped Activity */}
      <Show
        when={expanded()}
        fallback={
          <div
            data-testid="inspector-collapsed"
            style={{
              flex: "1",
              "min-height": "0",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--dim)",
              "font-size": "var(--text-sm)",
            }}
          >
            collapsed
          </div>
        }
      >
        <div
          data-testid="inspector-body"
          style={{ flex: "1", "min-height": "0", overflow: "hidden" }}
        >
          <Show
            when={visibleEvents().length > 0}
            fallback={
              <div
                data-testid="inspector-empty"
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  height: "100%",
                  padding: "var(--space-4)",
                  "text-align": "center",
                  color: "var(--dim)",
                  "font-size": "var(--text-sm)",
                }}
              >
                no events in scope
              </div>
            }
          >
            <ActivityView
              options={() => ({
                events: visibleEvents(),
                hideHeartbeats: props.options().hideHeartbeats,
              })}
            />
          </Show>
        </div>
      </Show>

      {/* Footer — severity filter strip (inline-styled to mirror the
          dashboard TabStrip: underline-with-accent variant. Inline styles
          are kept because v2-solid-widgets can't import dashboard
          components without a cross-package cycle.) */}
      <footer
        data-testid="inspector-footer"
        role="tablist"
        aria-label="Severity filter"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "var(--space-2)",
          "flex-shrink": "0",
          height: "var(--chrome-h)",
          padding: "0 var(--space-3)",
          "border-top": "1px solid var(--border)",
          "background-color": "var(--bg-strong, var(--bg))",
          "font-size": "var(--text-sm)",
        }}
      >
        <For each={["all", "errors", "completions"] as const}>
          {(value) => {
            const active = () => severity() === value;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active()}
                data-testid={`inspector-severity-${value}`}
                data-active={active() ? "true" : "false"}
                tabIndex={active() ? 0 : -1}
                onClick={() => setSeverity(value)}
                style={{
                  background: "transparent",
                  border: "none",
                  "border-bottom": active() ? "2px solid var(--accent)" : "2px solid transparent",
                  color: active() ? "var(--accent)" : "var(--dim)",
                  cursor: "pointer",
                  "font-family": "inherit",
                  "font-size": "var(--text-sm)",
                  padding: "0 var(--space-2)",
                  height: "100%",
                  "align-self": "stretch",
                  display: "inline-flex",
                  "align-items": "center",
                }}
              >
                {value}
              </button>
            );
          }}
        </For>
      </footer>
    </div>
  );
}
