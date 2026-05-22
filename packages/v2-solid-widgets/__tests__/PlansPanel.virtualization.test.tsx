/**
 * Contracts test for the virtualized PlansPanel sections.
 *
 * Seeds a plan with 500 markdown sections and asserts only a
 * viewport-sized window of section rows renders.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PlansPanelView } from "../src/widgets/PlansPanel";
import type {
  PlansPanelMountOptions,
  PlansPanelPlanData,
  PlansPanelPlanSummary,
} from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PlansPanel virtualization", () => {
  it("renders only a viewport-sized window of sections for a 500-section plan", () => {
    const plan: PlansPanelPlanSummary = {
      name: "huge",
      path: "huge.md",
      title: "Huge plan",
      status: "in-progress",
    };

    // 500 ## headers — the plans panel splits on heading boundaries
    // to produce per-section divs.
    const sections = Array.from(
      { length: 500 },
      (_, i) => `## Section ${i}\n\nBody for section ${i}.\n`,
    ).join("\n");

    const planData: PlansPanelPlanData = {
      content: sections,
      authorship: {
        sections: {},
        stats: { aiPercent: 0, humanPercent: 0, totalChars: sections.length },
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<PlansPanelMountOptions>({ plan, planData });
    const dispose = render(() => <PlansPanelView options={opts} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>("[data-testid='plans-panel-spacer']");
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 500 sections × at least 120px estimate = 60000px.
    expect(h).toBeGreaterThan(50_000);

    dispose();
  });
});
