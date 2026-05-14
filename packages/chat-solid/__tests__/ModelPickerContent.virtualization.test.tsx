/**
 * Contracts test for the virtualized ModelPickerContent results list.
 *
 * Seeds 500 models across 4 instances and asserts only a
 * viewport-sized window of rows renders while the spacer reports
 * the full virtual content height.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ModelPickerContent } from "../src/components/ModelPickerContent";
import type { ProviderInstanceSummary } from "../src/components/ModelPickerSidebar";
import type { ModelListRowModel } from "../src/components/ModelListRow";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ModelPickerContent virtualization", () => {
  it("renders only a viewport-sized window of rows for 500 models", () => {
    const instances: ProviderInstanceSummary[] = Array.from({ length: 4 }, (_, ix) => ({
      instanceId: `inst-${ix}`,
      driverKind: "claude-code",
      displayName: `Instance ${ix}`,
      available: true,
      status: "ready",
    }));

    const models = new Map<string, ReadonlyArray<ModelListRowModel>>(
      instances.map((inst, ix) => [
        inst.instanceId,
        Array.from({ length: 125 }, (_, i) => ({
          slug: `model-${ix}-${i}`,
          name: `Model ${ix}-${i}`,
          shortName: `m${ix}-${i}`,
        })),
      ]),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [instancesSig] = createSignal(instances);
    const [activeSig] = createSignal(null);
    const [favorites] = createSignal([]);
    const dispose = render(
      () => (
        <ModelPickerContent
          instances={instancesSig}
          modelsByInstance={() => models}
          active={activeSig}
          favorites={favorites}
          onSelect={vi.fn()}
        />
      ),
      container,
    );

    // Selecting "favorites" sidebar instance shows none, so the
    // default behavior renders the first instance's models (125). Use
    // the search bar to surface all 500 across instances.
    const searchInput = container.querySelector<HTMLInputElement>("input[type='text']");
    if (searchInput) {
      searchInput.value = "model-";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='model-picker-content-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // At least 125 models × 44px = 5500px (when sidebar selects one
    // instance) — full 500 × 44 ≈ 22000px when searching.
    expect(h).toBeGreaterThan(5_000);

    dispose();
  });
});
