import { describe, expect, it, vi } from "vitest";
import { NativeSurfaceProviderRegistry } from "./native-surface-provider.ts";
import { NativeSurfaceProviderChannel } from "./native-surface-provider-channel.ts";

const generation = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const auditToken = [1, 2, 3, 4, 5, 6, 7, 8];
const provider = () => ({
  auditToken,
  open: () => ({ start() {}, retire() {}, fallback() {}, close() {} }),
});
const flush = () => Promise.resolve();

describe("native surface availability", () => {
  it("notifies existing viewers after the provider registration acknowledgement", async () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const events: string[] = [];
    registry.watchAvailability((available) => events.push(`available:${available}`));
    await flush();
    const channel = new NativeSurfaceProviderChannel(
      registry,
      (message) => {
        events.push(JSON.parse(message).type);
        return true;
      },
      () => {},
    );
    channel.receive(JSON.stringify({ type: "register", version: 1, generation, auditToken }));
    expect(events).toEqual(["available:false", "registered"]);
    await flush();
    expect(events).toEqual(["available:false", "registered", "available:true"]);
    channel.close();
    await flush();
    expect(events.at(-1)).toBe("available:false");
    registry.close();
  });

  it("coalesces transitions and removes unsubscribed listeners before delivery", async () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const removed = vi.fn(),
      current = vi.fn();
    const unsubscribe = registry.watchAvailability(removed);
    registry.watchAvailability(current);
    const unregister = registry.register(provider());
    unregister();
    registry.register(provider());
    unsubscribe();
    await flush();
    expect(removed).not.toHaveBeenCalled();
    expect(current.mock.calls).toEqual([[true]]);
    registry.close();
    await flush();
    expect(current.mock.calls).toEqual([[true], [false]]);
    expect(() => registry.register(provider())).toThrow("closed");
    expect(() => registry.watchAvailability(vi.fn())).toThrow("unavailable");
  });

  it("bounds subscriptions and isolates a failing observer", async () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const broken = vi.fn(() => {
      throw new Error("observer closed");
    });
    const healthy = vi.fn();
    registry.watchAvailability(broken);
    registry.watchAvailability(healthy);
    const removals = Array.from({ length: 254 }, () => registry.watchAvailability(() => {}));
    expect(() => registry.watchAvailability(() => {})).toThrow("unavailable");
    removals[0]!();
    registry.watchAvailability(() => {});
    await flush();
    registry.register(provider());
    await flush();
    expect(broken).toHaveBeenCalledOnce();
    expect(healthy.mock.calls).toEqual([[false], [true]]);
    registry.close();
  });
});
