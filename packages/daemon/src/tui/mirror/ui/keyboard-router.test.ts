import { describe, expect, it, vi } from "vitest";

import { createKeyboardRouteOwner } from "./keyboard-router.tsx";

function event(name: string) {
  return {
    name,
    eventType: "press",
    ctrl: false,
    meta: false,
    shift: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("component keyboard route owner", () => {
  it("routes newest-first and stops at the first semantic owner", () => {
    const owner = createKeyboardRouteOwner();
    const calls: string[] = [];
    owner.register(() => {
      calls.push("surface");
      return true;
    });
    owner.register(() => {
      calls.push("overlay");
      return true;
    });

    expect(owner.route(event("enter"))).toBe(true);
    expect(calls).toEqual(["overlay"]);
  });

  it("unregisters and disposes without retaining component handlers", () => {
    const owner = createKeyboardRouteOwner();
    const route = vi.fn(() => false);
    const unregister = owner.register(route);
    expect(owner.size).toBe(1);
    unregister();
    expect(owner.size).toBe(0);
    owner.register(route);
    owner.dispose();
    expect(owner.size).toBe(0);
    expect(owner.route(event("enter"))).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });
});
