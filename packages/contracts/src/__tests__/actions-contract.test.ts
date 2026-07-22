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

  it("keeps config-free workspace admission semantic and its result browser-safe", () => {
    expect(ActionContractsZ["workspace.open"].input.parse({ projectDir: "/tmp/project" })).toEqual({
      projectDir: "/tmp/project",
    });
    for (const [field, value] of [
      ["sessionName", "renderer-session"],
      ["paneId", "%42"],
      ["command", ["sh", "-c", "owned"]],
      ["env", { SECRET: "renderer" }],
    ] as const) {
      expect(
        ActionContractsZ["workspace.open"].input.safeParse({
          projectDir: "/tmp/project",
          [field]: value,
        }).success,
      ).toBe(false);
    }

    const result = ActionContractsZ["workspace.open"].result.parse({
      operationId: "10000000-0000-4000-8000-000000000001",
      daemonInstanceId: "20000000-0000-4000-8000-000000000002",
      outcome: "created",
      resource: {
        resourceVersion: 1,
        workspaceName: "project-00112233445566778899aabbccddeeff",
        initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/projectDir|sessionName|runtime|tmux|path/u);
  });
});
