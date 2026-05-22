/**
 * TasksView Solid widget — unit tests.
 *
 * Pure renderer tests: mount → assert DOM. No network, no async setup.
 * Mirrors MissionControlDashboard.test.tsx style.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TasksViewView } from "../src/widgets/TasksView";
import type { TasksTask, TasksViewMountOptions } from "../src/types";

function mountWidget(initial: TasksViewMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<TasksViewMountOptions>(initial);
  const dispose = render(() => <TasksViewView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<TasksViewMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

let mounted: { container: HTMLElement; dispose: () => void } | null = null;
afterEach(() => {
  mounted?.dispose();
  if (mounted?.container.parentNode) {
    mounted.container.parentNode.removeChild(mounted.container);
  }
  mounted = null;
});

function task(overrides: Partial<TasksTask> = {}): TasksTask {
  return {
    id: "001",
    title: "Sample task",
    status: "todo",
    priority: 2,
    assignee: "Frontend",
    goal: "13",
    milestone: null,
    tags: [],
    depends_on: [],
    description: "A description",
    created: "2026-05-01T00:00:00.000Z",
    updated: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("TasksView widget", () => {
  it("renders the empty state when no tasks are provided", () => {
    mounted = mountWidget({ tasks: [] });
    const empty = mounted.container.querySelector("[data-empty-state]");
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain("no tasks yet");
    expect(mounted.container.querySelector("[data-testid='tasks-table']")).toBeNull();
  });

  it("renders one row per task in canonical sort order (in-progress before todo before done)", () => {
    const tasks: TasksTask[] = [
      task({ id: "001", title: "First", status: "done" }),
      task({ id: "002", title: "Second", status: "in-progress" }),
      task({ id: "003", title: "Third", status: "todo" }),
    ];
    mounted = mountWidget({ tasks });
    const rows = Array.from(mounted.container.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["002", "003", "001"]);
  });

  it("filters by status when a chip is toggled", () => {
    const tasks: TasksTask[] = [
      task({ id: "001", status: "todo" }),
      task({ id: "002", status: "done" }),
      task({ id: "003", status: "in-progress" }),
    ];
    mounted = mountWidget({ tasks });
    // Click the "done" status chip.
    const doneChip = mounted.container.querySelector<HTMLButtonElement>(
      '[data-filter-group="status"] [data-filter-key="done"]',
    );
    expect(doneChip).toBeTruthy();
    doneChip!.click();
    const rows = Array.from(
      mounted.container.querySelectorAll<HTMLTableRowElement>('[data-testid="task-row"]'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-task-id")).toBe("002");
    expect(doneChip!.getAttribute("data-filter-selected")).toBe("true");
  });

  it("filters by goal when a goal chip is selected", () => {
    const tasks: TasksTask[] = [
      task({ id: "001", goal: "13" }),
      task({ id: "002", goal: "14" }),
      task({ id: "003", goal: "13" }),
    ];
    mounted = mountWidget({
      tasks,
      goals: [
        { id: "13", title: "Chat parity" },
        { id: "14", title: "Architecture parity" },
      ],
    });
    const goal14 = mounted.container.querySelector<HTMLButtonElement>(
      '[data-filter-group="goal"] [data-filter-key="14"]',
    );
    expect(goal14).toBeTruthy();
    goal14!.click();
    const ids = Array.from(
      mounted.container.querySelectorAll<HTMLTableRowElement>('[data-testid="task-row"]'),
    ).map((r) => r.getAttribute("data-task-id"));
    expect(ids).toEqual(["002"]);
  });

  it("filters by priority and clears all filters via the clear button", () => {
    const tasks: TasksTask[] = [
      task({ id: "001", priority: 1 }),
      task({ id: "002", priority: 4 }),
      task({ id: "003", priority: 1 }),
    ];
    mounted = mountWidget({ tasks });
    const p1 = mounted.container.querySelector<HTMLButtonElement>(
      '[data-filter-group="priority"] [data-filter-key="1"]',
    );
    p1!.click();
    expect(mounted.container.querySelectorAll('[data-testid="task-row"]').length).toBe(2);
    const clear = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="tasks-clear-filters"]',
    );
    expect(clear).toBeTruthy();
    clear!.click();
    expect(mounted.container.querySelectorAll('[data-testid="task-row"]').length).toBe(3);
    expect(p1!.getAttribute("data-filter-selected")).toBe("false");
  });

  it("opens the detail panel when a row is clicked and closes it on close-button click", () => {
    const tasks: TasksTask[] = [
      task({
        id: "001",
        title: "Open me",
        description: "Detail description for 001",
        priority: 1,
        depends_on: ["002", "003"],
        tags: ["urgent", "frontend"],
      }),
    ];
    mounted = mountWidget({ tasks });
    expect(mounted.container.querySelector('[data-testid="task-detail"]')).toBeNull();
    expect(mounted.container.getAttribute("data-detail-open")).not.toBe("true");

    const row = mounted.container.querySelector<HTMLTableRowElement>('[data-testid="task-row"]');
    row!.click();

    const detail = mounted.container.querySelector('[data-testid="task-detail"]');
    expect(detail).toBeTruthy();
    expect(detail!.getAttribute("data-task-id")).toBe("001");
    expect(mounted.container.querySelector('[data-testid="task-detail-title"]')!.textContent).toBe(
      "Open me",
    );
    expect(
      mounted.container.querySelector('[data-testid="task-detail-description"]')!.textContent,
    ).toContain("Detail description for 001");
    // Priority badge reflects P1.
    expect(
      mounted.container.querySelector('[data-testid="task-detail-priority"]')!.textContent,
    ).toBe("P1");

    const close = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-detail-close"]',
    );
    close!.click();
    expect(mounted.container.querySelector('[data-testid="task-detail"]')).toBeNull();
  });

  it("invokes onTaskClick with the task id when a row is clicked", () => {
    const clicks: string[] = [];
    mounted = mountWidget({
      tasks: [task({ id: "abc-1" }), task({ id: "abc-2" })],
      onTaskClick: (id) => clicks.push(id),
    });
    const rows = mounted.container.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="task-row"]',
    );
    // Sort is status-first then priority then id; with equal status+pri,
    // rows render in id-string order — rows[0]=abc-1, rows[1]=abc-2.
    rows[1]!.click();
    expect(clicks).toEqual(["abc-2"]);
    rows[0]!.click();
    expect(clicks).toEqual(["abc-2", "abc-1"]);
  });

  it("live-updates when setOptions pushes a new tasks array", () => {
    mounted = mountWidget({ tasks: [task({ id: "001", title: "first" })] });
    expect(mounted.container.querySelectorAll('[data-testid="task-row"]').length).toBe(1);
    mounted.setOptions({
      tasks: [
        task({ id: "001", title: "first" }),
        task({ id: "002", title: "second", status: "in-progress" }),
        task({ id: "003", title: "third", status: "review" }),
      ],
    });
    const rows = Array.from(
      mounted.container.querySelectorAll<HTMLTableRowElement>('[data-testid="task-row"]'),
    );
    expect(rows).toHaveLength(3);
    // The newly-arrived in-progress task should be first.
    expect(rows[0]!.getAttribute("data-task-id")).toBe("002");
  });

  it("renders the +New task button only when onCreateTask is provided", () => {
    mounted = mountWidget({ tasks: [task()] });
    expect(mounted.container.querySelector('[data-testid="tasks-create"]')).toBeNull();
    mounted.setOptions({ onCreateTask: () => undefined });
    const btn = mounted.container.querySelector<HTMLButtonElement>('[data-testid="tasks-create"]');
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("New task");
  });

  it("renders a depends-on badge when the task has dependencies", () => {
    mounted = mountWidget({
      tasks: [task({ id: "010", depends_on: ["001", "002", "003"] })],
    });
    const row = mounted.container.querySelector('[data-testid="task-row"]');
    expect(row!.textContent).toContain("⛓ 3");
  });

  it("filters by search across id, title, assignee, and tags", () => {
    const tasks: TasksTask[] = [
      task({ id: "001", title: "Refactor pipeline", assignee: "Frontend", tags: ["v2"] }),
      task({ id: "002", title: "Wire daemon", assignee: "Backend", tags: ["api"] }),
      task({ id: "003", title: "Polish UI", assignee: "Frontend", tags: ["ui"] }),
    ];
    mounted = mountWidget({ tasks });
    const search = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="tasks-search"]',
    );
    search!.value = "daemon";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    let rows = mounted.container.querySelectorAll('[data-testid="task-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-task-id")).toBe("002");

    search!.value = "frontend";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    rows = mounted.container.querySelectorAll('[data-testid="task-row"]');
    expect(rows).toHaveLength(2);
  });
});
