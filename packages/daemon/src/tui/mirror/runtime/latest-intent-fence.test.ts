import { describe, expect, it } from "vitest";

import { LatestIntentFence } from "./latest-intent-fence.ts";

describe("LatestIntentFence", () => {
  it("allows only the newest retained async intent to publish", async () => {
    const fence = new LatestIntentFence<string>();
    const publications: string[] = [];
    const retain = (label: string, intent: ReturnType<typeof fence.issue>) =>
      Promise.resolve().then(() => {
        if (fence.isCurrent(intent, "workspace-a")) publications.push(label);
      });

    const older = retain("older", fence.issue("workspace-a"));
    const newer = retain("newer", fence.issue("workspace-a"));
    await Promise.all([older, newer]);

    expect(publications).toEqual(["newer"]);
  });

  it.each(["home", "terminal"])("retires an open intent on %s navigation", () => {
    const fence = new LatestIntentFence<string>();
    const intent = fence.issue("workspace-a");
    fence.retire();
    expect(fence.isCurrent(intent, "workspace-a")).toBe(false);
  });

  it("rejects a workspace A intent after the host moves to workspace B", () => {
    const fence = new LatestIntentFence<string>();
    const intent = fence.issue("workspace-a");
    expect(fence.isCurrent(intent, "workspace-b")).toBe(false);
  });
});
