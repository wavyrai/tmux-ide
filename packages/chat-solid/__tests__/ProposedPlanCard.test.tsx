/**
 * Render-level coverage for the rebuilt ProposedPlanCard:
 *
 *   1. Renders the title (first heading) + Plan badge + markdown body.
 *   2. Short plans hide the collapse toggle; long plans expose it +
 *      collapsed body renders a fade-out overlay.
 *   3. Overflow menu surfaces Copy / Download / Save entries.
 *      - Copy dispatches `onCopy` with the normalized contents.
 *      - Download dispatches `onDownload` with the derived filename.
 *      - Save opens the save dialog, defaults the input to the
 *        derived filename, and dispatches `onSaveToWorkspace` on
 *        submit; cancel closes the dialog without dispatching.
 *   4. Save entry is disabled when no host handler is wired.
 *   5. Save error is surfaced inside the dialog when the host throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ProposedPlanCard } from "../src/components/ProposedPlanCard";

afterEach(() => {
  document.body.innerHTML = "";
});

interface MountOpts {
  planMarkdown?: string;
  workspaceRoot?: string | null;
  onCopy?: (contents: string) => Promise<void>;
  onDownload?: (filename: string, contents: string) => void;
  onSaveToWorkspace?: (relativePath: string, contents: string) => Promise<void>;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [planMarkdown] = createSignal(opts.planMarkdown ?? "# Implement OAuth\n- step a\n- step b");
  const [workspaceRoot] = createSignal<string | null>(opts.workspaceRoot ?? "/tmp/project");

  const dispose = render(
    () => (
      <ProposedPlanCard
        planMarkdown={planMarkdown}
        workspaceRoot={workspaceRoot}
        onCopy={opts.onCopy}
        onDownload={opts.onDownload}
        onSaveToWorkspace={opts.onSaveToWorkspace}
      />
    ),
    container,
  );

  return { container, dispose };
}

function openMenu(container: HTMLElement): void {
  const trigger = container.querySelector<HTMLButtonElement>(
    "[data-testid='proposed-plan-card-menu-trigger']",
  );
  trigger!.click();
}

describe("ProposedPlanCard — header", () => {
  it("renders the title and the Plan badge", () => {
    const { container, dispose } = mount();
    expect(
      container.querySelector("[data-testid='proposed-plan-card-title']")?.textContent,
    ).toBe("Implement OAuth");
    expect(container.textContent).toContain("Plan");
    dispose();
  });

  it("falls back to 'Proposed plan' when no title is recoverable", () => {
    const { container, dispose } = mount({ planMarkdown: "" });
    expect(
      container.querySelector("[data-testid='proposed-plan-card-title']")?.textContent,
    ).toBe("Proposed plan");
    dispose();
  });
});

describe("ProposedPlanCard — collapse / expand", () => {
  it("does not render the toggle for a short plan", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='proposed-plan-card-toggle']")).toBeNull();
    expect(container.querySelector("[data-testid='proposed-plan-card-fade']")).toBeNull();
    dispose();
  });

  it("renders the toggle and fade for a long plan", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- step ${i + 1}`).join("\n");
    const { container, dispose } = mount({ planMarkdown: `# Big plan\n${lines}` });
    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='proposed-plan-card-toggle']",
    );
    expect(toggle?.textContent).toBe("Expand plan");
    expect(container.querySelector("[data-testid='proposed-plan-card-fade']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='proposed-plan-card-body']")?.getAttribute("data-collapsed"),
    ).toBe("true");
    toggle!.click();
    expect(toggle?.textContent).toBe("Collapse plan");
    expect(container.querySelector("[data-testid='proposed-plan-card-fade']")).toBeNull();
    expect(
      container.querySelector("[data-testid='proposed-plan-card-body']")?.getAttribute("data-collapsed"),
    ).toBe("false");
    dispose();
  });
});

describe("ProposedPlanCard — menu", () => {
  it("opens the menu and lists the three actions", () => {
    const { container, dispose } = mount({
      onSaveToWorkspace: vi.fn(),
    });
    openMenu(container);
    expect(container.querySelector("[data-testid='proposed-plan-card-copy']")).toBeTruthy();
    expect(container.querySelector("[data-testid='proposed-plan-card-download']")).toBeTruthy();
    expect(container.querySelector("[data-testid='proposed-plan-card-save']")).toBeTruthy();
    dispose();
  });

  it("disables the Save entry when no save handler is supplied", () => {
    const { container, dispose } = mount();
    openMenu(container);
    const save = container.querySelector<HTMLButtonElement>(
      "[data-testid='proposed-plan-card-save']",
    );
    expect(save?.disabled).toBe(true);
    dispose();
  });

  it("dispatches Copy with the normalized contents", async () => {
    const onCopy = vi.fn(async (_contents: string) => undefined);
    const { container, dispose } = mount({ onCopy });
    openMenu(container);
    container.querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-copy']")!.click();
    await Promise.resolve();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy.mock.calls[0]?.[0]).toBe("# Implement OAuth\n- step a\n- step b\n");
    dispose();
  });

  it("dispatches Download with the derived filename and contents", () => {
    const onDownload = vi.fn();
    const { container, dispose } = mount({ onDownload });
    openMenu(container);
    container
      .querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-download']")!
      .click();
    expect(onDownload).toHaveBeenCalledExactlyOnceWith(
      "implement-oauth.md",
      "# Implement OAuth\n- step a\n- step b\n",
    );
    dispose();
  });
});

describe("ProposedPlanCard — save dialog", () => {
  it("opens with the derived filename pre-filled and dispatches Save", async () => {
    const onSave = vi.fn(async () => undefined);
    const { container, dispose } = mount({ onSaveToWorkspace: onSave });
    openMenu(container);
    container.querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save']")!.click();
    const input = container.querySelector<HTMLInputElement>(
      "[data-testid='proposed-plan-card-save-input']",
    );
    expect(input?.value).toBe("implement-oauth.md");
    container
      .querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save-submit']")!
      .click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledExactlyOnceWith(
      "implement-oauth.md",
      "# Implement OAuth\n- step a\n- step b\n",
    );
    dispose();
  });

  it("surfaces save errors inside the dialog without closing", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("disk full");
    });
    const { container, dispose } = mount({ onSaveToWorkspace: onSave });
    openMenu(container);
    container.querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save']")!.click();
    container
      .querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save-submit']")!
      .click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      container.querySelector("[data-testid='proposed-plan-card-save-error']")?.textContent,
    ).toBe("disk full");
    expect(container.querySelector("[data-testid='proposed-plan-card-save-dialog']")).toBeTruthy();
    dispose();
  });

  it("Cancel closes the dialog without dispatching save", () => {
    const onSave = vi.fn();
    const { container, dispose } = mount({ onSaveToWorkspace: onSave });
    openMenu(container);
    container.querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save']")!.click();
    container
      .querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save-cancel']")!
      .click();
    expect(container.querySelector("[data-testid='proposed-plan-card-save-dialog']")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    dispose();
  });

  it("blocks save with an inline error when the path is blank", async () => {
    const onSave = vi.fn();
    const { container, dispose } = mount({ onSaveToWorkspace: onSave });
    openMenu(container);
    container.querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save']")!.click();
    const input = container.querySelector<HTMLInputElement>(
      "[data-testid='proposed-plan-card-save-input']",
    );
    input!.value = "";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLButtonElement>("[data-testid='proposed-plan-card-save-submit']")!
      .click();
    expect(onSave).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='proposed-plan-card-save-error']")?.textContent,
    ).toContain("Enter a workspace path");
    dispose();
  });
});
