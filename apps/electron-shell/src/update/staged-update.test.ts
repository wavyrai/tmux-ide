import { describe, expect, it, vi } from "vitest";

import {
  applyStagedUpdate,
  parsePendingUpdateMarker,
  serializePendingUpdateMarker,
  type PendingUpdateMarker,
  type StagedUpdateFilesystem,
} from "./staged-update.ts";

const SHA = "b".repeat(64);

function marker(overrides: Partial<PendingUpdateMarker> = {}): PendingUpdateMarker {
  return {
    schemaVersion: 1,
    version: "2.8.0",
    stagedPath: "/state/updates/staged/tmux-ide-2.8.0.payload",
    artifactSha256: SHA,
    stagedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function filesystem(overrides: Partial<StagedUpdateFilesystem> = {}): StagedUpdateFilesystem {
  return {
    pathExists: vi.fn(async () => true),
    digestFile: vi.fn(async () => SHA),
    swapIntoPlace: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("parsePendingUpdateMarker", () => {
  it("round-trips a valid marker", () => {
    const original = marker();
    const parsed = parsePendingUpdateMarker(serializePendingUpdateMarker(original));
    expect(parsed).toEqual(original);
  });

  it("returns null for malformed or wrong-schema markers", () => {
    expect(parsePendingUpdateMarker("{not json")).toBeNull();
    expect(parsePendingUpdateMarker("[]")).toBeNull();
    expect(parsePendingUpdateMarker(JSON.stringify({ ...marker(), schemaVersion: 2 }))).toBeNull();
    expect(parsePendingUpdateMarker(JSON.stringify({ ...marker(), version: "" }))).toBeNull();
    expect(
      parsePendingUpdateMarker(JSON.stringify({ ...marker(), artifactSha256: "short" })),
    ).toBeNull();
    expect(parsePendingUpdateMarker(JSON.stringify({ ...marker(), stagedPath: "" }))).toBeNull();
  });
});

describe("applyStagedUpdate", () => {
  it("does nothing when there is no marker", async () => {
    const fs = filesystem();
    expect(await applyStagedUpdate(null, "/install", fs)).toEqual({ status: "none" });
    expect(fs.swapIntoPlace).not.toHaveBeenCalled();
  });

  it("re-verifies and swaps a valid staged payload into place", async () => {
    const fs = filesystem();
    const outcome = await applyStagedUpdate(marker(), "/install/tmux-ide.app", fs);
    expect(outcome).toEqual({ status: "applied", version: "2.8.0" });
    expect(fs.swapIntoPlace).toHaveBeenCalledWith(
      "/state/updates/staged/tmux-ide-2.8.0.payload",
      "/install/tmux-ide.app",
    );
  });

  it("discards a payload that vanished before apply", async () => {
    const fs = filesystem({ pathExists: vi.fn(async () => false) });
    expect(await applyStagedUpdate(marker(), "/install", fs)).toEqual({
      status: "stale-payload-discarded",
      reason: "payload-missing",
    });
    expect(fs.swapIntoPlace).not.toHaveBeenCalled();
  });

  it("discards a payload whose digest no longer matches the marker", async () => {
    const discard = vi.fn(async () => undefined);
    const fs = filesystem({ digestFile: vi.fn(async () => "c".repeat(64)), discard });
    expect(await applyStagedUpdate(marker(), "/install", fs)).toEqual({
      status: "stale-payload-discarded",
      reason: "checksum-mismatch",
    });
    expect(fs.swapIntoPlace).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  it("reports and cleans up when the swap itself fails", async () => {
    const discard = vi.fn(async () => undefined);
    const fs = filesystem({
      swapIntoPlace: vi.fn(async () => {
        throw new Error("ENOTEMPTY");
      }),
      discard,
    });
    expect(await applyStagedUpdate(marker(), "/install", fs)).toEqual({
      status: "stale-payload-discarded",
      reason: "swap-failed",
    });
    expect(discard).toHaveBeenCalledOnce();
  });
});
