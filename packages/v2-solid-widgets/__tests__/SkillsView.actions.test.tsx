/**
 * SkillsView — CRUD action tests (WN6).
 *
 * Verifies the widget dispatches onCreate/onUpdate/onDelete with the
 * normalized form values. Pure DOM-level: no network, no bridge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { SkillsViewView } from "../src/widgets/SkillsView";
import type { SkillsViewMountOptions, SkillSummary } from "../src/types";

function mountWidget(initial: SkillsViewMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<SkillsViewMountOptions>(initial);
  const dispose = render(() => <SkillsViewView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<SkillsViewMountOptions>) =>
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const existing: SkillSummary = {
  name: "frontend",
  role: "teammate",
  specialties: ["frontend"],
  description: "Owns the React + Solid surfaces.",
  body: "## Frontend\n\nFocus on composition.",
};

describe("SkillsView — CRUD actions", () => {
  it("dispatches onCreate with normalized form values when + New is submitted", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    mounted = mountWidget({ skills: [], onCreate });

    const newBtn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="skills-new-button"]',
    );
    expect(newBtn).toBeTruthy();
    newBtn!.click();

    // Editor opens in create mode.
    const editor = mounted.container.querySelector('[data-testid="skill-editor"]')!;
    expect(editor.getAttribute("data-editor-mode")).toBe("create");

    setInputValue(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="skill-form-name"]')!,
      "reviewer",
    );
    setInputValue(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="skill-form-role"]')!,
      "validator",
    );
    setInputValue(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="skill-form-specialties"]')!,
      "lint, tests",
    );
    setInputValue(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="skill-form-description"]')!,
      "Reviews PRs",
    );
    setInputValue(
      mounted.container.querySelector<HTMLTextAreaElement>('[data-testid="skill-form-body"]')!,
      "Body content.",
    );

    mounted.container.querySelector<HTMLButtonElement>('[data-testid="skill-form-save"]')!.click();

    // Microtask + a tick for the awaited handler to resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      name: "reviewer",
      role: "validator",
      description: "Reviews PRs",
      specialties: ["lint", "tests"],
      body: "Body content.",
    });
  });

  it("dispatches onUpdate with the original skill name + edited values", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    mounted = mountWidget({ skills: [existing], onUpdate });

    mounted.container
      .querySelector<HTMLButtonElement>('[data-testid="skill-edit-button"]')!
      .click();

    const editor = mounted.container.querySelector('[data-testid="skill-editor"]')!;
    expect(editor.getAttribute("data-editor-mode")).toBe("edit");

    // Name input is disabled in edit mode — re-keying it isn't allowed.
    const nameInput = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="skill-form-name"]',
    )!;
    expect(nameInput.disabled).toBe(true);
    expect(nameInput.value).toBe("frontend");

    setInputValue(
      mounted.container.querySelector<HTMLInputElement>('[data-testid="skill-form-description"]')!,
      "Updated description.",
    );
    setInputValue(
      mounted.container.querySelector<HTMLTextAreaElement>('[data-testid="skill-form-body"]')!,
      "Updated body content.",
    );

    mounted.container.querySelector<HTMLButtonElement>('[data-testid="skill-form-save"]')!.click();

    await Promise.resolve();
    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("frontend", {
      name: "frontend",
      role: "teammate",
      description: "Updated description.",
      specialties: ["frontend"],
      body: "Updated body content.",
    });
  });

  it("dispatches onDelete only after the confirm dialog is accepted", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    mounted = mountWidget({ skills: [existing], onDelete });

    mounted.container
      .querySelector<HTMLButtonElement>('[data-testid="skill-delete-button"]')!
      .click();

    // Confirm dialog renders but onDelete has not fired yet.
    const confirm = mounted.container.querySelector('[data-testid="skill-delete-confirm"]')!;
    expect(confirm.getAttribute("data-skill-name")).toBe("frontend");
    expect(onDelete).not.toHaveBeenCalled();

    // Cancel first → dialog closes, still no dispatch.
    mounted.container
      .querySelector<HTMLButtonElement>('[data-testid="skill-delete-cancel"]')!
      .click();
    expect(mounted.container.querySelector('[data-testid="skill-delete-confirm"]')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    // Reopen + accept.
    mounted.container
      .querySelector<HTMLButtonElement>('[data-testid="skill-delete-button"]')!
      .click();
    mounted.container
      .querySelector<HTMLButtonElement>('[data-testid="skill-delete-confirm-button"]')!
      .click();

    await Promise.resolve();
    await Promise.resolve();

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("frontend");
  });

  it("hides + New / Edit / Delete affordances when no handlers are passed", () => {
    mounted = mountWidget({ skills: [existing] });
    expect(mounted.container.querySelector('[data-testid="skills-new-button"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="skill-edit-button"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="skill-delete-button"]')).toBeNull();
  });
});
