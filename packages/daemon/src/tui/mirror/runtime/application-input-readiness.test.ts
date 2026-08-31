import { describe, expect, it, vi } from "vitest";

import { createApplicationInputReadiness } from "./application-input-readiness.ts";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function generation(status: "connecting" | "unavailable" | "live" | "empty") {
  return {
    status,
    daemonGeneration: status === "live" || status === "empty" ? "daemon-a" : null,
    client: status === "live" || status === "empty" ? {} : null,
  } as unknown as OpenTuiGenerationHostSnapshot;
}

describe("application input readiness", () => {
  it("keeps explicit-target readiness behind both chrome and usable workspace authority", async () => {
    const chrome = deferred();
    const ready = vi.fn();
    const gate = createApplicationInputReadiness(chrome.promise, true, ready, vi.fn());

    gate.adopt(generation("connecting"));
    chrome.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    gate.adopt(generation("unavailable"));
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    gate.adopt(generation("live"));
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("accepts authoritative empty and lets Home publish after chrome readiness alone", async () => {
    const explicitReady = vi.fn();
    const explicit = createApplicationInputReadiness(
      Promise.resolve(),
      true,
      explicitReady,
      vi.fn(),
    );
    explicit.adopt(generation("empty"));
    await Promise.resolve();
    await Promise.resolve();
    expect(explicitReady).toHaveBeenCalledOnce();

    const homeReady = vi.fn();
    createApplicationInputReadiness(Promise.resolve(), false, homeReady, vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    expect(homeReady).toHaveBeenCalledOnce();
  });
});
