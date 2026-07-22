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

  it("accepts only renderer-safe semantic workspace pane creation", () => {
    const input = { kind: "terminal", workspaceName: "workspace.alpha" } as const;
    expect(ActionContractsZ["workspace.pane.create"].input.parse(input)).toEqual(input);
    for (const [field, value] of [
      ["cwd", "/tmp/project"],
      ["argv", ["sh", "-c", "owned"]],
      ["env", { SECRET: "renderer" }],
      ["paneId", "%42"],
      ["sessionName", "runtime-session"],
    ] as const) {
      expect(
        ActionContractsZ["workspace.pane.create"].input.safeParse({
          ...input,
          [field]: value,
        }).success,
      ).toBe(false);
    }
  });
});
