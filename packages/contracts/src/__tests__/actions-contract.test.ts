import { describe, expect, it } from "vitest";
import { ActionContractsZ } from "../actions-contract.ts";

describe("daemon action contract", () => {
  it("supports generation-pinned cooperative shutdown", () => {
    const instanceId = "9bcf33b0-c837-4a94-b5e8-c0977f54464f";

    expect(
      ActionContractsZ["daemon.shutdown"].input.parse({
        reason: "takeover",
        expectedInstanceId: instanceId,
      }),
    ).toEqual({ reason: "takeover", expectedInstanceId: instanceId });
    expect(
      ActionContractsZ["daemon.shutdown"].input.safeParse({
        expectedInstanceId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});
