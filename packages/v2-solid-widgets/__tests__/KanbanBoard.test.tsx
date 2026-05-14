/**
 * KanbanBoard Solid widget — unit tests.
 *
 * Pure renderer tests: mount → assert DOM. No network, no async setup.
 * Mirrors TasksView.test.tsx style.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { KanbanBoardView } from "../src/widgets/KanbanBoard";
import type { KanbanBoardMountOptions, KanbanTask } from "../src/types";

function mountWidget(initial: KanbanBoardMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<KanbanBoardMountOptions>(initial);
  const dispose = render(() => <KanbanBoardView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<KanbanBoardMountOptions>) =>
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

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
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

describe("KanbanBoard widget", () => {
  it("renders a column for each canonical status, empty when no tasks are supplied", () => {
    mounted = mountWidget({ tasks: [] });
    for (const status of ["todo", "in-progress", "review", "done"]) {
      expect(
        mounted.container.querySelector(`[data-testid="kanban-column-${status}"]`),
      ).toBeTruthy();
      expect(
        mounted.container.querySelector(`[data-testid="kanban-column-body-${status}"]`),
      ).toBeTruthy();
    }
    // No task cards anywhere.
    expect(mounted.container.querySelectorAll("[data-task-id]").length).toBe(0);
  });

  it("places each task into its status column with a single card per task", () => {
    const tasks: KanbanTask[] = [
      task({ id: "001", status: "todo" }),
      task({ id: "002", status: "in-progress" }),
      task({ id: "003", status: "review" }),
      task({ id: "004", status: "done" }),
    ];
    mounted = mountWidget({ tasks });
    for (const [status, id] of [
      ["todo", "001"],
      ["in-progress", "002"],
      ["review", "003"],
      ["done", "004"],
    ] as const) {
      const body = mounted.container.querySelector(`[data-testid="kanban-column-body-${status}"]`)!;
      const cards = body.querySelectorAll("[data-task-id]");
      expect(cards.length).toBe(1);
      expect(body.querySelector(`[data-testid="task-card-${id}"]`)).toBeTruthy();
    }
  });

  it("filters tasks by the search input across id, title, assignee, and tags", () => {
    const tasks: KanbanTask[] = [
      task({ id: "001", title: "Apple", assignee: "Alice", tags: ["a"] }),
      task({ id: "002", title: "Banana", assignee: "Bob", tags: ["b"] }),
      task({ id: "003", title: "Cherry", assignee: "Alice", tags: ["c"] }),
    ];
    mounted = mountWidget({ tasks });
    const search = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="kanban-filter-search"]',
    )!;
    search.value = "alice";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const ids = Array.from(mounted.container.querySelectorAll("[data-task-id]")).map((el) =>
      el.getAttribute("data-task-id"),
    );
    expect(ids.sort()).toEqual(["001", "003"]);
  });

  it("fires onTaskStatusChange with the next status when the status dot is clicked", () => {
    const calls: Array<[string, string]> = [];
    mounted = mountWidget({
      tasks: [task({ id: "001", status: "todo" })],
      onTaskStatusChange: (id, next) => calls.push([id, next]),
    });
    const dot = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-card-status-001"]',
    )!;
    dot.click();
    expect(calls).toEqual([["001", "in-progress"]]);
    // The optimistic patch must move the card into the next column.
    const body = mounted.container.querySelector('[data-testid="kanban-column-body-in-progress"]')!;
    expect(body.querySelector('[data-testid="task-card-001"]')).toBeTruthy();
  });

  it("opens the detail callback when a card body (not the status dot) is clicked", () => {
    const clicks: string[] = [];
    mounted = mountWidget({
      tasks: [task({ id: "001", title: "Open me" })],
      onTaskClick: (id) => clicks.push(id),
    });
    const card = mounted.container.querySelector<HTMLElement>('[data-testid="task-card-001"]')!;
    card.click();
    expect(clicks).toEqual(["001"]);

    // Clicks on the status dot do NOT propagate to onTaskClick.
    const dot = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="task-card-status-001"]',
    )!;
    dot.click();
    expect(clicks).toEqual(["001"]); // unchanged
  });

  it("switches group-by to priority and rebuilds the column composition", () => {
    const tasks: KanbanTask[] = [
      task({ id: "001", priority: 1 }),
      task({ id: "002", priority: 4 }),
    ];
    mounted = mountWidget({ tasks });
    const p1Btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-groupby-priority"]',
    );
    expect(p1Btn).toBeTruthy();
    p1Btn!.click();
    expect(mounted.container.querySelector('[data-testid="kanban-column-p1"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="kanban-column-p4"]')).toBeTruthy();
    const p1Body = mounted.container.querySelector('[data-testid="kanban-column-body-p1"]')!;
    expect(p1Body.querySelector('[data-testid="task-card-001"]')).toBeTruthy();
    const p4Body = mounted.container.querySelector('[data-testid="kanban-column-body-p4"]')!;
    expect(p4Body.querySelector('[data-testid="task-card-002"]')).toBeTruthy();
  });

  it("live-updates when setOptions pushes a new tasks array", () => {
    mounted = mountWidget({ tasks: [task({ id: "001", status: "todo" })] });
    expect(
      mounted.container
        .querySelector('[data-testid="kanban-column-body-todo"]')!
        .querySelectorAll("[data-task-id]").length,
    ).toBe(1);

    mounted.setOptions({
      tasks: [
        task({ id: "001", status: "todo" }),
        task({ id: "002", status: "in-progress" }),
        task({ id: "003", status: "done" }),
      ],
    });
    expect(
      mounted.container
        .querySelector('[data-testid="kanban-column-body-in-progress"]')!
        .querySelector('[data-testid="task-card-002"]'),
    ).toBeTruthy();
    expect(
      mounted.container
        .querySelector('[data-testid="kanban-column-body-done"]')!
        .querySelector('[data-testid="task-card-003"]'),
    ).toBeTruthy();
  });

  it("renders + New task button only when onCreateTask is provided", () => {
    mounted = mountWidget({ tasks: [task()] });
    expect(mounted.container.querySelector('[data-testid="kanban-add-task"]')).toBeNull();
    const onCreate = vi.fn();
    mounted.setOptions({ onCreateTask: onCreate });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-add-task"]',
    );
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("clears all filters when the clear button is pressed", () => {
    const tasks: KanbanTask[] = [
      task({ id: "001", priority: 1 }),
      task({ id: "002", priority: 4 }),
    ];
    mounted = mountWidget({ tasks });
    const search = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="kanban-filter-search"]',
    )!;
    search.value = "nomatch";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mounted.container.querySelectorAll("[data-task-id]").length).toBe(0);
    const clear = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="kanban-filter-clear"]',
    );
    expect(clear).toBeTruthy();
    clear!.click();
    expect(mounted.container.querySelectorAll("[data-task-id]").length).toBe(2);
    expect(search.value).toBe("");
  });
});
