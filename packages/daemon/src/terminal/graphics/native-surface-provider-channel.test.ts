import { describe, expect, it, vi } from "vitest";
import { NativeSurfaceProviderRegistry } from "./native-surface-provider.ts";
import { NativeSurfaceProviderChannel } from "./native-surface-provider-channel.ts";
const generation = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const registration = {
  type: "register",
  version: 1,
  generation,
  auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
};

describe("native provider control channel", () => {
  it("reports bounded per-pane fallback demand only after an explicit watch", async () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const frames: Array<{ type: string; panes?: string[]; required?: string[] }> = [];
    const disconnected = vi.fn();
    const channel = new NativeSurfaceProviderChannel(
      registry,
      (text) => {
        frames.push(JSON.parse(text));
        return true;
      },
      disconnected,
    );
    channel.receive(JSON.stringify(registration));
    registry.demand.presence("s", false);
    const gui = registry.demand.viewer("s", ["pane.one", "pane.two"]);
    gui.native(true);
    await Promise.resolve();
    expect(frames.map((f) => f.type)).toEqual(["registered"]);
    const watch = JSON.stringify({ type: "watch-demand", panes: ["pane.two", "pane.one"] });
    channel.receive(watch);
    await Promise.resolve();
    expect(frames.at(-1)).toEqual({
      type: "kitty-demand",
      panes: ["pane.one", "pane.two"],
      required: [],
    });
    const tui = registry.demand.viewer("s", ["pane.one"]);
    await Promise.resolve();
    expect(frames.at(-1)?.required).toEqual(["pane.one"]);
    const count = frames.length;
    channel.receive(watch);
    registry.demand.presence("s", false);
    await Promise.resolve();
    expect(frames).toHaveLength(count);
    tui.close();
    await Promise.resolve();
    expect(frames.at(-1)?.required).toEqual([]);
    registry.demand.presence("s", null);
    await Promise.resolve();
    expect(frames.at(-1)?.required).toEqual(["pane.one", "pane.two"]);
    channel.close();
    const closedCount = frames.length;
    gui.close();
    await Promise.resolve();
    expect(frames).toHaveLength(closedCount);
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it.each([
    "not-json",
    " ".repeat(16385),
    JSON.stringify({ ...registration, generation: "e01ce8ee-74d8-40d0-9a59-a096050a6adf" }),
    JSON.stringify({ ...registration, path: "/tmp/untrusted" }),
  ])("rejects invalid registration without publishing availability", (message) => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const disconnect = vi.fn();
    const channel = new NativeSurfaceProviderChannel(registry, () => true, disconnect);
    channel.receive(message);
    expect(registry.available).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
    channel.receive(JSON.stringify(registration));
    expect(registry.available).toBe(false);
  });
  it("revokes registration if the bounded output sink cannot accept control", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const disconnect = vi.fn();
    const channel = new NativeSurfaceProviderChannel(registry, () => false, disconnect);
    channel.receive(JSON.stringify(registration));
    expect(registry.available).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
    channel.close();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("rejects competing registration without unregistering the original owner", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const first = new NativeSurfaceProviderChannel(registry, () => true, vi.fn());
    const disconnected = vi.fn();
    const second = new NativeSurfaceProviderChannel(registry, () => true, disconnected);
    first.receive(JSON.stringify(registration));
    second.receive(JSON.stringify(registration));
    expect(disconnected).toHaveBeenCalledOnce();
    expect(registry.available).toBe(true);
    first.close();
    expect(registry.available).toBe(false);
  });
  it("treats a duplicate registration as protocol failure", () => {
    const registry = new NativeSurfaceProviderRegistry(generation);
    const disconnected = vi.fn();
    const channel = new NativeSurfaceProviderChannel(registry, () => true, disconnected);
    channel.receive(JSON.stringify(registration));
    channel.receive(JSON.stringify(registration));
    expect(registry.available).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
  });
});
