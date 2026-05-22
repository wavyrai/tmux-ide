/**
 * Contracts test for the virtualized ExplorerDashboard tree.
 *
 * The recursive tree is flattened (honoring expansion) before being
 * fed to the virtualizer. A 1000-entry root list must render only a
 * viewport-sized window while the spacer reports the full height.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ExplorerDashboardView } from "../src/widgets/ExplorerDashboard";
import type { ExplorerDashboardMountOptions, ExplorerNode } from "../src/types";

function file(i: number): ExplorerNode {
  return { name: `file-${i}.ts`, path: `file-${i}.ts`, isDir: false };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ExplorerDashboard virtualization", () => {
  it("renders only a viewport-sized window of rows for a 1000-entry tree", () => {
    const rootEntries = Array.from({ length: 1000 }, (_, i) => file(i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<ExplorerDashboardMountOptions>({ rootEntries });
    const dispose = render(() => <ExplorerDashboardView options={opts} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='explorer-dashboard-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 × at least 22px = 22000px.
    expect(h).toBeGreaterThan(20_000);

    dispose();
  });

  it("flattens an expanded subtree into the virtualized row stream", () => {
    const children = Array.from({ length: 50 }, (_, i) => file(i));
    const rootEntries: ExplorerNode[] = [{ name: "src", path: "src", isDir: true, children }];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<ExplorerDashboardMountOptions>({
      rootEntries,
      defaultExpanded: true,
    });
    const dispose = render(() => <ExplorerDashboardView options={opts} />, container);

    // src + 50 children = 51 flat rows; all fit the stubbed viewport.
    const rows = container.querySelectorAll<HTMLElement>("[data-explorer-row]");
    expect(rows.length).toBe(51);

    dispose();
  });
});
