import { describe, expect, it } from "vitest";

import { reconcileWorkspaceSelection } from "./workspace-selection.ts";

describe("reconcileWorkspaceSelection", () => {
  it("keeps explicit navigation authoritative", () => {
    expect(
      reconcileWorkspaceSelection({
        liveWorkspaceIds: ["alpha", "beta"],
        explicitWorkspaceId: "beta",
        currentWorkspaceId: "alpha",
        persistedWorkspaceId: "alpha",
        fallback: "first-live",
      }),
    ).toEqual({ workspaceId: "beta", reason: "explicit", rejectedSource: null });
  });

  it("restores a persisted workspace only while it is live", () => {
    expect(
      reconcileWorkspaceSelection({
        liveWorkspaceIds: ["alpha", "beta"],
        persistedWorkspaceId: "beta",
      }),
    ).toEqual({ workspaceId: "beta", reason: "persisted", rejectedSource: null });
  });

  it("self-heals a stale persisted workspace with the requested fallback", () => {
    expect(
      reconcileWorkspaceSelection({
        liveWorkspaceIds: ["new-name"],
        persistedWorkspaceId: "tmi-tui-fixture",
        fallback: "first-live",
      }),
    ).toEqual({
      workspaceId: "new-name",
      reason: "first-live-workspace",
      rejectedSource: "persisted",
    });
  });

  it("does not invent a selection when fallback is disabled", () => {
    expect(
      reconcileWorkspaceSelection({
        liveWorkspaceIds: ["alpha", "beta"],
        persistedWorkspaceId: "gone",
      }),
    ).toEqual({ workspaceId: null, reason: "selection-not-found", rejectedSource: "persisted" });
  });

  it("rejects coerced and duplicate identifiers at the core boundary", () => {
    expect(
      reconcileWorkspaceSelection({
        liveWorkspaceIds: [" alpha ", "alpha", "alpha", "\u0000bad"],
        persistedWorkspaceId: " alpha ",
        fallback: "only-live",
      }),
    ).toEqual({
      workspaceId: "alpha",
      reason: "only-live-workspace",
      rejectedSource: "persisted",
    });
  });
});
