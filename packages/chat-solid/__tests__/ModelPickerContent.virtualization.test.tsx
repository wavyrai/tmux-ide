/**
 * Contract test for the ModelPickerContent results list.
 *
 * The list is intentionally NOT virtualized: `@tanstack/solid-virtual`
 * rendered `[]` against the built bundle (the same failure that got
 * virtualization removed from MessagesTimeline), so a bounded model
 * list renders in full inside a scroll container. This seeds many
 * models and asserts every row renders with no virtual spacer.
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

describe("ModelPickerContent list rendering", () => {
  it("renders every model row in full (no virtual windowing or spacer)", () => {
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

    // The default sidebar selection surfaces the first instance's
    // 125 models. Searching widens to all 500 across instances.
    const searchInput = container.querySelector<HTMLInputElement>("input[type='text']");
    if (searchInput) {
      searchInput.value = "model-";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    const rows = container.querySelectorAll<HTMLElement>(
      "[data-testid='provider-model-picker-option']",
    );
    // Every match renders — no windowing.
    expect(rows.length).toBe(500);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='model-picker-content-spacer']",
    );
    expect(spacer).toBeNull();

    dispose();
  });
});
