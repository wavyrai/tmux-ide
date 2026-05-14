/**
 * SkillsView Solid widget — unit tests.
 *
 * Pure renderer tests: mount → assert DOM. No network. Mirrors
 * TasksView.test.tsx / KanbanBoard.test.tsx style.
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

function skill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: "frontend",
    role: "teammate",
    specialties: ["frontend"],
    description: "Owns the React + Solid surfaces in dashboard/",
    body: "## Frontend\n\nFocus on component composition.",
    ...overrides,
  };
}

describe("SkillsView widget", () => {
  it("renders the empty-state for both rail and detail when no skills are supplied", () => {
    mounted = mountWidget({ skills: [] });
    const rail = mounted.container.querySelector('[data-testid="skills-rail"]')!;
    const detail = mounted.container.querySelector('[data-testid="skills-detail"]')!;
    expect(rail).toBeTruthy();
    expect(detail).toBeTruthy();
    expect(rail.querySelector("[data-empty-state]")!.textContent).toContain("no skills registered");
    expect(detail.querySelector("[data-empty-state]")!.textContent).toContain(
      "no skills registered",
    );
  });

  it("renders one rail row per skill and shows the first-specialty hint", () => {
    const skills: SkillSummary[] = [
      skill({ name: "frontend", specialties: ["frontend"] }),
      skill({ name: "backend", specialties: ["backend"] }),
      skill({ name: "reviewer", specialties: [] }),
    ];
    mounted = mountWidget({ skills });
    const rows = mounted.container.querySelectorAll("[data-skill-name]");
    expect(rows.length).toBe(3);
    const names = Array.from(rows).map((r) => r.getAttribute("data-skill-name"));
    expect(names).toEqual(["frontend", "backend", "reviewer"]);
    // Specialty hint surfaces for skills with one; none for the empty case.
    expect(rows[0]!.textContent).toContain("frontend");
    expect(rows[2]!.textContent).not.toContain("frontend");
  });

  it("renders the detail body as HTML via the chat-markdown wrapper when a row is clicked", () => {
    const onSelect = vi.fn();
    mounted = mountWidget({
      skills: [
        skill({
          name: "frontend",
          body: "# Heading\n\nA paragraph with **bold** text.",
        }),
        skill({ name: "backend", body: "## Backend\n\nDifferent body." }),
      ],
      onSelect,
    });
    // First skill is auto-selected (visibleSelection picks the first row).
    const detail = mounted.container.querySelector('[data-testid="skill-detail-body"]')!;
    expect(detail).toBeTruthy();
    expect(detail.className).toContain("chat-markdown");
    expect(detail.innerHTML).toContain("<strong>bold</strong>");

    // Click the second row; detail swaps + onSelect fires.
    const backendRow = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-row-backend"]',
    )!;
    backendRow.click();
    expect(onSelect).toHaveBeenCalledWith("backend");
    expect(mounted.container.querySelector('[data-testid="skill-detail-name"]')!.textContent).toBe(
      "backend",
    );
    expect(
      mounted.container.querySelector('[data-testid="skill-detail-body"]')!.innerHTML,
    ).toContain("Different body");
  });

  it("filters the rail when the user types in the search input", () => {
    mounted = mountWidget({
      skills: [
        skill({ name: "frontend", description: "React + Solid" }),
        skill({ name: "backend", description: "Daemon / Hono / Zod" }),
        skill({ name: "reviewer", description: "Linting / test pass" }),
      ],
    });
    const search = mounted.container.querySelector<HTMLInputElement>(
      '[data-testid="skills-search"]',
    )!;
    search.value = "Hono";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const visible = Array.from(mounted.container.querySelectorAll("[data-skill-name]")).map((el) =>
      el.getAttribute("data-skill-name"),
    );
    expect(visible).toEqual(["backend"]);

    // Clearing the search restores all rows.
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(mounted.container.querySelectorAll("[data-skill-name]").length).toBe(3);
  });

  it("renders the role pill and specialty chips in the detail header", () => {
    mounted = mountWidget({
      skills: [
        skill({
          name: "frontend",
          role: "Lead",
          specialties: ["frontend", "ui-systems"],
        }),
      ],
    });
    const role = mounted.container.querySelector('[data-testid="skill-detail-role"]')!;
    expect(role.textContent).toBe("lead");
    const specs = mounted.container.querySelector('[data-testid="skill-detail-specialties"]')!;
    expect(specs.textContent).toContain("frontend");
    expect(specs.textContent).toContain("ui-systems");
  });

  it("respects initialSelected and lets setOptions push a fresh skill list", () => {
    mounted = mountWidget({
      skills: [
        skill({ name: "frontend", body: "front body" }),
        skill({ name: "backend", body: "back body" }),
      ],
      initialSelected: "backend",
    });
    // initialSelected wins over the first-row default.
    expect(mounted.container.querySelector('[data-testid="skill-detail-name"]')!.textContent).toBe(
      "backend",
    );
    expect(
      mounted.container.querySelector('[data-testid="skill-detail-body"]')!.innerHTML,
    ).toContain("back body");

    // Live-update: push a different skill list. Detail falls back to the
    // first row of the new list because "backend" disappeared.
    mounted.setOptions({
      skills: [skill({ name: "reviewer", body: "review body" })],
    });
    expect(mounted.container.querySelector('[data-testid="skill-detail-name"]')!.textContent).toBe(
      "reviewer",
    );
    expect(
      mounted.container.querySelector('[data-testid="skill-detail-body"]')!.innerHTML,
    ).toContain("review body");
  });

  it("renders a helpful empty-body fallback when the skill has no body", () => {
    mounted = mountWidget({
      skills: [skill({ name: "frontend", body: "" })],
    });
    const detail = mounted.container.querySelector('[data-testid="skills-detail"]')!;
    expect(detail.querySelector('[data-testid="skill-detail-body"]')).toBeNull();
    expect(detail.querySelector("[data-empty-state]")!.textContent).toContain("empty body");
  });
});
