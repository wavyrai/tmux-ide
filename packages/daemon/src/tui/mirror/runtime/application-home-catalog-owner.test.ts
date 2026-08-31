import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type {
  ApplicationHomeCatalog,
  ApplicationHomeCatalogSnapshot,
} from "./application-home-catalog.ts";
import { createApplicationHomeCatalogOwner } from "./application-home-catalog-owner.ts";

function catalogRig(initial: ApplicationHomeCatalogSnapshot) {
  let snapshot = initial;
  const listeners = new Set<(value: ApplicationHomeCatalogSnapshot) => void>();
  const start = vi.fn();
  const dispose = vi.fn();
  const catalog: ApplicationHomeCatalog = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    start,
    retry: vi.fn(),
    dispose,
  };
  return {
    catalog,
    start,
    dispose,
    publish(next: ApplicationHomeCatalogSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
  };
}

const snapshot = (
  phase: ApplicationHomeCatalogSnapshot["phase"],
  names: readonly string[],
): ApplicationHomeCatalogSnapshot => ({
  phase,
  daemonInstanceId: phase === "live" ? "daemon-1" : null,
  sessions: names.map((name, index) => ({ id: `session-${index}`, name, paneCount: 1 })),
  note: names.length === 0 ? "No live sessions" : null,
});

describe("application Home catalog owner", () => {
  it("starts only when mounted and automatically opens one live session once", async () => {
    const rig = catalogRig(snapshot("loading", []));
    const startGeneration = vi.fn(async () => undefined);
    let lifecycleClose!: () => void;
    let disposeRoot!: () => void;
    const owner = createRoot((dispose) => {
      disposeRoot = dispose;
      return createApplicationHomeCatalogOwner({
        lifecycle: {
          registerCloser: (_name, close) => {
            lifecycleClose = close;
            return () => undefined;
          },
        },
        automaticOpen: true,
        startGeneration,
        catalog: rig.catalog,
      });
    });

    expect(rig.start).not.toHaveBeenCalled();
    owner.start();
    expect(rig.start).toHaveBeenCalledOnce();
    rig.publish(snapshot("live", ["ordinary"]));
    await Promise.resolve();
    expect(startGeneration).toHaveBeenCalledOnce();
    expect(startGeneration).toHaveBeenCalledWith("ordinary");
    rig.publish(snapshot("live", ["replacement"]));
    await Promise.resolve();
    expect(startGeneration).toHaveBeenCalledOnce();

    lifecycleClose();
    disposeRoot();
    expect(rig.dispose).toHaveBeenCalledOnce();
  });

  it("keeps zero and many sessions on Home and owns keyboard selection", async () => {
    const rig = catalogRig(snapshot("loading", []));
    const startGeneration = vi.fn(async () => undefined);
    let disposeRoot!: () => void;
    const owner = createRoot((dispose) => {
      disposeRoot = dispose;
      return createApplicationHomeCatalogOwner({
        lifecycle: { registerCloser: () => () => undefined },
        automaticOpen: true,
        startGeneration,
        catalog: rig.catalog,
      });
    });

    rig.publish(snapshot("live", []));
    await Promise.resolve();
    expect(owner.handleKey("enter")).toBe(false);
    rig.publish(snapshot("live", ["alpha", "beta"]));
    await Promise.resolve();
    expect(startGeneration).not.toHaveBeenCalled();
    expect(owner.selectedSessionIndex()).toBe(0);
    expect(owner.handleKey("down")).toBe(true);
    expect(owner.selectedSessionIndex()).toBe(1);
    expect(owner.handleKey("enter")).toBe(true);
    expect(startGeneration).toHaveBeenCalledWith("beta");
    expect(owner.handleKey("x")).toBe(false);
    disposeRoot();
  });
});
