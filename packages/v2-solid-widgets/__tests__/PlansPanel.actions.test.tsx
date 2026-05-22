/**
 * PlansPanel — action chip tests for WN3.
 *
 * Verifies that the [edit] / [mark done] / [delete] chips fire the
 * mount-option callbacks the host wires (V2PlansView). Each chip
 * appears only when a host has opted in; the destructive [delete]
 * chip is confirm-prompted before firing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PlansPanelView } from "../src/widgets/PlansPanel";
import type {
  PlansPanelMountOptions,
  PlansPanelPlanData,
  PlansPanelPlanSummary,
} from "../src/types";

function mount(initial: PlansPanelMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<PlansPanelMountOptions>(initial);
  const dispose = render(() => <PlansPanelView options={options} />, container);
  return {
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
    setOptions: (next: Partial<PlansPanelMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

const samplePlan: PlansPanelPlanSummary = {
  name: "design",
  path: "design.md",
  title: "Design plan",
  status: "in-progress",
};

const samplePlanData: PlansPanelPlanData = {
  content: "# Goals\n\nShip it.\n",
  authorship: {
    sections: {
      Goals: { author: "ai", at: new Date().toISOString(), charCount: 6 },
    },
    stats: { aiPercent: 100, humanPercent: 0, totalChars: 6 },
  },
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("PlansPanel action chips (WN3)", () => {
  it("fires onEdit when the [edit] chip is clicked", () => {
    const onEdit = vi.fn();
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
      onEdit,
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="plans-panel-edit"]');
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onEdit).toHaveBeenCalledOnce();
    dispose();
  });

  it("fires onMarkDone when the [mark done] chip is clicked", () => {
    const onMarkDone = vi.fn();
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
      onMarkDone,
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="plans-panel-mark-done"]');
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onMarkDone).toHaveBeenCalledOnce();
    dispose();
  });

  it("hides [mark done] chip for plans already marked done", () => {
    const onMarkDone = vi.fn();
    const { container, dispose } = mount({
      plan: { ...samplePlan, status: "done" },
      planData: samplePlanData,
      onMarkDone,
    });
    expect(container.querySelector('[data-testid="plans-panel-mark-done"]')).toBeNull();
    dispose();
  });

  it("fires onDelete after the user confirms the prompt", () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const onDelete = vi.fn();
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
      onDelete,
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="plans-panel-delete"]');
    expect(btn).toBeTruthy();
    btn!.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
    dispose();
    vi.unstubAllGlobals();
  });

  it("does NOT fire onDelete if the user cancels the prompt", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const onDelete = vi.fn();
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
      onDelete,
    });
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="plans-panel-delete"]');
    btn!.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
    dispose();
    vi.unstubAllGlobals();
  });

  it("renders no [delete] chip when the host omits onDelete (default-safe)", () => {
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
    });
    expect(container.querySelector('[data-testid="plans-panel-delete"]')).toBeNull();
    dispose();
  });
});
