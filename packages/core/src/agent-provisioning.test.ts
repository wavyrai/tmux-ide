import { describe, expect, it } from "vitest";

import {
  projectProvisioningTargets,
  provisioningPlacementForTarget,
  targetFirstProvisioningStage,
} from "./agent-provisioning.ts";

describe("target-first provisioning", () => {
  it("places the active semantic pane first and keeps unavailable workspaces visible", () => {
    const targets = projectProvisioningTargets(
      [
        { name: "workspace.beta", label: "Beta", available: false },
        { name: "workspace.alpha", label: "Alpha", available: true },
      ],
      { workspaceName: "workspace.alpha", semanticPaneId: "pane.editor", paneLabel: "Editor" },
    );
    expect(targets).toEqual([
      expect.objectContaining({ kind: "pane", label: "Editor", workspaceName: "workspace.alpha" }),
      expect.objectContaining({ kind: "workspace", label: "Alpha", available: true }),
      expect.objectContaining({ kind: "workspace", label: "Beta", available: false }),
    ]);
  });

  it("projects the same semantic placement for every renderer", () => {
    expect(provisioningPlacementForTarget({ kind: "workspace", semanticPaneId: null })).toEqual({
      kind: "window",
    });
    expect(
      provisioningPlacementForTarget({ kind: "pane", semanticPaneId: "pane.editor" }, "down"),
    ).toEqual({ kind: "split", direction: "down", targetSemanticPaneId: "pane.editor" });
  });

  it("moves through where, what, details without renderer state", () => {
    const target = projectProvisioningTargets([
      { name: "workspace.alpha", label: "Alpha", available: true },
    ])[0]!;
    expect(targetFirstProvisioningStage(null, null)).toBe("target");
    expect(targetFirstProvisioningStage(target, null)).toBe("kind");
    expect(targetFirstProvisioningStage(target, "agent")).toBe("details");
  });
});
