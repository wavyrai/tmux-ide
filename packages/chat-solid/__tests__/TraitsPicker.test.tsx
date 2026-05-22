/**
 * Trait picker — wire coverage. Asserts:
 *
 *   1. Renders nothing when no descriptors are supplied.
 *   2. Trigger label defaults to a `·`-joined summary of current values.
 *   3. Opening surfaces a section per descriptor with one button per
 *      option; the active option carries data-active="true".
 *   4. Selecting a different option fires `onTraitChange(id, value)`
 *      and closes the menu; selecting the active option is a no-op
 *      that does not fire the callback.
 *   5. Boolean descriptors render an On/Off pair and dispatch booleans.
 *   6. Escape closes the menu.
 *   7. Disabled state hides the trigger from interaction.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TraitsPicker, type TraitDescriptor } from "../src/components/TraitsPicker";

afterEach(() => {
  document.body.innerHTML = "";
});

const effort: TraitDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "medium",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
};

const contextWindow: TraitDescriptor = {
  id: "contextWindow",
  label: "Context window",
  type: "select",
  currentValue: "200k",
  options: [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
};

const thinking: TraitDescriptor = {
  id: "thinking",
  label: "Thinking",
  type: "boolean",
  currentValue: true,
};

interface MountOpts {
  descriptors?: TraitDescriptor[];
  disabled?: boolean;
  triggerLabel?: string;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [descriptors] = createSignal<ReadonlyArray<TraitDescriptor>>(
    opts.descriptors ?? [effort, contextWindow, thinking],
  );
  const [disabled] = createSignal(opts.disabled ?? false);
  const [triggerLabel] = createSignal<string | null>(opts.triggerLabel ?? null);
  const onTraitChange = vi.fn();

  const dispose = render(
    () => (
      <TraitsPicker
        descriptors={descriptors}
        disabled={disabled}
        triggerLabel={() => triggerLabel()}
        onTraitChange={onTraitChange}
      />
    ),
    container,
  );

  return { container, dispose, onTraitChange };
}

function clickTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    "[data-testid='traits-picker-trigger']",
  );
  trigger!.click();
  return trigger!;
}

describe("TraitsPicker", () => {
  it("renders nothing when there are no descriptors", () => {
    const { container, dispose } = mount({ descriptors: [] });
    expect(container.querySelector("[data-testid='traits-picker']")).toBeNull();
    dispose();
  });

  it("defaults the trigger label to a · -joined summary of current values", () => {
    const { container, dispose } = mount();
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-trigger']",
    );
    expect(trigger?.textContent).toContain("Medium");
    expect(trigger?.textContent).toContain("200k");
    expect(trigger?.textContent).toContain("Thinking On");
    dispose();
  });

  it("respects a custom triggerLabel override", () => {
    const { container, dispose } = mount({ triggerLabel: "custom" });
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-trigger']",
    );
    expect(trigger?.textContent).toContain("custom");
    dispose();
  });

  it("opens the menu and shows a section per descriptor", () => {
    const { container, dispose } = mount();
    clickTrigger(container);
    const sections = container.querySelectorAll("[data-testid='traits-picker-section']");
    expect(sections.length).toBe(3);
    expect(Array.from(sections).map((s) => s.getAttribute("data-descriptor-id"))).toEqual([
      "effort",
      "contextWindow",
      "thinking",
    ]);
    dispose();
  });

  it("marks the active option with data-active='true' inside a select", () => {
    const { container, dispose } = mount();
    clickTrigger(container);
    const active = container.querySelector(
      "[data-testid='traits-picker-option'][data-descriptor-id='effort'][data-active='true']",
    );
    expect(active?.getAttribute("data-value")).toBe("medium");
    dispose();
  });

  it("dispatches onTraitChange when a different option is picked", () => {
    const { container, dispose, onTraitChange } = mount();
    clickTrigger(container);
    const high = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-option'][data-descriptor-id='effort'][data-value='high']",
    );
    high!.click();
    expect(onTraitChange).toHaveBeenCalledExactlyOnceWith("effort", "high");
    dispose();
  });

  it("ignores clicks on the active option", () => {
    const { container, dispose, onTraitChange } = mount();
    clickTrigger(container);
    const medium = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-option'][data-descriptor-id='effort'][data-value='medium']",
    );
    medium!.click();
    expect(onTraitChange).not.toHaveBeenCalled();
    dispose();
  });

  it("dispatches booleans for boolean descriptors", () => {
    const { container, dispose, onTraitChange } = mount();
    clickTrigger(container);
    const off = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-option'][data-descriptor-id='thinking'][data-value='off']",
    );
    off!.click();
    expect(onTraitChange).toHaveBeenCalledExactlyOnceWith("thinking", false);
    dispose();
  });

  it("closes on Escape", () => {
    const { container, dispose } = mount();
    clickTrigger(container);
    expect(container.querySelector("[data-testid='traits-picker-menu']")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector("[data-testid='traits-picker-menu']")).toBeNull();
    dispose();
  });

  it("does not open while disabled", () => {
    const { container, dispose } = mount({ disabled: true });
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='traits-picker-trigger']",
    );
    trigger!.click();
    expect(container.querySelector("[data-testid='traits-picker-menu']")).toBeNull();
    dispose();
  });
});
