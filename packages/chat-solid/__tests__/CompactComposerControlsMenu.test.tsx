/**
 * Compact controls — wire coverage. Asserts:
 *
 *   1. Trigger toggles the menu open/closed; data-open mirrors state.
 *   2. Mode radio group renders both options, marks the active one,
 *      and clicks fire `onToggleInteractionMode` once (only when the
 *      value differs).
 *   3. Runtime radio group dispatches `onRuntimeModeChange(value)`.
 *   4. Plan-sidebar entry mounts only when `activePlan=true`; click
 *      fires `onTogglePlanSidebar`.
 *   5. Traits slot mounts above the dividers when supplied.
 *   6. Escape closes the menu.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  CompactComposerControlsMenu,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "../src/components/CompactComposerControlsMenu";

afterEach(() => {
  document.body.innerHTML = "";
});

interface MountOpts {
  interactionMode?: ProviderInteractionMode;
  runtimeMode?: RuntimeMode;
  activePlan?: boolean;
  planSidebarOpen?: boolean;
  planSidebarLabel?: string;
  showInteractionModeToggle?: boolean;
  withTraits?: boolean;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [interactionMode] = createSignal<ProviderInteractionMode>(
    opts.interactionMode ?? "default",
  );
  const [runtimeMode] = createSignal<RuntimeMode>(opts.runtimeMode ?? "approval-required");
  const [activePlan] = createSignal(opts.activePlan ?? false);
  const [planSidebarOpen] = createSignal(opts.planSidebarOpen ?? false);
  const [planSidebarLabel] = createSignal(opts.planSidebarLabel ?? "plan");
  const [showInteractionModeToggle] = createSignal(opts.showInteractionModeToggle ?? true);

  const onToggleInteractionMode = vi.fn();
  const onTogglePlanSidebar = vi.fn();
  const onRuntimeModeChange = vi.fn();

  const dispose = render(
    () => (
      <CompactComposerControlsMenu
        activePlan={activePlan}
        interactionMode={interactionMode}
        planSidebarLabel={planSidebarLabel}
        planSidebarOpen={planSidebarOpen}
        runtimeMode={runtimeMode}
        showInteractionModeToggle={showInteractionModeToggle}
        traitsMenuContent={
          opts.withTraits
            ? () => (
                <button data-testid="trait-effort-low" type="button">
                  Effort: low
                </button>
              )
            : undefined
        }
        onToggleInteractionMode={onToggleInteractionMode}
        onTogglePlanSidebar={onTogglePlanSidebar}
        onRuntimeModeChange={onRuntimeModeChange}
      />
    ),
    container,
  );

  return {
    container,
    dispose,
    handlers: { onToggleInteractionMode, onTogglePlanSidebar, onRuntimeModeChange },
  };
}

function trigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    "[data-testid='compact-composer-controls-trigger']",
  )!;
}

describe("CompactComposerControlsMenu", () => {
  it("toggles the menu open/closed via the trigger", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='compact-composer-controls-menu']")).toBeNull();
    trigger(container).click();
    expect(container.querySelector("[data-testid='compact-composer-controls-menu']")).toBeTruthy();
    expect(trigger(container).getAttribute("data-open")).toBe("true");
    dispose();
  });

  it("renders both mode options and marks the active one", () => {
    const { container, dispose } = mount({ interactionMode: "plan" });
    trigger(container).click();
    const options = container.querySelectorAll(
      "[data-testid='compact-composer-controls-mode-option']",
    );
    expect(options.length).toBe(2);
    const active = container.querySelector(
      "[data-testid='compact-composer-controls-mode-option'][data-active='true']",
    );
    expect(active?.getAttribute("data-value")).toBe("plan");
    dispose();
  });

  it("dispatches onToggleInteractionMode when a different mode is picked", () => {
    const { container, dispose, handlers } = mount({ interactionMode: "default" });
    trigger(container).click();
    const planOption = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-mode-option'][data-value='plan']",
    );
    planOption!.click();
    expect(handlers.onToggleInteractionMode).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not dispatch onToggleInteractionMode when the same mode is clicked", () => {
    const { container, dispose, handlers } = mount({ interactionMode: "default" });
    trigger(container).click();
    const sameOption = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-mode-option'][data-value='default']",
    );
    sameOption!.click();
    expect(handlers.onToggleInteractionMode).not.toHaveBeenCalled();
    dispose();
  });

  it("dispatches onRuntimeModeChange with the picked runtime mode", () => {
    const { container, dispose, handlers } = mount({ runtimeMode: "approval-required" });
    trigger(container).click();
    const fullAccess = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-runtime-option'][data-value='full-access']",
    );
    fullAccess!.click();
    expect(handlers.onRuntimeModeChange).toHaveBeenCalledExactlyOnceWith("full-access");
    dispose();
  });

  it("hides the plan-sidebar entry when no plan is active", () => {
    const { container, dispose } = mount({ activePlan: false });
    trigger(container).click();
    expect(
      container.querySelector("[data-testid='compact-composer-controls-plan-sidebar']"),
    ).toBeNull();
    dispose();
  });

  it("renders the plan-sidebar entry when activePlan=true and dispatches onTogglePlanSidebar", () => {
    const { container, dispose, handlers } = mount({
      activePlan: true,
      planSidebarOpen: false,
      planSidebarLabel: "Roadmap",
    });
    trigger(container).click();
    const planEntry = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-plan-sidebar']",
    );
    expect(planEntry?.textContent).toContain("Show roadmap sidebar");
    planEntry!.click();
    expect(handlers.onTogglePlanSidebar).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("renders the traits slot when supplied", () => {
    const { container, dispose } = mount({ withTraits: true });
    trigger(container).click();
    expect(container.querySelector("[data-testid='trait-effort-low']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='compact-composer-controls-traits']"),
    ).toBeTruthy();
    dispose();
  });

  it("closes on Escape", () => {
    const { container, dispose } = mount();
    trigger(container).click();
    expect(container.querySelector("[data-testid='compact-composer-controls-menu']")).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(container.querySelector("[data-testid='compact-composer-controls-menu']")).toBeNull();
    dispose();
  });
});
