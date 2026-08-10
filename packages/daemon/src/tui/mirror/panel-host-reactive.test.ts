import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { trackPanelHostDirectory } from "./panel-host-reactive.ts";

describe("trackPanelHostDirectory", () => {
  it("does not subscribe to or recurse through loader-owned signals", async () => {
    const [directory, setDirectory] = createSignal("/one");
    const [hydrationRevision, setHydrationRevision] = createSignal(0);
    const loads: string[] = [];
    const dispose = createRoot((disposeRoot) => {
      trackPanelHostDirectory(directory, (nextDirectory) => {
        hydrationRevision();
        loads.push(nextDirectory);
        setHydrationRevision((revision) => revision + 1);
      });
      return disposeRoot;
    });

    await Promise.resolve();
    expect(loads).toEqual(["/one"]);
    setHydrationRevision(10);
    expect(loads).toEqual(["/one"]);
    setDirectory("/two");
    expect(loads).toEqual(["/one", "/two"]);
    dispose();
  });
});
