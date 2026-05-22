/**
 * Vitest setup: stub layout APIs that happy-dom returns 0 for, so the
 * @tanstack/solid-virtual virtualizer used by MessagesTimeline has a
 * real viewport to slice against.
 *
 * The virtualizer reads `element.offsetHeight` (not
 * `getBoundingClientRect`) for the scroll container and each measured
 * row, and observes resize via a per-element ResizeObserver. Without
 * these stubs every test would see zero rendered rows.
 */

const VIEWPORT = { width: 800, height: 2000 };

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

class ImmediateResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
}
