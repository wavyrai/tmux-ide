/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { CommandPalette, rankDomPaletteEntries } from "./command-palette.tsx";
import {
  createDefaultDomShellInput,
  createDomPaletteEntries,
  createDomShellReplayState,
  projectDomApplicationShell,
} from "./dom-shell.ts";
import type { DomPaletteEntry } from "./dom-shell.ts";

const disposers: Array<() => void> = [];

function entries(disableActivity = false): readonly DomPaletteEntry[] {
  const input = createDefaultDomShellInput();
  const projected = projectDomApplicationShell(input, createDomShellReplayState(input));
  return createDomPaletteEntries(projected).map((entry) =>
    disableActivity && entry.id === "activity"
      ? { ...entry, disabledReason: "Activity is unavailable" }
      : entry,
  );
}

afterEach(() => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe("command palette ranking", () => {
  it("ranks labels before metadata and keeps group order stable without a query", () => {
    const paletteEntries = entries();
    expect(rankDomPaletteEntries(paletteEntries, "term")[0]?.entry.id).toBe("terminals");
    expect(rankDomPaletteEntries(paletteEntries, "dock").map(({ entry }) => entry.id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(rankDomPaletteEntries(paletteEntries, "mssns")[0]?.entry.id).toBe("missions");
    expect(rankDomPaletteEntries(paletteEntries, "not-a-command")).toEqual([]);
    expect(rankDomPaletteEntries(paletteEntries, "").map(({ entry }) => entry.id)).toEqual([
      "home",
      "terminals",
      "workspace:session.product",
      "workspace:session.docs",
      "agent:agent.pm",
      "agent:agent.implementer",
      "agent:agent.reviewer",
      "agent:agent.recovery",
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(
      rankDomPaletteEntries([...paletteEntries].reverse(), "").map(({ entry }) => entry.id),
    ).toEqual([
      "home",
      "terminals",
      "workspace:session.product",
      "workspace:session.docs",
      "agent:agent.pm",
      "agent:agent.implementer",
      "agent:agent.reviewer",
      "agent:agent.recovery",
      "files",
      "changes",
      "missions",
      "activity",
    ]);
  });
});

describe("command palette interaction", () => {
  it("loops enabled commands, follows pointer selection, filters, and restores focus", async () => {
    const root = document.createElement("div");
    const returnTarget = document.createElement("button");
    returnTarget.textContent = "Open commands";
    document.body.append(returnTarget, root);
    returnTarget.focus();

    const [open, setOpen] = createSignal(true);
    const onActivate = vi.fn();
    const onClosed = vi.fn(() => returnTarget.focus());
    const onClose = vi.fn((source: "keyboard" | "mouse") => {
      setOpen(false);
      return source;
    });
    disposers.push(
      render(
        () => (
          <CommandPalette
            open={open()}
            entries={entries(true)}
            transitionSource="keyboard"
            onClose={onClose}
            onClosed={onClosed}
            onActivate={onActivate}
          />
        ),
        root,
      ),
    );

    const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(3);
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-home");

    const scopeButtons = [
      ...root.querySelectorAll<HTMLButtonElement>(".command-palette__scopes button"),
    ];
    scopeButtons.find((button) => button.textContent === "Agents")!.click();
    expect(root.querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(root.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBe(
      "palette-group-agents",
    );
    scopeButtons.find((button) => button.textContent === "All")!.click();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-missions");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-home");

    const changes = root.querySelector<HTMLElement>("#palette-option-changes")!;
    changes.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-changes");
    changes.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "changes" }), "mouse");

    input.value = "nothing-matches-this";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(root.querySelector(".command-palette__empty")?.textContent).toContain(
      "No results found",
    );
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledWith("keyboard");
    await vi.waitFor(() => expect(document.activeElement).toBe(returnTarget));
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("closes the backdrop with pointer provenance and traps Tab on the search field", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const [open, setOpen] = createSignal(true);
    const onClosed = vi.fn();
    const onClose = vi.fn(() => setOpen(false));
    disposers.push(
      render(
        () => (
          <CommandPalette
            open={open()}
            entries={entries()}
            transitionSource="mouse"
            onClose={onClose}
            onClosed={onClosed}
            onActivate={vi.fn()}
          />
        ),
        root,
      ),
    );
    const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(input);
    vi.useFakeTimers();
    root
      .querySelector<HTMLElement>(".command-palette-overlay")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledWith("mouse");
    expect(root.querySelector(".command-palette-overlay")?.getAttribute("data-state")).toBe(
      "closed",
    );
    await Promise.resolve();
    expect(onClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(onClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
