import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ActivityView } from "../src/widgets/Activity";
import type { ActivityEvent, ActivityMountOptions } from "../src/types";

function mountWidget(initial: ActivityMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<ActivityMountOptions>(initial);
  const dispose = render(() => <ActivityView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<ActivityMountOptions>) => setOptions((cur) => ({ ...cur, ...next })),
  };
}

// Use fixed timestamps that are within the "last hour" window relative to
// `now` so the KPI filter tests are stable across runs.
function recent(offsetSec: number, fields: Partial<ActivityEvent>): ActivityEvent {
  const t = new Date(Date.now() - offsetSec * 1000).toISOString();
  return {
    timestamp: t,
    type: fields.type ?? "dispatch",
    message: fields.message ?? "",
    agent: fields.agent ?? null,
    taskId: fields.taskId,
    relative: fields.relative,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Activity (Solid widget)", () => {
  it("renders the empty state when no events are passed", () => {
    const { container, dispose } = mountWidget({ events: [] });
    expect(container.querySelector("[data-testid='activity-empty']")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(0);
    dispose();
  });

  it("renders a single event with classified pill + message + agent + taskId", () => {
    const event = recent(30, {
      type: "completion",
      message: "Camille finished T104",
      agent: "Camille",
      taskId: "104",
    });
    const { container, dispose } = mountWidget({ events: [event] });

    const rows = container.querySelectorAll<HTMLElement>("[data-testid='activity-event']");
    expect(rows.length).toBe(1);
    expect(rows[0]?.dataset.activityEventType).toBe("completion");
    expect(rows[0]?.textContent).toContain("Camille finished T104");
    expect(rows[0]?.textContent).toContain("@Camille");
    expect(rows[0]?.textContent).toContain("104");

    // Pill color comes from EVENT_META.completion = var(--green)
    const pill = rows[0]?.querySelector<HTMLElement>("[data-activity-pill]");
    expect(pill?.style.color).toBe("var(--green)");

    dispose();
  });

  it("re-renders when a new event is pushed via setOptions (live append)", () => {
    const initial: ActivityEvent[] = [
      recent(120, { type: "dispatch", message: "first event", agent: "A" }),
    ];
    const { container, setOptions, dispose } = mountWidget({ events: initial });
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(1);

    // Append a new event with a newer timestamp; widget sorts newest-first.
    const next: ActivityEvent[] = [
      ...initial,
      recent(5, { type: "completion", message: "newest event", agent: "B", taskId: "999" }),
    ];
    setOptions({ events: next });

    const rows = container.querySelectorAll<HTMLElement>("[data-testid='activity-event']");
    expect(rows.length).toBe(2);
    // First row is the newest by timestamp.
    expect(rows[0]?.textContent).toContain("newest event");
    expect(rows[1]?.textContent).toContain("first event");
    dispose();
  });

  it("filters by type when a chip is clicked", () => {
    const events: ActivityEvent[] = [
      recent(10, { type: "dispatch", message: "d1" }),
      recent(20, { type: "completion", message: "c1" }),
      recent(30, { type: "error", message: "e1" }),
      recent(40, { type: "completion", message: "c2" }),
    ];
    const { container, dispose } = mountWidget({ events });
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(4);

    // Click the "completion" filter chip; only c1 + c2 remain.
    const completionChip = container.querySelector<HTMLElement>(
      "[data-activity-filter='completion']",
    );
    expect(completionChip).toBeTruthy();
    completionChip!.click();

    const remaining = container.querySelectorAll<HTMLElement>("[data-testid='activity-event']");
    expect(remaining.length).toBe(2);
    expect(Array.from(remaining).every((r) => r.dataset.activityEventType === "completion")).toBe(
      true,
    );

    // The clear button appears once a filter is active; click it to restore.
    const clear = container.querySelector<HTMLElement>("[data-testid='activity-clear']");
    expect(clear).toBeTruthy();
    clear!.click();
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(4);

    dispose();
  });

  it("color-codes pills by event kind", () => {
    const events: ActivityEvent[] = [
      recent(1, { type: "dispatch", message: "d" }),
      recent(2, { type: "completion", message: "c" }),
      recent(3, { type: "error", message: "e" }),
      recent(4, { type: "retry", message: "r" }),
    ];
    const { container, dispose } = mountWidget({ events });

    const pillFor = (type: string) =>
      container
        .querySelector<HTMLElement>(`[data-activity-event-type='${type}']`)
        ?.querySelector<HTMLElement>("[data-activity-pill]");

    expect(pillFor("dispatch")?.style.color).toBe("var(--accent)");
    expect(pillFor("completion")?.style.color).toBe("var(--green)");
    expect(pillFor("error")?.style.color).toBe("var(--red)");
    expect(pillFor("retry")?.style.color).toBe("var(--yellow)");

    dispose();
  });

  it("filters by search query (matches message, agent, type, taskId)", () => {
    const events: ActivityEvent[] = [
      recent(10, { type: "dispatch", message: "alpha", agent: "Camille" }),
      recent(20, { type: "completion", message: "beta", agent: "Pty" }),
      recent(30, { type: "error", message: "gamma", taskId: "T999" }),
    ];
    const { container, dispose } = mountWidget({ events });

    const search = container.querySelector<HTMLInputElement>("[data-testid='activity-search']");
    expect(search).toBeTruthy();
    search!.value = "Camille";
    search!.dispatchEvent(new Event("input", { bubbles: true }));

    const filtered = container.querySelectorAll<HTMLElement>("[data-testid='activity-event']");
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.textContent).toContain("alpha");
    dispose();
  });

  it("hides agent_heartbeat by default; preserves them when hideHeartbeats=false", () => {
    const events: ActivityEvent[] = [
      recent(10, { type: "dispatch", message: "real" }),
      recent(20, { type: "agent_heartbeat", message: "noise" }),
      recent(30, { type: "agent_heartbeat", message: "more noise" }),
    ];
    const { container, setOptions, dispose } = mountWidget({ events });
    // Default: heartbeats hidden.
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(1);

    // Toggle off to surface them.
    setOptions({ hideHeartbeats: false });
    expect(container.querySelectorAll("[data-testid='activity-event']").length).toBe(3);

    dispose();
  });
});
