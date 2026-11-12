import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_STARTUP_PROBE_ATTEMPTS,
  createEmbeddedTmuxServerOwners,
} from "./embedded-tmux-server-owners.ts";

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("./tmux-server-registration.ts", () => ({
  readTmuxServerRegistrations: () => [],
  writeTmuxServerRegistrations: vi.fn(),
  createDiagnosedTmuxServerProbe: () => mocks.probe,
}));
beforeEach(() => {
  mocks.probe.mockReset();
  mocks.probe.mockResolvedValue({ fingerprint: "verified", valid: () => true });
});

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

  // #840: listing servers while one tmux probe misses must not drop the default owner's streams.
  describe("a missed probe and the adopted default owner", () => {
    const timeout = { failure: "timeout", detail: "probe exceeded 500ms", durationMs: 500 };
    const verified = (pid: number) => ({
      fingerprint: "verified",
      valid: () => true,
      nativeServerIdentity: { pid: String(pid), startTime: "100" },
    });
    const embed = async (dispose: (retirement?: string) => Promise<void>) =>
      createEmbeddedTmuxServerOwners({
        environmentId: "00000000-0000-4000-8000-000000000001",
        defaultAuthority: {
          executablePath: "/fixture/tmux",
          socketSelector: { kind: "path", path: "/fixture/socket" },
        },
        defaultGeneration: "00000000-0000-4000-8000-000000000002",
        expectedDefaultProofDigest: "verified",
        defaultOwner: { dispose } as Parameters<
          typeof createEmbeddedTmuxServerOwners
        >[0]["defaultOwner"],
        stateDirectory: "/fixture",
        webSocketBaseUrl: "ws://localhost:1234",
      });

    it("keeps the default owner and its generation while the server process lives", async () => {
      const dispose = vi.fn(async () => {});
      mocks.probe.mockResolvedValue(verified(process.pid));
      const embedded = await embed(dispose);
      const [before] = embedded.owners.list();
      mocks.probe.mockResolvedValue(timeout);
      const [after] = await embedded.owners.refresh();
      expect(after).toEqual(before);
      expect(after).toMatchObject({ state: "online" });
      expect(dispose).not.toHaveBeenCalled();
      expect(embedded.isDefaultCurrent()).toBe(true);
      expect(embedded.defaultRetired).toBe(false);
      await embedded.dispose();
      expect(dispose).toHaveBeenCalledExactlyOnceWith("shutdown");
    });

    it("retires the default owner as server-gone once its server process no longer exists", async () => {
      const dispose = vi.fn(async () => {});
      const deadPid = 2 ** 22 - 3; // above every platform's default pid range in CI and on macOS
      mocks.probe.mockResolvedValue(verified(deadPid));
      const embedded = await embed(dispose);
      mocks.probe.mockResolvedValue(timeout);
      expect((await embedded.owners.refresh())[0]).toMatchObject({ state: "offline" });
      expect(dispose).toHaveBeenCalledExactlyOnceWith("server-gone");
      expect(embedded.defaultRetired).toBe(true);
      await embedded.dispose();
    });

    it("asks again at startup instead of leaving the default owner unadopted", async () => {
      const dispose = vi.fn(async () => {});
      mocks.probe
        .mockResolvedValueOnce(timeout)
        .mockResolvedValueOnce(timeout)
        .mockResolvedValue(verified(process.pid));
      const embedded = await embed(dispose);
      expect(mocks.probe).toHaveBeenCalledTimes(DEFAULT_SERVER_STARTUP_PROBE_ATTEMPTS);
      expect(embedded.owners.list()[0]).toMatchObject({
        state: "online",
        generation: "00000000-0000-4000-8000-000000000002",
      });
      expect(dispose).not.toHaveBeenCalled();
      await embedded.dispose();
    });

    it("does not wait out the retries when tmux itself says there is no server", async () => {
      mocks.probe.mockResolvedValue({ failure: "no-server", detail: "no server running" });
      const embedded = await embed(vi.fn(async () => {}));
      // One startup probe, then the registration's own probe.
      expect(mocks.probe).toHaveBeenCalledTimes(2);
      expect(embedded.owners.list()[0]).toMatchObject({ state: "offline" });
      await embedded.dispose();
    });
  });
});
