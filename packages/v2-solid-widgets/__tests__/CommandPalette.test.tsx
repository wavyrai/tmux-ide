/**
 * CommandPalette Solid widget — unit tests.
 *
 * Pure renderer tests: mount → flip `open` → assert DOM. No network.
 * Mirrors SkillsView/KanbanBoard test style.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { CommandPaletteView } from "../src/widgets/CommandPalette";
import type { CommandPaletteMountOptions, PaletteCategoryDef } from "../src/types";

function mountWidget(initial: CommandPaletteMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<CommandPaletteMountOptions>(initial);
  const dispose = render(() => <CommandPaletteView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<CommandPaletteMountOptions>) =>
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

function categories(): PaletteCategoryDef[] {
  return [
    {
      category: "providers",
      label: "Providers",
      items: [
        { id: "claude-code", label: "Claude Code", keywords: ["anthropic"] },
        { id: "codex", label: "Codex", keywords: ["openai"] },
      ],
    },
    {
      category: "skills",
      label: "Skills",
      items: [
        { id: "frontend", label: "frontend", description: "React + Solid" },
        { id: "backend", label: "backend", description: "Hono + Zod" },
        { id: "ui-systems", label: "ui-systems", description: "Design tokens" },
      ],
    },
    {
      category: "tasks",
      label: "Tasks",
      items: [
        { id: "001", label: "001 Implement JWT", description: "todo" },
        { id: "002", label: "002 Wire daemon", description: "in-progress" },
      ],
    },
    {
      category: "threads",
      label: "Threads",
      items: [{ id: "abc", label: "Refactor sweep", description: "claude-code" }],
    },
    {
      category: "views",
      label: "Views",
      items: [
        { id: "kanban", label: "Kanban" },
        { id: "skills", label: "Skills" },
        { id: "chat", label: "Chat" },
      ],
    },
    {
      category: "commands",
      label: "Commands",
      items: [{ id: "v2.go-overview", label: "Go to v2 overview", keybind: "⌘1" }],
    },
  ];
}

describe("CommandPalette widget", () => {
  it("renders null when closed and the overlay when open", () => {
    mounted = mountWidget({ open: false, categories: categories() });
    expect(mounted.container.querySelector('[data-testid="command-palette"]')).toBeNull();
    mounted.setOptions({ open: true });
    expect(mounted.container.querySelector('[data-testid="command-palette"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="palette-input"]')).toBeTruthy();
  });

  it("renders one section header per non-empty category and shows all items by default", () => {
    mounted = mountWidget({ open: true, categories: categories() });
    for (const c of ["providers", "skills", "tasks", "threads", "views", "commands"]) {
      expect(mounted.container.querySelector(`[data-testid="palette-group-${c}"]`)).toBeTruthy();
    }
    // Every supplied item renders as a row.
    const items = mounted.container.querySelectorAll('[data-testid="palette-item"]');
    expect(items.length).toBe(2 + 3 + 2 + 1 + 3 + 1);
  });

  it("ranks results across categories when the user types a query", () => {
    mounted = mountWidget({
      open: true,
      categories: categories(),
      perCategoryLimit: 50,
    });
    const input = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="palette-input"]',
    )!;
    input.value = "front";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = Array.from(
      mounted.container.querySelectorAll<HTMLElement>('[data-testid="palette-item"]'),
    ).map((el) => `${el.dataset.category}:${el.dataset.itemId}`);
    // "frontend" skill is the only direct match.
    expect(visible).toEqual(["skills:frontend"]);
  });

  it("fires onSelect with category + id on click and on Enter", () => {
    const onSelect = vi.fn();
    mounted = mountWidget({
      open: true,
      categories: categories(),
      onSelect,
    });
    // Click the third item (skills:frontend at index 2 — providers takes the first two).
    const items = mounted.container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="palette-item"]',
    );
    items[2]!.click();
    expect(onSelect).toHaveBeenCalledWith("skills", "frontend");

    // Enter on the active row.
    const evt = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    window.dispatchEvent(evt);
    // After the click, activeIndex jumped to 2 (hover/click); pressing Enter
    // again should re-fire the same selection.
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard navigation via ArrowDown/Up and fires onDismiss on Escape", () => {
    const onSelect = vi.fn();
    const onDismiss = vi.fn();
    mounted = mountWidget({
      open: true,
      categories: categories(),
      onSelect,
      onDismiss,
    });
    // ArrowDown moves to row 1 (still providers — the second provider).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    // Enter activates the row at index 2 (skills:frontend).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(onSelect).toHaveBeenCalledWith("skills", "frontend");

    // Escape dismisses.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows the empty state when no items match", () => {
    mounted = mountWidget({ open: true, categories: categories() });
    const input = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="palette-input"]',
    )!;
    input.value = "asdfqwertynothing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mounted.container.querySelector('[data-testid="palette-empty"]')).toBeTruthy();
    expect(mounted.container.querySelectorAll('[data-testid="palette-item"]').length).toBe(0);
  });

  it("respects per-category limit when the query is empty", () => {
    const big: PaletteCategoryDef[] = [
      {
        category: "tasks",
        label: "Tasks",
        items: Array.from({ length: 12 }, (_, i) => ({
          id: `${i + 1}`,
          label: `Task ${i + 1}`,
        })),
      },
    ];
    mounted = mountWidget({ open: true, categories: big, perCategoryLimit: 4 });
    expect(mounted.container.querySelectorAll('[data-testid="palette-item"]').length).toBe(4);
  });
});
