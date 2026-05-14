/**
 * Contracts test for the virtualized TasksView table.
 *
 * Seeds 1000 tasks and asserts the tbody renders only a
 * viewport-sized window of `[data-testid="task-row"]` rows. The table
 * structure is preserved via top/bottom spacer <tr>s sized to keep
 * the scroll height matching the virtual content.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TasksViewView } from "../src/widgets/TasksView";
import type { TasksMountOptions, TasksTask, TasksTaskStatus } from "../src/types";

function task(i: number, status: TasksTaskStatus = "todo"): TasksTask {
  return {
    id: `T${i.toString().padStart(4, "0")}`,
    title: `task ${i}`,
    status,
    priority: 3,
  };
}

function mount(opts: TasksMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options] = createSignal<TasksMountOptions>(opts);
  const dispose = render(() => <TasksViewView options={options} />, container);
  return { container, dispose };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TasksView virtualization", () => {
  it("renders only a viewport-sized window of table rows for 1000 tasks", () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => task(i));
    const { container, dispose } = mount({ tasks });

    const renderedRows = container.querySelectorAll<HTMLElement>("[data-testid='task-row']");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(200);

    // Both spacer rows + visible rows live inside the same tbody.
    const tbody = container.querySelector<HTMLElement>("[data-testid='tasks-tbody']");
    expect(tbody).toBeTruthy();

    dispose();
  });
});
