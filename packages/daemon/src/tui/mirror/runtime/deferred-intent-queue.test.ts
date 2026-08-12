import { describe, expect, it } from "vitest";

import { OrderedAsyncIntentQueue, RetryableAsyncRequest } from "./deferred-intent-queue.ts";
import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

describe("deferred modal intent primitives", () => {
  it("clears a rejected physical request so a dependent settings retry can recover", async () => {
    const request = new RetryableAsyncRequest<string>();
    let attempt = 0;
    const load = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("dialogs unavailable"))
        : Promise.resolve("dialogs");
    };

    await expect(request.get(load)).rejects.toThrow("dialogs unavailable");
    await expect(request.get(load)).resolves.toBe("dialogs");
    expect(attempt).toBe(2);
  });

  it("recovers a fail-dialogs then retry-settings dependency chain", async () => {
    let dialogAttempt = 0;
    const registry = new OptionalFeatureRegistry<{ dialogs: string; settings: string }>({
      dialogs: () => {
        dialogAttempt += 1;
        return dialogAttempt === 1
          ? Promise.reject(new Error("dialogs unavailable"))
          : Promise.resolve("dialogs-ready");
      },
      settings: () => Promise.resolve("settings-ready"),
    });
    registry.admit();
    const dialogs = new RetryableAsyncRequest<string | undefined>();
    const settings = new RetryableAsyncRequest<string | undefined>();
    const openSettings = async () => ({
      dialogs: await dialogs.get(() => registry.request("dialogs")),
      settings: await settings.get(() => registry.request("settings")),
    });

    await expect(openSettings()).rejects.toThrow("dialogs unavailable");
    await expect(openSettings()).resolves.toEqual({
      dialogs: "dialogs-ready",
      settings: "settings-ready",
    });
    expect(dialogAttempt).toBe(2);
    registry.dispose();
  });

  it("preserves both callers and their result order when queued before readiness", async () => {
    const queue = new OrderedAsyncIntentQueue();
    let admit!: () => void;
    const ready = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      await ready;
      order.push("first-open");
      return "first-result";
    });
    const second = queue.enqueue(async () => {
      order.push("second-open");
      return "second-result";
    });

    expect(queue.pendingCount).toBe(2);
    admit();
    await expect(Promise.all([first, second])).resolves.toEqual(["first-result", "second-result"]);
    expect(order).toEqual(["first-open", "second-open"]);
    expect(queue.pendingCount).toBe(0);
  });
});
