import "@testing-library/jest-dom/vitest";

// happy-dom returns 0 for layout dimensions. The @tanstack/solid-virtual
// virtualizer reads `element.offsetHeight` to compute the viewport and
// per-row size; without a non-zero stub it slices zero items and any
// render test that asserts on virtualized rows sees nothing.
const VIEWPORT = { width: 1024, height: 2000 };

if (typeof globalThis.HTMLElement !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return VIEWPORT.width;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return VIEWPORT.height;
    },
  });
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}
