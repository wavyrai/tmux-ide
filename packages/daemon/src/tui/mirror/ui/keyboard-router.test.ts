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

it("routes paste only to the newest active owner and releases it on unmount", () => {
  const owner = createKeyboardRouteOwner();
  const underneath = vi.fn(() => true);
  const overlay = vi.fn(() => true);
  owner.registerPaste(underneath);
  const stop = owner.registerPaste(overlay);
  const bytes = Buffer.from("研究");
  expect(owner.routePaste(bytes)).toBe(true);
  expect(overlay).toHaveBeenCalledWith(bytes);
  expect(underneath).not.toHaveBeenCalled();
  stop();
  stop();
  expect(owner.routePaste(bytes)).toBe(true);
  expect(underneath).toHaveBeenCalledOnce();
  owner.dispose();
  expect(owner.routePaste(bytes)).toBe(false);
});
