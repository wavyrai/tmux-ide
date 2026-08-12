import { describe, expect, it } from "vitest";

import { GenerationBoundSlot } from "./generation-bound-slot.ts";

describe("GenerationBoundSlot", () => {
  it("discards a deferred resource when authority advances before publication", () => {
    const slot = new GenerationBoundSlot<string>();
    slot.advance(1);
    slot.retain(1, "workspace-a");
    slot.advance(2);

    expect(slot.take(2)).toBeUndefined();
    expect(slot.take(1)).toBeUndefined();
  });

  it("publishes one retained value only to its current generation", () => {
    const slot = new GenerationBoundSlot<string>();
    slot.advance(4);
    slot.retain(4, "workspace-b");

    expect(slot.take(4)).toBe("workspace-b");
    expect(slot.take(4)).toBeUndefined();
  });
});
