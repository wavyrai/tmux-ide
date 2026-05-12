import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PlansRailView } from "../src/widgets/PlansRail";
import type { PlanSummary } from "../src/api";
import type { PlansRailMountOptions } from "../src/types";

const originalFetch = globalThis.fetch;

function mockPlansResponse(plans: PlanSummary[]) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ plans }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
}

function mountRail(initial: PlansRailMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<PlansRailMountOptions>(initial);
  const dispose = render(() => <PlansRailView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<PlansRailMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

const samplePlans: PlanSummary[] = [
  {
    name: "alpha",
    path: "alpha.md",
    title: "Alpha plan",
    status: "in-progress",
    effort: null,
    owner: "thijs",
    updated: new Date(Date.now() - 60_000).toISOString(),
    completed: null,
    tags: ["frontend"],
  },
  {
    name: "beta",
    path: "beta.md",
    title: "Beta plan",
    status: "done",
    effort: null,
    owner: "claude",
    updated: new Date(Date.now() - 3_600_000).toISOString(),
    completed: new Date(Date.now() - 3_600_000).toISOString(),
    tags: [],
  },
  {
    name: "gamma",
    path: "gamma.md",
    title: "Gamma plan",
    status: "pending",
    effort: null,
    owner: null,
    updated: null,
    completed: null,
    tags: [],
  },
];

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

describe("PlansRail (Solid widget)", () => {
  beforeEach(() => {
    mockPlansResponse(samplePlans);
  });

  it("renders all plans grouped by status", async () => {
    const { container, dispose } = mountRail({
      sessionName: "my-project",
      apiBaseUrl: "",
      bearerToken: null,
    });

    // wait for the fetch microtask to flush
    await new Promise((r) => setTimeout(r, 0));

    const items = container.querySelectorAll<HTMLElement>("[data-testid='plans-rail-item']");
    expect(items.length).toBe(3);
    const titles = Array.from(items).map((i) => i.textContent ?? "");
    expect(titles.some((t) => t.includes("Alpha plan"))).toBe(true);
    expect(titles.some((t) => t.includes("Beta plan"))).toBe(true);
    expect(titles.some((t) => t.includes("Gamma plan"))).toBe(true);

    // Status data attribute is per-status; verify each appears.
    const statuses = new Set(Array.from(items).map((i) => i.dataset.planStatus));
    expect(statuses.has("in-progress")).toBe(true);
    expect(statuses.has("done")).toBe(true);
    expect(statuses.has("pending")).toBe(true);

    dispose();
  });

  it("fires onSelect with the plan path when a row is clicked", async () => {
    const onSelect = vi.fn();
    const { container, dispose } = mountRail({
      sessionName: "my-project",
      apiBaseUrl: "",
      bearerToken: null,
      onSelect,
    });

    await new Promise((r) => setTimeout(r, 0));

    const alpha = container.querySelector<HTMLElement>(
      "[data-testid='plans-rail-item'][data-plan-file='alpha.md']",
    );
    expect(alpha).toBeTruthy();
    alpha!.click();
    expect(onSelect).toHaveBeenCalledWith("alpha.md");

    dispose();
  });

  it("fires onCreate when the New plan footer button is clicked", async () => {
    const onCreate = vi.fn();
    const { container, dispose } = mountRail({
      sessionName: "my-project",
      apiBaseUrl: "",
      bearerToken: null,
      onCreate,
    });

    await new Promise((r) => setTimeout(r, 0));

    const create = container.querySelector<HTMLElement>(
      "[data-testid='plans-rail-create']",
    );
    expect(create).toBeTruthy();
    create!.click();
    expect(onCreate).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("filters by the search input", async () => {
    const { container, dispose } = mountRail({
      sessionName: "my-project",
      apiBaseUrl: "",
      bearerToken: null,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(
      container.querySelectorAll("[data-testid='plans-rail-item']").length,
    ).toBe(3);

    const search = container.querySelector<HTMLInputElement>(
      "[data-testid='plans-rail-search']",
    );
    expect(search).toBeTruthy();
    search!.value = "alpha";
    search!.dispatchEvent(new Event("input", { bubbles: true }));

    const remaining = container.querySelectorAll("[data-testid='plans-rail-item']");
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.textContent).toContain("Alpha plan");

    dispose();
  });
});
