import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { TerminalContextInlineChip } from "../src/components/TerminalContextInlineChip";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountChip(props: Parameters<typeof TerminalContextInlineChip>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(() => <TerminalContextInlineChip {...props} />, container);
  return container;
}

describe("TerminalContextInlineChip", () => {
  it("renders the pane label with the terminal glyph", () => {
    const container = mountChip({ label: "Lead :1.0" });
    const chip = container.querySelector("[data-testid='terminal-context-inline-chip']");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain(">_");
    expect(
      container.querySelector("[data-testid='terminal-context-chip-label']")?.textContent,
    ).toBe("Lead :1.0");
    expect(chip?.getAttribute("data-terminal-context-expired")).toBeNull();
  });

  it("renders the line count when provided", () => {
    const container = mountChip({ label: "Tests :1.2", lineCount: 42 });
    expect(
      container.querySelector("[data-testid='terminal-context-chip-lines']")?.textContent,
    ).toBe("(42 lines)");
  });

  it("marks itself as expired and exposes the data attribute", () => {
    const container = mountChip({ label: "Old Pane", expired: true });
    const chip = container.querySelector(
      "[data-testid='terminal-context-inline-chip']",
    ) as HTMLElement;
    expect(chip.getAttribute("data-terminal-context-expired")).toBe("true");
    expect(chip.className).toContain("destructive");
  });

  it("renders × when onRemove is provided and dispatches on click", () => {
    const onRemove = vi.fn();
    const container = mountChip({ label: "Shell :1.1", onRemove });
    const btn = container.querySelector(
      "[data-testid='terminal-context-chip-remove']",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("omits the × button when onRemove is absent", () => {
    const container = mountChip({ label: "Read-only" });
    expect(
      container.querySelector("[data-testid='terminal-context-chip-remove']"),
    ).toBeNull();
  });
});
