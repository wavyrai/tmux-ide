/**
 * The shell's half of the readiness wiring: read the daemon's own ladder and
 * carry it on the disconnected state the renderer receives.
 *
 * The defect this covers is that the daemon computed the ladder and nobody
 * fetched it, so the two rungs only the daemon can answer never reached a
 * screen. These tests hold the fetch to its contract — bounded, failure
 * tolerant, never able to disturb the connection verdict it travels with.
 */
import {
  buildStartupReadinessLadder,
  type DesktopDaemonHostState,
  type StartupReadinessLadder,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfoState } from "../../../packages/daemon/src/canonical.ts";
import { DaemonConnectionCoordinator } from "./daemon-connection-coordinator.ts";
import { readDaemonStartupReadinessLadder } from "./startup-readiness-probe.ts";

const OBSERVED_AT = "2026-08-05T09:00:00.000Z";

const DAEMON_IDENTITY = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "6d1b1c2e-9a1e-4f7a-8b0d-2f9c7e3a5d41",
  startedAt: "2026-08-05T08:59:00.000Z",
} as const;

/** A ladder that is stuck where only the daemon can see it. */
function stuckCatalogLadder(): StartupReadinessLadder {
  return buildStartupReadinessLadder(
    [
      { status: "satisfied" },
      { status: "satisfied" },
      { status: "satisfied" },
      {
        status: "stuck",
        reason: { vocabulary: "startup-readiness", code: "catalog-sessions-unreachable" },
      },
    ],
    OBSERVED_AT,
  );
}

function validRecord(): CanonicalDaemonInfoState {
  return {
    status: "valid",
    info: {
      pid: 4242,
      port: 6060,
      bindHostname: "127.0.0.1",
      authToken: "owner-token",
      ...DAEMON_IDENTITY,
    },
    observation: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  });
}

const DISCONNECTED: DesktopDaemonHostState = {
  status: "degraded",
  code: "identity-mismatch",
  reason: "Canonical daemon verification is degraded.",
};

describe("readDaemonStartupReadinessLadder", () => {
  it("reads the daemon's ladder with the owner capability from the canonical record", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ version: 1, daemon: DAEMON_IDENTITY, ladder: stuckCatalogLadder() }),
    );
    const ladder = await readDaemonStartupReadinessLadder({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
    });
    expect(ladder?.blockedAt).toBe("catalog-populated");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:6060/api/resources/startup-readiness");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer owner-token");
  });

  it("answers null when there is no canonical record to read", async () => {
    const fetchImpl = vi.fn();
    const ladder = await readDaemonStartupReadinessLadder({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      inspectCanonical: () => ({ status: "missing" }),
    });
    expect(ladder).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers null for a refused, unparseable, or non-JSON response", async () => {
    const refused = await readDaemonStartupReadinessLadder({
      fetch: (async () => jsonResponse({ error: "no" }, 401)) as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
    });
    expect(refused).toBeNull();

    const nonsense = await readDaemonStartupReadinessLadder({
      fetch: (async () =>
        jsonResponse({
          version: 1,
          daemon: DAEMON_IDENTITY,
          ladder: { rungs: [] },
        })) as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
    });
    expect(nonsense).toBeNull();

    const html = await readDaemonStartupReadinessLadder({
      fetch: (async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
    });
    expect(html).toBeNull();
  });

  it("gives up on its own deadline rather than hanging the state it travels with", async () => {
    // A daemon that accepts the connection and then says nothing is the case
    // that would otherwise stall every disconnected state composition.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const started = Date.now();
    const ladder = await readDaemonStartupReadinessLadder({
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
      timeoutMs: 25,
    });
    expect(ladder).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers null when the fetch itself throws", async () => {
    const ladder = await readDaemonStartupReadinessLadder({
      fetch: (() => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
      inspectCanonical: validRecord,
    });
    expect(ladder).toBeNull();
  });
});

describe("DaemonConnectionCoordinator startup readiness carry", () => {
  it("carries the daemon's ladder on the disconnected state it publishes", async () => {
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: DISCONNECTED,
      preflight: { probe: async () => DISCONNECTED },
      readStartupReadiness: async () => stuckCatalogLadder(),
    });
    await coordinator.refreshConnection();
    const state = coordinator.state();
    expect(state.status).toBe("degraded");
    if (state.status === "connected") throw new Error("expected a disconnected state");
    expect(state.startupReadiness?.blockedAt).toBe("catalog-populated");
    coordinator.dispose();
  });

  it("still publishes a usable state when the ladder cannot be read", async () => {
    const readStartupReadiness = vi.fn(async () => {
      throw new Error("daemon is gone");
    });
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: DISCONNECTED,
      preflight: { probe: async () => DISCONNECTED },
      readStartupReadiness,
    });
    await expect(coordinator.refreshConnection()).resolves.toBeDefined();
    const state = coordinator.state();
    if (state.status === "connected") throw new Error("expected a disconnected state");
    expect(state.startupReadiness).toBeUndefined();
    expect(state.code).toBe("identity-mismatch");
    expect(readStartupReadiness).toHaveBeenCalled();
    coordinator.dispose();
  });

  it("reads the ladder for a daemon that answers but cannot be brokered", async () => {
    const connected: DesktopDaemonHostState = {
      status: "connected",
      descriptor: { apiBaseUrl: "http://127.0.0.1:6060", ...DAEMON_IDENTITY },
    };
    const readStartupReadiness = vi.fn(async () => stuckCatalogLadder());
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: DISCONNECTED,
      preflight: { probe: async () => connected },
      createBroker: () => {
        throw new Error("broker is not needed for this assertion");
      },
      readStartupReadiness,
    });
    await coordinator.refreshConnection();
    const state = coordinator.state();
    // The probe reached a daemon and the broker factory still refused: the app
    // is disconnected from something that is demonstrably answering, so the
    // daemon's own ladder is exactly what the user needs to be shown.
    if (state.status === "connected") throw new Error("expected a disconnected state");
    expect(state.code).toBe("resource-broker-failed");
    expect(state.startupReadiness?.blockedAt).toBe("catalog-populated");
    coordinator.dispose();
  });
});
