import { describe, expect, it, vi } from "vitest";
import { queueNativeScrollHint, registerNativeScrollHint } from "./native-scroll-hints.ts";

describe("native scroll hints", () => {
  it("is optional and forwards the renderer context and content bounds unchanged", () => {
    const context = { rendererPtr: 12, frameId: 42 };
    expect(() => queueNativeScrollHint(context, 4, 2, 80, 24)).not.toThrow();
    const handler = vi.fn();
    const dispose = registerNativeScrollHint(handler);
    try {
      queueNativeScrollHint(context, 4, 2, 80, 24);
      expect(handler).toHaveBeenCalledExactlyOnceWith(context, 4, 2, 80, 24);
      expect(handler.mock.calls[0][0]).toBe(context);
      dispose();
      queueNativeScrollHint(context, 4, 2, 80, 24);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("does not let stale disposal remove a newer registration of the same handler", () => {
    const handler = vi.fn();
    const oldDispose = registerNativeScrollHint(handler);
    const dispose = registerNativeScrollHint(handler);
    try {
      oldDispose();
      queueNativeScrollHint({}, 0, 0, 1, 1);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});
