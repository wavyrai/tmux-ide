/**
 * Contracts test for the virtualized SkillsViewView rail.
 *
 * Seeds 1000 skills and asserts only a viewport-sized window of
 * `[data-skill-name]` rows lands in the DOM while the spacer reports
 * >25000px of virtual content.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { SkillsViewView } from "../src/widgets/SkillsView";
import type { SkillSummary, SkillsViewViewMountOptions } from "../src/types";

function skill(i: number): SkillSummary {
  return {
    name: `skill-${i.toString().padStart(4, "0")}`,
    description: `desc ${i}`,
    role: i % 2 === 0 ? "lead" : "teammate",
    specialties: [`spec-${i % 5}`],
    body: "",
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SkillsViewView virtualization", () => {
  it("renders only a viewport-sized window of rail rows for 1000 skills", () => {
    const skills = Array.from({ length: 1000 }, (_, i) => skill(i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<SkillsViewViewMountOptions>({ skills });
    const dispose = render(() => <SkillsViewView options={opts} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>("[data-testid='skills-rail-spacer']");
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 × at least 28px estimate = 28000px.
    expect(h).toBeGreaterThan(25_000);

    dispose();
  });
});
