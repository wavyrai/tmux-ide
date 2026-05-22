import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ComposerCommandMenu } from "../src/components/ComposerCommandMenu";
import type { CommandSearchResult } from "../src/lib/slashCommandSearch";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountMenu(options: {
  results: CommandSearchResult[];
  highlightedIndex?: number;
  onSelect?: (commandName: string) => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onHighlight = vi.fn();
  const onSelect = vi.fn((command: { name: string }) => options.onSelect?.(command.name));

  render(
    () => (
      <ComposerCommandMenu
        open={() => true}
        results={() => options.results}
        highlightedIndex={() => options.highlightedIndex ?? 0}
        onHighlight={onHighlight}
        onSelect={onSelect}
        anchor={() => undefined}
      />
    ),
    container,
  );

  return { container, onHighlight, onSelect };
}

describe("ComposerCommandMenu", () => {
  it("renders command results", () => {
    const { container } = mountMenu({
      results: [
        {
          command: { name: "commit", description: "Create commit" },
          score: 1,
          matched: [0, 1],
        },
      ],
    });

    expect(container.textContent).toContain("commit");
    expect(container.textContent).toContain("Create commit");
    expect(container.querySelectorAll("span.font-semibold")).toHaveLength(2);
  });

  it("marks the highlighted row", () => {
    const { container } = mountMenu({
      highlightedIndex: 1,
      results: [
        { command: { name: "commit" }, score: 2, matched: [] },
        { command: { name: "copy" }, score: 1, matched: [] },
      ],
    });

    expect(container.querySelector("[data-command-index='1']")?.className).toContain(
      "bg-surface-hover",
    );
  });

  it("fires select when a row is clicked", () => {
    const selected: string[] = [];
    const { container, onSelect } = mountMenu({
      onSelect: (commandName) => selected.push(commandName),
      results: [{ command: { name: "commit" }, score: 1, matched: [] }],
    });

    container
      .querySelector<HTMLButtonElement>("[data-command-index='0']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(selected).toEqual(["commit"]);
  });

  it("renders a fallback for empty results", () => {
    const { container } = mountMenu({ results: [] });

    expect(container.textContent).toContain("No commands found");
  });
});
