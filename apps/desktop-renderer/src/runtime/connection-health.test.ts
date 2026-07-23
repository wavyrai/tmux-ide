import { describe, expect, it } from "vitest";
import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

import {
  deriveConnectionHealth,
  statusStripFromConnectionHealth,
  transportStateReason,
} from "./connection-health.ts";

const ERROR = {
  code: "event-unavailable",
  reason: "The daemon event connection is unavailable.",
} as const;

const RECONNECTING: DesktopDaemonTransportState = {
  phase: "reconnecting",
  attempt: 2,
  maximumAttempts: 6,
  nextRetryAt: 1_753_000_000_000,
  error: ERROR,
};

describe("deriveConnectionHealth", () => {
  it("keeps the transport and data-sync axes independent", () => {
    // The matrix that matters: a healthy socket with a failed read is
    // "connected, sync degraded" — never a fake reconnect — and a reconnect is
    // reported with its real attempt state regardless of the last sync result.
    const failed = { ok: false, reason: "The fleet catalog request failed." };
    const healthy = { ok: true };

    expect(deriveConnectionHealth({ phase: "connected" }, healthy)).toEqual({ kind: "connected" });
    expect(deriveConnectionHealth({ phase: "connected" }, failed)).toEqual({
      kind: "connected-sync-degraded",
      reason: "The fleet catalog request failed.",
    });
    for (const sync of [healthy, failed]) {
      expect(deriveConnectionHealth(RECONNECTING, sync)).toEqual({
        kind: "reconnecting",
        attempt: 2,
        maximumAttempts: 6,
        nextRetryAt: 1_753_000_000_000,
        reason: ERROR.reason,
      });
      expect(deriveConnectionHealth({ phase: "stopped", error: ERROR }, sync)).toEqual({
        kind: "stopped",
        reason: ERROR.reason,
      });
      expect(deriveConnectionHealth({ phase: "connecting" }, sync)).toEqual({
        kind: "connecting",
      });
      expect(deriveConnectionHealth(null, sync)).toEqual({ kind: "unknown" });
      expect(deriveConnectionHealth({ phase: "idle" }, sync)).toEqual({ kind: "unknown" });
    }
  });

  it("defaults a missing sync reason honestly", () => {
    expect(deriveConnectionHealth({ phase: "connected" }, { ok: false })).toEqual({
      kind: "connected-sync-degraded",
      reason: "The latest workspace read failed.",
    });
  });

  it("treats a transient degraded fault as recovery in progress", () => {
    expect(deriveConnectionHealth({ phase: "degraded", error: ERROR }, { ok: true })).toMatchObject(
      { kind: "reconnecting", reason: ERROR.reason },
    );
  });
});

describe("statusStripFromConnectionHealth", () => {
  it("yields no override while healthy so the projection's own segment renders", () => {
    expect(statusStripFromConnectionHealth({ kind: "connected" })).toBeNull();
    expect(statusStripFromConnectionHealth({ kind: "unknown" })).toBeNull();
  });

  it("renders a real reconnect as recovering with its attempt position", () => {
    expect(
      statusStripFromConnectionHealth({
        kind: "reconnecting",
        attempt: 2,
        maximumAttempts: 6,
        nextRetryAt: 1_753_000_000_000,
        reason: ERROR.reason,
      }),
    ).toMatchObject({
      state: "recovering",
      message: "Reconnecting to the engine (attempt 2 of 6)",
    });
  });

  it("renders a sync failure on a healthy socket as connected, never as a reconnect", () => {
    const strip = statusStripFromConnectionHealth({
      kind: "connected-sync-degraded",
      reason: "The fleet catalog request failed.",
    });
    expect(strip).toMatchObject({
      state: "recovering",
      message: "Connected — sync degraded: The fleet catalog request failed.",
    });
    expect(strip?.message).not.toMatch(/reconnect/iu);
  });

  it("renders the fatal stop as disconnected with the explicit recovery action", () => {
    expect(
      statusStripFromConnectionHealth({ kind: "stopped", reason: ERROR.reason }),
    ).toMatchObject({
      state: "disconnected",
      nextAction: "Recheck the daemon to reconnect",
    });
  });
});

describe("transportStateReason", () => {
  it("produces the status sentence for every derivable phase", () => {
    expect(transportStateReason({ phase: "idle" })).toBeNull();
    expect(transportStateReason({ phase: "connected" })).toBeNull();
    expect(transportStateReason({ phase: "connecting" })).toBe(
      "Connecting to the engine event stream.",
    );
    expect(transportStateReason({ phase: "degraded", error: ERROR })).toBe(
      `Engine event connection degraded — ${ERROR.reason}`,
    );
    expect(transportStateReason(RECONNECTING)).toBe("Reconnecting to the engine (attempt 2 of 6).");
    expect(transportStateReason({ phase: "stopped", error: ERROR })).toBe(
      "Engine event reconnection attempts were exhausted. Recheck the daemon to reconnect.",
    );
  });
});
