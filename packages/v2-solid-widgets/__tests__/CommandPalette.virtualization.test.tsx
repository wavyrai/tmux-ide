/**
 * Contracts test for the virtualized CommandPalette results list.
 *
 * Seeds 1000 ranked items into a single category and asserts only a
 * viewport-sized window of buttons lands in the DOM while the spacer
 * tracks the full virtual height.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { CommandPaletteView } from "../src/widgets/CommandPalette";
import type { CommandPaletteMountOptions, PaletteCategoryDef, PaletteItem } from "../src/types";

function item(i: number): PaletteItem {
  return { id: `cmd-${i}`, label: `command ${i}`, description: `desc ${i}` };
}

function mount(opts: CommandPaletteMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options] = createSignal<CommandPaletteMountOptions>(opts);
  const dispose = render(() => <CommandPaletteView options={options} />, container);
  return { container, dispose };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CommandPalette virtualization", () => {
  it("renders only a viewport-sized window of items for a 1000-result palette", () => {
    const items = Array.from({ length: 1000 }, (_, i) => item(i));
    const category: PaletteCategoryDef = {
      category: "commands",
      label: "Commands",
      items,
    };
    const { container, dispose } = mount({
      open: true,
      categories: [category],
      perCategoryLimit: 1000,
    });

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(150);

    const spacer = container.querySelector<HTMLElement>("[data-testid='palette-results-spacer']");
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 entries × at least 36px = 36000px of virtual content.
    expect(h).toBeGreaterThan(30_000);

    dispose();
  });
});
