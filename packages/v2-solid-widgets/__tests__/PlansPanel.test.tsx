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
  content: "# Goals\n\nShip the v2.5 release.\n\n## Tasks\n\n- Wire the bridge.\n",
  authorship: {
    sections: {
      Goals: { author: "ai", at: new Date(Date.now() - 60_000).toISOString(), charCount: 30 },
      Tasks: { author: "thijs", at: new Date(Date.now() - 600_000).toISOString(), charCount: 25 },
    },
    stats: { aiPercent: 50, humanPercent: 50, totalChars: 55 },
  },
};

afterEach(() => {
  // jsdom cleanup between tests
  document.body.innerHTML = "";
});

describe("PlansPanelView", () => {
  it("renders the empty-state placeholder when no plan is selected", () => {
    const { container, dispose } = mount({ plan: null, planData: null });
    const empty = container.querySelector('[data-testid="plans-panel-empty"]');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain("Select a plan");
    dispose();
  });

  it("renders the header with title + status pill when a plan is selected", () => {
    const { container, dispose } = mount({ plan: samplePlan, planData: samplePlanData });
    const header = container.querySelector('[data-testid="plans-panel-header"]');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain("Design plan");
    const pill = container.querySelector('[data-testid="plans-panel-status-pill"]');
    expect(pill?.textContent).toBe("in-progress");
    dispose();
  });

  it("splits markdown into sections — one per H1/H2 heading", () => {
    const { container, dispose } = mount({ plan: samplePlan, planData: samplePlanData });
    const sections = container.querySelectorAll('[data-testid="plans-panel-section"]');
    // Two headings (`# Goals`, `## Tasks`) → two sections. The pre-heading
    // empty preamble is suppressed by the splitter (no heading + no content).
    expect(sections.length).toBe(2);
    dispose();
  });

  it("decorates AI-authored sections with the ai author badge", () => {
    const { container, dispose } = mount({ plan: samplePlan, planData: samplePlanData });
    const badges = container.querySelectorAll('[data-testid="plans-panel-author-badge"]');
    const texts = Array.from(badges).map((b) => b.textContent);
    expect(texts).toContain("ai");
    expect(texts).toContain("thijs");
    dispose();
  });

  it("invokes onMarkDone when the [mark done] button is clicked", () => {
    const onMarkDone = vi.fn();
    const { container, dispose } = mount({
      plan: samplePlan,
      planData: samplePlanData,
      onMarkDone,
    });
    const btn = container.querySelector(
      '[data-testid="plans-panel-mark-done"]',
    ) as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onMarkDone).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("hides [mark done] when the plan status is 'done'", () => {
    const { container, dispose } = mount({
      plan: { ...samplePlan, status: "done" },
      planData: samplePlanData,
      onMarkDone: vi.fn(),
    });
    const btn = container.querySelector('[data-testid="plans-panel-mark-done"]');
    expect(btn).toBeNull();
    dispose();
  });

  it("re-renders the body when planData flows in via setOptions", () => {
    const { container, dispose, setOptions } = mount({
      plan: samplePlan,
      planData: { content: "# A\n\nfirst body\n", authorship: null },
    });
    const before = container.querySelector('[data-testid="plans-panel-markdown"]')?.innerHTML;
    expect(before).toMatch(/first body/);

    setOptions({ planData: { content: "# A\n\nsecond body\n", authorship: null } });
    const after = container.querySelector('[data-testid="plans-panel-markdown"]')?.innerHTML;
    expect(after).toMatch(/second body/);
    expect(after).not.toMatch(/first body/);
    dispose();
  });
});
