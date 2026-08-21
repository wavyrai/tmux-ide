import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./dev-web-host.ts", () => ({
  createDevWebHostCapabilities: vi.fn(() => ({ apiVersion: 1 })),
}));

import { createDevWebHostCapabilities } from "./dev-web-host.ts";
import { installProductionWebHost } from "./install-production-web-host.ts";

describe("installProductionWebHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("publishes a same-origin host only for a capability-bearing document", () => {
    const querySelector = vi.fn(() => ({ content: crypto.randomUUID() }));
    const windowValue = {
      location: { origin: "http://127.0.0.1:43123" },
      tmuxIdeHost: undefined,
    };
    vi.stubGlobal("window", windowValue);
    vi.stubGlobal("document", { querySelector });

    expect(installProductionWebHost()).toBe(true);
    expect(createDevWebHostCapabilities).toHaveBeenCalledWith({
      daemonOrigin: "http://127.0.0.1:43123",
      daemonWebSocketOrigin: "ws://127.0.0.1:43123",
      ownerToken: null,
      transport: "same-origin-gateway",
    });
    expect(windowValue.tmuxIdeHost).toEqual({ apiVersion: 1 });
  });

  it("does not turn an arbitrary production document into a live host", () => {
    const windowValue = {
      location: { origin: "http://127.0.0.1:43123" },
      tmuxIdeHost: undefined,
    };
    vi.stubGlobal("window", windowValue);
    vi.stubGlobal("document", { querySelector: () => null });

    expect(installProductionWebHost()).toBe(false);
    expect(createDevWebHostCapabilities).not.toHaveBeenCalled();
  });
});
