import { describe, expect, it, vi } from "vitest";
import { createEmbeddedTmuxServerOwners } from "./embedded-tmux-server-owners.ts";

vi.mock("./tmux-server-registration.ts", () => ({
  readTmuxServerRegistrations: () => [],
  writeTmuxServerRegistrations: vi.fn(),
  createTmuxServerProbe: () => async () => ({ fingerprint: "verified", valid: () => true }),
}));

describe("embedded owner initialization cleanup", () => {
  it("preserves the default owner's editor resolver on adopted scoped access and revokes access on disposal", async () => {
    const generation = "00000000-0000-4000-8000-000000000002";
    const target = {
      generation,
      workspaceName: "project",
      liveSessionId: "live-session.01234567890123456789",
      semanticPaneId: "pane-main",
    };
    const observation = {
      ...target,
      cwd: { kind: "absolute" as const, path: "/observed/live" },
      directory: "/observed/live",
    };
    const resolvePaneEditorContext = vi.fn(async () => observation);
    const dispose = vi.fn(async () => {});
    const embedded = await createEmbeddedTmuxServerOwners({
      environmentId: "00000000-0000-4000-8000-000000000001",
      defaultAuthority: {
        executablePath: "/fixture/tmux",
        socketSelector: { kind: "path", path: "/fixture/socket" },
      },
      defaultGeneration: generation,
      expectedDefaultProofDigest: "verified",
      defaultOwner: { resolvePaneEditorContext, dispose } as Parameters<
        typeof createEmbeddedTmuxServerOwners
      >[0]["defaultOwner"],
      stateDirectory: "/fixture",
      webSocketBaseUrl: "ws://localhost:1234",
    });
    const scope = { serverId: embedded.owners.registrations()[0]!.serverId, generation };
    try {
      expect(
        await embedded.owners.withOwner(scope, (owner) => owner.resolvePaneEditorContext(target)),
      ).toEqual(observation);
      expect(resolvePaneEditorContext).toHaveBeenCalledExactlyOnceWith(target);
    } finally {
      await embedded.dispose();
    }
    expect(() => embedded.owners.current(scope)).toThrow("disposed");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("retires the default exactly once if evidence scope initialization fails before adoption", async () => {
    const dispose = vi.fn(async () => {});
    const failure = new Error("inventory initialization failed");
    await expect(
      createEmbeddedTmuxServerOwners({
        environmentId: "00000000-0000-4000-8000-000000000001",
        defaultAuthority: {
          executablePath: "/fixture/tmux",
          socketSelector: { kind: "path", path: "/fixture/socket" },
        },
        defaultGeneration: "00000000-0000-4000-8000-000000000002",
        expectedDefaultProofDigest: "verified",
        onDefaultScope: async () => {
          throw failure;
        },
        defaultOwner: { dispose } as Parameters<
          typeof createEmbeddedTmuxServerOwners
        >[0]["defaultOwner"],
        stateDirectory: "/fixture",
        webSocketBaseUrl: "ws://localhost:1234",
      }),
    ).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
