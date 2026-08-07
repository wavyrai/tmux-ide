import { describe, expect, it, vi, type Mock } from "vitest";

import {
  DesktopUpdater,
  resolveManifestUrl,
  type DesktopUpdaterConfig,
  type DesktopUpdaterIo,
} from "./desktop-updater.ts";
import { loopbackOrHttpsArtifactUrl } from "./update-manifest.ts";
import { unsignedFeedManifestVerifier, type ManifestSignatureVerifier } from "./update-verify.ts";
import type { PendingUpdateMarker } from "./staged-update.ts";

const SHA = "a".repeat(64);
const ARTIFACT_SIZE = 2048;

function manifestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    channel: "stable",
    version: "2.8.0",
    artifacts: [
      {
        platform: "darwin-arm64",
        url: "https://dl.example/2.8.0/darwin-arm64.zip",
        size: ARTIFACT_SIZE,
        sha256: SHA,
      },
    ],
    ...overrides,
  });
}

function config(overrides: Partial<DesktopUpdaterConfig> = {}): DesktopUpdaterConfig {
  return {
    enabled: true,
    feedBaseUrl: "https://feed.example/desktop",
    channel: "stable",
    platformKey: "darwin-arm64",
    currentVersion: "2.7.0",
    maxArtifactBytes: 1_000_000,
    checkIntervalMs: 1000,
    trustArtifactUrl: loopbackOrHttpsArtifactUrl,
    ...overrides,
  };
}

interface Harness {
  updater: DesktopUpdater;
  io: {
    fetchManifest: ReturnType<typeof vi.fn>;
    downloadArtifact: ReturnType<typeof vi.fn>;
    stageArtifact: ReturnType<typeof vi.fn>;
    writeMarker: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  };
  markers: PendingUpdateMarker[];
}

function harness(
  options: {
    configOverrides?: Partial<DesktopUpdaterConfig>;
    ioOverrides?: Partial<DesktopUpdaterIo>;
    verifier?: ManifestSignatureVerifier;
    now?: () => number;
  } = {},
): Harness {
  const markers: PendingUpdateMarker[] = [];
  const overrides = options.ioOverrides ?? {};
  const io = {
    fetchManifest: (overrides.fetchManifest ?? vi.fn(async () => manifestBody())) as Mock<
      DesktopUpdaterIo["fetchManifest"]
    >,
    downloadArtifact: (overrides.downloadArtifact ??
      vi.fn(async () => ({
        path: "/tmp/dl/artifact.bin",
        sha256: SHA,
        size: ARTIFACT_SIZE,
      }))) as Mock<DesktopUpdaterIo["downloadArtifact"]>,
    stageArtifact: (overrides.stageArtifact ??
      vi.fn(async () => "/state/staged/tmux-ide-2.8.0.payload")) as Mock<
      DesktopUpdaterIo["stageArtifact"]
    >,
    writeMarker: (overrides.writeMarker ??
      vi.fn(async (marker: PendingUpdateMarker) => {
        markers.push(marker);
      })) as Mock<DesktopUpdaterIo["writeMarker"]>,
    discard: (overrides.discard ?? vi.fn(async () => undefined)) as Mock<
      DesktopUpdaterIo["discard"]
    >,
  };
  const fullIo: DesktopUpdaterIo = {
    ...io,
    log: overrides.log ?? (() => undefined),
    now: options.now ?? overrides.now ?? (() => 1_000_000),
  };
  const updater = new DesktopUpdater({
    config: config(options.configOverrides),
    io: fullIo,
    verifier: options.verifier ?? unsignedFeedManifestVerifier(),
  });
  return { updater, io, markers };
}

describe("resolveManifestUrl", () => {
  it("builds a per-channel URL, trimming trailing slashes", () => {
    expect(resolveManifestUrl("https://feed.example/desktop/", "stable")).toBe(
      "https://feed.example/desktop/stable.json",
    );
    expect(resolveManifestUrl("https://feed.example/desktop", "beta")).toBe(
      "https://feed.example/desktop/beta.json",
    );
  });
});

describe("DesktopUpdater", () => {
  it("runs check → download → verify → stage → ready and writes a marker", async () => {
    const { updater, io, markers } = harness();
    const seen: string[] = [];
    updater.subscribe((status) => seen.push(status.phase));

    await updater.checkNow();

    expect(updater.status()).toEqual({
      phase: "ready",
      currentVersion: "2.7.0",
      availableVersion: "2.8.0",
    });
    expect(updater.hasPendingUpdate()).toBe(true);
    expect(io.stageArtifact).toHaveBeenCalledOnce();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      version: "2.8.0",
      stagedPath: "/state/staged/tmux-ide-2.8.0.payload",
      artifactSha256: SHA,
    });
    // The renderer sees every transition through ready.
    expect(seen).toContain("checking");
    expect(seen).toContain("downloading");
    expect(seen).toContain("ready");
  });

  it("fails closed to idle and discards on a checksum mismatch", async () => {
    const { updater, io, markers } = harness({
      ioOverrides: {
        downloadArtifact: vi.fn(async () => ({
          path: "/tmp/dl/artifact.bin",
          sha256: "f".repeat(64),
          size: ARTIFACT_SIZE,
        })),
      },
    });

    await updater.checkNow();

    expect(updater.status().phase).toBe("idle");
    expect(updater.status().availableVersion).toBeNull();
    expect(io.writeMarker).not.toHaveBeenCalled();
    expect(io.discard).toHaveBeenCalledWith("/tmp/dl/artifact.bin");
    expect(markers).toHaveLength(0);
  });

  it("fails closed on a size mismatch", async () => {
    const { updater, io } = harness({
      ioOverrides: {
        downloadArtifact: vi.fn(async () => ({
          path: "/tmp/dl/artifact.bin",
          sha256: SHA,
          size: ARTIFACT_SIZE + 1,
        })),
      },
    });
    await updater.checkNow();
    expect(updater.status().phase).toBe("idle");
    expect(io.writeMarker).not.toHaveBeenCalled();
  });

  it("treats a not-newer manifest as up-to-date, not a failure", async () => {
    const { updater, io } = harness({
      ioOverrides: { fetchManifest: vi.fn(async () => manifestBody({ version: "2.6.0" })) },
    });
    await updater.checkNow();
    expect(updater.status().phase).toBe("idle");
    expect(io.downloadArtifact).not.toHaveBeenCalled();
  });

  it("rejects a manifest that carries an unverifiable signature", async () => {
    const { updater, io } = harness({
      ioOverrides: { fetchManifest: vi.fn(async () => manifestBody({ signature: "unchecked" })) },
    });
    await updater.checkNow();
    expect(updater.status().phase).toBe("idle");
    expect(io.downloadArtifact).not.toHaveBeenCalled();
  });

  it("stays idle when the feed is unreachable", async () => {
    const { updater, io } = harness({
      ioOverrides: { fetchManifest: vi.fn(async () => null) },
    });
    await updater.checkNow();
    expect(updater.status().phase).toBe("idle");
    expect(io.downloadArtifact).not.toHaveBeenCalled();
  });

  it("survives a download that throws, failing closed", async () => {
    const { updater } = harness({
      ioOverrides: {
        downloadArtifact: vi.fn(async () => {
          throw new Error("network reset");
        }),
      },
    });
    await expect(updater.checkNow()).resolves.toBeUndefined();
    expect(updater.status().phase).toBe("idle");
  });

  it("throttles: a second check inside the interval does not hit the feed again", async () => {
    let clock = 1_000_000;
    const { updater, io } = harness({
      ioOverrides: { fetchManifest: vi.fn(async () => manifestBody({ version: "2.6.0" })) },
      now: () => clock,
    });
    await updater.checkNow();
    clock += 500; // still inside the 1000ms interval
    await updater.checkNow();
    expect(io.fetchManifest).toHaveBeenCalledOnce();
  });

  it("is sticky once ready: further checks do not re-fetch", async () => {
    const { updater, io } = harness();
    await updater.checkNow();
    expect(updater.status().phase).toBe("ready");
    await updater.checkNow();
    expect(io.fetchManifest).toHaveBeenCalledOnce();
  });

  it("is inert when disabled", async () => {
    const { updater, io } = harness({ configOverrides: { enabled: false } });
    await updater.checkNow();
    expect(io.fetchManifest).not.toHaveBeenCalled();
    expect(updater.status().phase).toBe("idle");
  });

  it("finalizePendingUpdateForQuit flips a ready update to applying, else reports none", async () => {
    const idle = harness();
    expect(await idle.updater.finalizePendingUpdateForQuit()).toBe(false);

    const ready = harness();
    await ready.updater.checkNow();
    expect(await ready.updater.finalizePendingUpdateForQuit()).toBe(true);
    expect(ready.updater.status().phase).toBe("applying");
    expect(ready.updater.status().availableVersion).toBe("2.8.0");
  });

  it("never exposes URLs or paths in its status", async () => {
    const { updater } = harness();
    await updater.checkNow();
    const status = updater.status();
    expect(Object.keys(status).sort()).toEqual(["availableVersion", "currentVersion", "phase"]);
  });
});
