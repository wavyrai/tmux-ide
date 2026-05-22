/**
 * Contracts test for the virtualized PlansRail.
 *
 * Mocks the /api/project/:name/plans response with 1000 plans across
 * status groups and asserts that only a viewport-sized window of
 * rows lands in the DOM while the spacer tracks the full virtual
 * height.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { PlansRailView } from "../src/widgets/PlansRail";
import type { PlanStatus, PlanSummary } from "../src/api";
import type { PlansRailMountOptions } from "../src/types";

const originalFetch = globalThis.fetch;

function plan(i: number, status: PlanStatus): PlanSummary {
  return {
    name: `plan-${i}`,
    path: `plan-${i}.md`,
    title: `Plan ${i}`,
    status,
    effort: null,
    owner: `agent-${i % 4}`,
    updated: new Date(Date.now() - i * 1000).toISOString(),
    completed: null,
    tags: [],
  };
}

beforeEach(() => {
  const statuses: PlanStatus[] = ["in-progress", "pending", "done", "archived"];
  const plans: PlanSummary[] = Array.from({ length: 1000 }, (_, i) =>
    plan(i, statuses[i % statuses.length]!),
  );
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ plans }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
});

describe("PlansRail virtualization", () => {
  it("renders only a viewport-sized window of plan rows for 1000 plans", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [options] = createSignal<PlansRailMountOptions>({
      sessionName: "test",
      apiBaseUrl: "",
      bearerToken: null,
    });
    const dispose = render(() => <PlansRailView options={options} />, container);

    // Let the polling fetch + Solid effects flush.
    await new Promise((r) => setTimeout(r, 30));

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>("[data-testid='plans-rail-spacer']");
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 4 group headers (32px) + 1000 plan rows (60px) ≈ 60128px.
    expect(h).toBeGreaterThan(50_000);

    dispose();
  });
});
