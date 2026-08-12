import { describe, expect, it } from "vitest";

import { LatestIntentFence } from "./latest-intent-fence.ts";

describe("LatestIntentFence", () => {
  it("allows only the newest retained async intent to publish", async () => {
    const fence = new LatestIntentFence();
    const publications: string[] = [];
    const retain = (label: string, intent: number) =>
      Promise.resolve().then(() => {
        if (fence.isCurrent(intent)) publications.push(label);
      });

    const older = retain("older", fence.issue());
    const newer = retain("newer", fence.issue());
    await Promise.all([older, newer]);

    expect(publications).toEqual(["newer"]);
  });

  it("retires every outstanding intent during application cleanup", () => {
    const fence = new LatestIntentFence();
    const intent = fence.issue();
    fence.retire();
    expect(fence.isCurrent(intent)).toBe(false);
  });
});
