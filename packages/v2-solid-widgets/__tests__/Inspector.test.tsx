import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { InspectorView } from "../src/widgets/Inspector";
import type { ActivityEvent, InspectorMountOptions } from "../src/types";

function mount(initial: InspectorMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<InspectorMountOptions>(initial);
  const dispose = render(() => <InspectorView options={options} />, container);
  return {
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
    setOptions: (next: Partial<InspectorMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

const NOW = Date.now();
function ev(type: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    timestamp: new Date(NOW - 60_000).toISOString(),
    type,
    message: `${type} happened`,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("InspectorView", () => {
  it("renders the empty-state placeholder when no events match the scope", () => {
    const { container, dispose } = mount({ events: [], currentView: "all" });
    const empty = container.querySelector('[data-testid="inspector-empty"]');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain("no events in scope");
    dispose();
  });

  it("renders events when they are in scope", () => {
    const { container, dispose } = mount({
      events: [ev("dispatch"), ev("completion"), ev("retry")],
      currentView: "tasks",
    });
    const rows = container.querySelectorAll('[data-testid="activity-event"]');
    // tasks scope keeps dispatch + completion + retry (all in the SCOPE_EVENT_TYPES set).
    expect(rows.length).toBeGreaterThanOrEqual(3);
    dispose();
  });

  it("scopes the event list based on currentView", () => {
    const { container, dispose, setOptions } = mount({
      events: [ev("dispatch"), ev("file.changed"), ev("plan.created")],
      currentView: "files",
    });
    // files scope keeps file.* events only — dispatch + plan.created should drop.
    const rowsFiles = container.querySelectorAll('[data-testid="activity-event"]');
    const typesFiles = Array.from(rowsFiles).map(
      (r) => r.getAttribute("data-activity-event-type") ?? "",
    );
    expect(typesFiles).toContain("file.changed");
    expect(typesFiles).not.toContain("dispatch");

    // Switch scope to plans — file.changed should drop, plan.created should appear.
    setOptions({ currentView: "plans" });
    const rowsPlans = container.querySelectorAll('[data-testid="activity-event"]');
    const typesPlans = Array.from(rowsPlans).map(
      (r) => r.getAttribute("data-activity-event-type") ?? "",
    );
    expect(typesPlans).toContain("plan.created");
    expect(typesPlans).not.toContain("file.changed");
    dispose();
  });

  it("filters events by severity (errors keep error/stall/retry)", () => {
    const { container, dispose } = mount({
      events: [ev("dispatch"), ev("error"), ev("stall"), ev("completion")],
      currentView: "all",
      defaultSeverityFilter: "errors",
    });
    const rows = container.querySelectorAll('[data-testid="activity-event"]');
    const types = Array.from(rows).map((r) => r.getAttribute("data-activity-event-type") ?? "");
    expect(types).toContain("error");
    expect(types).toContain("stall");
    expect(types).not.toContain("dispatch");
    expect(types).not.toContain("completion");
    dispose();
  });

  it("collapses the body and shows the collapsed placeholder when expanded=false", () => {
    const { container, dispose } = mount({
      events: [ev("dispatch")],
      currentView: "all",
      expanded: false,
    });
    expect(container.querySelector('[data-testid="inspector-collapsed"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="activity-event"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inspector-solid"]')
        ?.getAttribute("data-inspector-expanded"),
    ).toBe("false");
    dispose();
  });

  it("fires onToggleExpanded with the next value when the caret is clicked", () => {
    const onToggle = vi.fn();
    const { container, dispose } = mount({
      events: [],
      expanded: true,
      onToggleExpanded: onToggle,
    });
    const btn = container.querySelector('[data-testid="inspector-toggle"]') as HTMLButtonElement;
    btn.click();
    expect(onToggle).toHaveBeenCalledWith(false);
    dispose();
  });

  it("reflects live-appended events when the host pushes a new array", () => {
    const { container, dispose, setOptions } = mount({
      events: [ev("dispatch")],
      currentView: "all",
    });
    const before = container.querySelectorAll('[data-testid="activity-event"]').length;
    setOptions({
      events: [ev("dispatch"), ev("completion"), ev("retry")],
    });
    const after = container.querySelectorAll('[data-testid="activity-event"]').length;
    expect(after).toBeGreaterThan(before);
    dispose();
  });

  it("shows the scope badge when currentView !== 'all'", () => {
    const { container, dispose, setOptions } = mount({
      events: [],
      currentView: "chat",
    });
    expect(container.querySelector('[data-testid="inspector-scope-badge"]')?.textContent).toBe(
      "chat",
    );
    setOptions({ currentView: "all" });
    expect(container.querySelector('[data-testid="inspector-scope-badge"]')).toBeNull();
    dispose();
  });

  it("count badge reflects events in scope (regardless of severity filter)", () => {
    const { container, dispose } = mount({
      events: [ev("dispatch"), ev("error"), ev("stall"), ev("file.changed")],
      currentView: "tasks",
      defaultSeverityFilter: "errors",
    });
    // tasks scope keeps dispatch + stall = 2 (error + file.changed are both
    // out of the tasks scope set).
    expect(container.querySelector('[data-testid="inspector-count"]')?.textContent).toBe("2");
    dispose();
  });
});
