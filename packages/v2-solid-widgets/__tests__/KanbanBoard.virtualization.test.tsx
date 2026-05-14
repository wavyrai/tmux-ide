/**
 * Contracts test for the per-column virtualization on KanbanBoard.
 *
 * Seeds 1000 tasks split across the four status columns and asserts
 * each column's body renders only a viewport-sized window of cards
 * while the per-column spacer reports the full virtual height.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { KanbanBoardView } from "../src/widgets/KanbanBoard";
import type { KanbanBoardMountOptions, KanbanTask, KanbanTaskStatus } from "../src/types";

function task(i: number, status: KanbanTaskStatus): KanbanTask {
  return {
    id: `T${i.toString().padStart(4, "0")}`,
    title: `task ${i}`,
    status,
    priority: 3,
  };
}

function mount(opts: KanbanBoardMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options] = createSignal<KanbanBoardMountOptions>(opts);
  const dispose = render(() => <KanbanBoardView options={options} />, container);
  return { container, dispose };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("KanbanBoard virtualization", () => {
  it("renders only a viewport-sized window of cards per column for 1000 tasks", () => {
    const statuses: KanbanTaskStatus[] = ["todo", "in-progress", "review", "done"];
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      task(i, statuses[i % statuses.length]!),
    );
    const { container, dispose } = mount({ tasks });

    // Each column body has its own virtualized spacer.
    const spacers = container.querySelectorAll<HTMLElement>(
      "[data-testid^='kanban-column-spacer-']",
    );
    expect(spacers.length).toBe(4);

    // Across all columns, rendered cards should be far below 1000.
    const cards = container.querySelectorAll<HTMLElement>("[data-task-id]");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(400);

    // Each column's spacer reports a height matching its 250-task slice
    // × ~64px estimate = at least ~16000px.
    for (const spacer of spacers) {
      const h = parseInt(spacer.style.height, 10);
      expect(h).toBeGreaterThan(15_000);
    }

    dispose();
  });
});
