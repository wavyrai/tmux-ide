import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

// Mock the api module BEFORE importing the view so fetchProjectFiles is stubbed.
vi.mock("../src/api", () => ({
  fetchProjectFiles: vi.fn(),
}));

import { ExplorerView } from "../src/widgets/Explorer";
import { fetchProjectFiles } from "../src/api";
import type { ExplorerMountOptions } from "../src/types";
import type { ProjectFileNode } from "../src/api";

function leaf(i: number): ProjectFileNode {
  return { name: `file-${i}.ts`, path: `file-${i}.ts`, isDirectory: false };
}

// Force every Element to report a non-zero rect/scroll size so the TanStack
// virtualizer, which reads getBoundingClientRect + ResizeObserver, has a real
// viewport to compute against. happy-dom otherwise reports zeros.
const VIEWPORT_HEIGHT = 400;

function installLayoutStubs() {
  // The virtualizer reads element.offsetWidth / offsetHeight (not
  // getBoundingClientRect). happy-dom returns 0 for both, so stub the
  // prototype getters to report a real viewport.
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 300;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return VIEWPORT_HEIGHT;
    },
  });

  class ImmediateRO {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ImmediateRO);
}

function uninstallLayoutStubs() {
  delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
}

function mount(initial: ExplorerMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options] = createSignal<ExplorerMountOptions>(initial);
  const dispose = render(() => <ExplorerView options={options} />, container);
  return { container, dispose };
}

const baseOpts: ExplorerMountOptions = {
  sessionName: "test",
  apiBaseUrl: "",
  bearerToken: null,
};

beforeEach(() => {
  vi.mocked(fetchProjectFiles).mockReset();
  installLayoutStubs();
});

afterEach(() => {
  document.body.innerHTML = "";
  uninstallLayoutStubs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ExplorerView virtualization", () => {
  it("renders only a viewport-sized window of rows for a large tree", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => leaf(i));
    vi.mocked(fetchProjectFiles).mockResolvedValue({
      tree: big,
      maxDepth: 1,
      truncated: false,
    });

    const { container, dispose } = mount(baseOpts);

    // Let the resource resolve and Solid flush effects.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const rendered = container.querySelectorAll<HTMLElement>("[data-row-index]");
    // 1000 nodes × 20px = 20000px of virtual content; only the viewport
    // window plus overscan should be in the DOM — far below 1000.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);

    // Spacer reflects the full virtual height (count × estimateSize = 20000px).
    const spacer = container.querySelector<HTMLElement>("[data-testid='v2-explorer-spacer']");
    expect(spacer?.style.height).toBe("20000px");

    // Entry count in the header is the full row count, not the rendered slice.
    expect(container.textContent).toContain("1000 entries");

    dispose();
  });

  it("renders all rows when the tree is smaller than the viewport", async () => {
    const tiny = [leaf(0), leaf(1), leaf(2)];
    vi.mocked(fetchProjectFiles).mockResolvedValue({
      tree: tiny,
      maxDepth: 1,
      truncated: false,
    });

    const { container, dispose } = mount(baseOpts);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const rendered = container.querySelectorAll<HTMLElement>("[data-row-index]");
    expect(rendered.length).toBe(3);
    expect(rendered[0]?.getAttribute("data-row-path")).toBe("file-0.ts");

    dispose();
  });
});
