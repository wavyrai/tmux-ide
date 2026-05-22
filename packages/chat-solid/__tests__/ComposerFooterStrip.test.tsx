/**
 * Wide-screen footer strip — the inline trio (Mode toggle, Runtime
 * select, Plan sidebar toggle) that replaces the popover when the
 * composer has room. Pure render — pin the data-testids the
 * responsive switch + future restyles depend on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ComposerFooterStrip,
  type ComposerFooterStripProps,
} from "../src/components/ComposerFooterStrip";
import type {
  ProviderInteractionMode,
  RuntimeMode,
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
  const [planSidebarLabel] = createSignal(opts.planSidebarLabel ?? "Plan");
  const [showInteractionModeToggle] = createSignal(opts.showInteractionModeToggle ?? true);

  const onToggleInteractionMode = vi.fn();
  const onTogglePlanSidebar = vi.fn();
  const onRuntimeModeChange = vi.fn();

  const props: ComposerFooterStripProps = {
    activePlan,
    interactionMode,
    planSidebarLabel,
    planSidebarOpen,
    runtimeMode,
    showInteractionModeToggle,
    onToggleInteractionMode,
    onTogglePlanSidebar,
    onRuntimeModeChange,
  };

  const dispose = render(() => <ComposerFooterStrip {...props} />, container);
  return { container, dispose, onToggleInteractionMode, onTogglePlanSidebar, onRuntimeModeChange };
}

describe("ComposerFooterStrip", () => {
  it("renders the mode toggle, runtime trigger, and (when active plan) plan toggle", () => {
    const { container, dispose } = mount({ activePlan: true });
    expect(container.querySelector("[data-testid='composer-footer-strip']")).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-footer-strip-mode']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='composer-footer-strip-runtime-trigger']"),
    ).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-footer-strip-plan']")).toBeTruthy();
    dispose();
  });

  it("hides the mode toggle when showInteractionModeToggle is false", () => {
    const { container, dispose } = mount({ showInteractionModeToggle: false });
    expect(container.querySelector("[data-testid='composer-footer-strip-mode']")).toBeNull();
    dispose();
  });

  it("hides the plan toggle until activePlan flips true", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='composer-footer-strip-plan']")).toBeNull();
    dispose();
  });

  it("clicks the mode toggle and dispatches onToggleInteractionMode", () => {
    const { container, dispose, onToggleInteractionMode } = mount({ interactionMode: "default" });
    container
      .querySelector<HTMLButtonElement>("[data-testid='composer-footer-strip-mode']")!
      .click();
    expect(onToggleInteractionMode).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("renders the runtime label tracking the active mode", () => {
    const { container, dispose } = mount({ runtimeMode: "full-access" });
    const trigger = container.querySelector(
      "[data-testid='composer-footer-strip-runtime-trigger']",
    );
    expect(trigger?.textContent).toContain("Full access");
    dispose();
  });

  it("opens the runtime menu and dispatches the picked option", () => {
    const { container, dispose, onRuntimeModeChange } = mount({
      runtimeMode: "approval-required",
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-footer-strip-runtime-trigger']",
    );
    trigger!.click();
    expect(
      container.querySelector("[data-testid='composer-footer-strip-runtime-menu']"),
    ).toBeTruthy();
    container
      .querySelector<HTMLButtonElement>(
        "[data-testid='composer-footer-strip-runtime-option'][data-value='auto-accept-edits']",
      )!
      .click();
    expect(onRuntimeModeChange).toHaveBeenCalledExactlyOnceWith("auto-accept-edits");
    // Menu closes after pick.
    expect(
      container.querySelector("[data-testid='composer-footer-strip-runtime-menu']"),
    ).toBeNull();
    dispose();
  });

  it("does not dispatch onRuntimeModeChange when the active option is re-picked", () => {
    const { container, dispose, onRuntimeModeChange } = mount({ runtimeMode: "full-access" });
    container
      .querySelector<HTMLButtonElement>("[data-testid='composer-footer-strip-runtime-trigger']")!
      .click();
    container
      .querySelector<HTMLButtonElement>(
        "[data-testid='composer-footer-strip-runtime-option'][data-value='full-access']",
      )!
      .click();
    expect(onRuntimeModeChange).not.toHaveBeenCalled();
    dispose();
  });

  it("dispatches onTogglePlanSidebar from the plan button", () => {
    const { container, dispose, onTogglePlanSidebar } = mount({ activePlan: true });
    container
      .querySelector<HTMLButtonElement>("[data-testid='composer-footer-strip-plan']")!
      .click();
    expect(onTogglePlanSidebar).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("closes the runtime menu on Escape", () => {
    const { container, dispose } = mount();
    container
      .querySelector<HTMLButtonElement>("[data-testid='composer-footer-strip-runtime-trigger']")!
      .click();
    expect(
      container.querySelector("[data-testid='composer-footer-strip-runtime-menu']"),
    ).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(
      container.querySelector("[data-testid='composer-footer-strip-runtime-menu']"),
    ).toBeNull();
    dispose();
  });
});
