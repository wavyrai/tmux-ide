import { describe, it, expect, vi } from "vitest";
import { projectWorkspaceCatalogV2 } from "@tmux-ide/contracts";
import { openSelectedWorkspace } from "./open-workspace";
const identity = {
  protocolVersion: 1,
  productVersion: "test",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};
const sessionId = "session.aaaaaaaaaaaaaaaaaaaa";
function rig(existing = false) {
  const envelope = projectWorkspaceCatalogV2(
    identity,
    existing ? [{ workspaceName: "project", sessionName: "live-name", source: "workspace" }] : [],
    [{ sessionName: "live-name", fleetSessionId: sessionId, paneCount: 2 }],
  );
  return {
    fetchWorkspaceCatalog: vi.fn(async () => ({ status: "ok" as const, envelope })),
    promoteWorkspace: vi.fn(async () => ({
      status: "ok" as const,
      result: {
        operationId: identity.instanceId,
        daemonInstanceId: identity.instanceId,
        outcome: "promoted" as const,
        resource: { resourceVersion: 1 as const, workspaceName: "promoted-project" },
      },
    })),
  };
}
describe("selected session opening", () => {
  it("uses the catalog workspace name without promoting a registered session", async () => {
    const daemon = rig(true);
    expect(await openSelectedWorkspace(daemon, identity.instanceId, sessionId)).toBe("project");
    expect(daemon.promoteWorkspace).not.toHaveBeenCalled();
  });
  it("promotes only the selected opaque session and uses its returned route", async () => {
    const daemon = rig();
    expect(await openSelectedWorkspace(daemon, identity.instanceId, sessionId)).toBe(
      "promoted-project",
    );
    expect(daemon.promoteWorkspace).toHaveBeenCalledExactlyOnceWith({ sessionId });
  });
  it("does not promote stale-machine, missing-session or cancelled requests", async () => {
    const daemon = rig();
    await expect(openSelectedWorkspace(daemon, "other-generation", sessionId)).rejects.toThrow(
      "connection changed",
    );
    await expect(
      openSelectedWorkspace(daemon, identity.instanceId, "session.bbbbbbbbbbbbbbbbbbbb"),
    ).rejects.toThrow("no longer available");
    const controller = new AbortController();
    controller.abort();
    await expect(
      openSelectedWorkspace(daemon, identity.instanceId, sessionId, controller.signal),
    ).rejects.toThrow();
    expect(daemon.promoteWorkspace).not.toHaveBeenCalled();
  });
  it("rejects a promotion result from another daemon generation", async () => {
    const daemon = rig();
    const original = await daemon.promoteWorkspace();
    daemon.promoteWorkspace.mockResolvedValue({
      ...original,
      result: { ...original.result, daemonInstanceId: "20000000-0000-4000-8000-000000000002" },
    });
    await expect(openSelectedWorkspace(daemon, identity.instanceId, sessionId)).rejects.toThrow(
      "connection changed",
    );
  });
});
