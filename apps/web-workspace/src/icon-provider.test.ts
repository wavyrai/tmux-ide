import { describe, expect, it, vi } from "vitest";
import { createIconStore } from "./icon-provider";

describe("semantic icon provider", () => {
  it("uses open icons in a normal web renderer", async () => {
    const store = createIconStore();
    const stop = store.subscribe(vi.fn());
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ provider: "open" });
    stop();
  });
  it("loads the finite native catalog once for all mounted icons", async () => {
    const getCatalog = vi.fn(async () => ({
      provider: "sf-symbols" as const,
      icons: { Home: "data:image/png;base64,YQ==" },
    }));
    const store = createIconStore({ icons: { getCatalog } });
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    const stop2 = store.subscribe(vi.fn());
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(store.getSnapshot().provider).toBe("sf-symbols");
    stop();
    stop2();
  });
  it("rejects arbitrary image URLs, unknown semantic names, and failed hosts", async () => {
    for (const value of [
      { provider: "sf-symbols", icons: { Home: "https://example.com/icon.svg" } },
      { provider: "sf-symbols", icons: { arbitrary: "data:image/png;base64,YQ==" } },
    ]) {
      const store = createIconStore({ icons: { getCatalog: vi.fn().mockResolvedValue(value) } });
      store.subscribe(vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.getSnapshot()).toEqual({ provider: "open" });
    }
    const store = createIconStore({
      icons: { getCatalog: vi.fn().mockRejectedValue(new Error("unavailable")) },
    });
    store.subscribe(vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getSnapshot()).toEqual({ provider: "open" });
  });
});
