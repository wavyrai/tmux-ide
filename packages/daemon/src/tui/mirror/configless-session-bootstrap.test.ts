import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo, WorkspaceCatalogResourceV2 } from "@tmux-ide/contracts";

import {
  discoverOpenTuiLiveSessions,
  ensureOpenTuiSessionWorkspace,
  type OpenTuiSessionBootstrapDependencies,
} from "./configless-session-bootstrap.ts";

const DAEMON: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-14T10:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-secret",
};

const ALPHA_ID = "session.aaaaaaaaaaaaaaaaaaaa";
const BETA_ID = "session.bbbbbbbbbbbbbbbbbbbb";

function routing(overrides: Partial<WorkspaceCatalogResourceV2> = {}): WorkspaceCatalogResourceV2 {
  return {
    version: 2,
    daemon: {
      protocolVersion: DAEMON.protocolVersion,
      productVersion: DAEMON.productVersion,
      instanceId: DAEMON.instanceId,
      startedAt: DAEMON.startedAt,
    },
    intents: [],
    liveSessions: [],
    ...overrides,
  };
}

function liveSession(sessionName: string, fleetSessionId: string, paneCount = 1) {
  return {
    sessionName,
    fleetSessionId,
    paneCount,
  };
}

function dependencies(input: {
  daemon?: CanonicalDaemonInfo | null;
  alive?: boolean;
  routing?: WorkspaceCatalogResourceV2;
}) {
  const request = vi.fn();
  const promote = vi.fn(async () => ({ promoted: true }));
  const fetchRouting = vi.fn(async () => input.routing ?? routing());
  const isAlive = vi.fn(async () => input.alive ?? true);
  const readDaemon = vi.fn(() => ("daemon" in input ? input.daemon! : DAEMON));
  return {
    request,
    promote,
    fetchRouting,
    isAlive,
    readDaemon,
    overrides: {
      request: request as unknown as typeof fetch,
      promote: promote as unknown as OpenTuiSessionBootstrapDependencies["promote"],
      fetchRouting: fetchRouting as unknown as OpenTuiSessionBootstrapDependencies["fetchRouting"],
      isAlive,
      readDaemon,
    } satisfies Partial<OpenTuiSessionBootstrapDependencies>,
  };
}

describe("configless OpenTUI session bootstrap", () => {
  it("discovers daemon-authoritative live sessions sorted and deduplicated", async () => {
    const test = dependencies({
      routing: routing({
        liveSessions: [
          liveSession("zeta", BETA_ID),
          liveSession("alpha", ALPHA_ID, 2),
          liveSession("zeta", BETA_ID, 3),
        ],
      }),
    });

    const sessions = await discoverOpenTuiLiveSessions(test.overrides);

    expect(sessions).toEqual(["alpha", "zeta"]);
    expect(Object.isFrozen(sessions)).toBe(true);
    expect(test.fetchRouting).toHaveBeenCalledWith(DAEMON, test.overrides.request);
  });

  it("returns the one live session without inventing a separate auto-target", async () => {
    const test = dependencies({
      routing: routing({ liveSessions: [liveSession("only", ALPHA_ID)] }),
    });

    expect(await discoverOpenTuiLiveSessions(test.overrides)).toEqual(["only"]);
  });

  it("returns every live choice deterministically when a chooser is required", async () => {
    const test = dependencies({
      routing: routing({
        liveSessions: [liveSession("beta", BETA_ID), liveSession("alpha", ALPHA_ID)],
      }),
    });

    expect(await discoverOpenTuiLiveSessions(test.overrides)).toEqual(["alpha", "beta"]);
  });

  it("reconciles an existing route because a re-created tmux session may have lost its stamps", async () => {
    const test = dependencies({
      routing: routing({
        intents: [
          {
            workspaceName: "workspace.alpha",
            sessionName: "alpha",
            source: "workspace",
            availability: "live",
          },
        ],
        liveSessions: [liveSession("alpha", ALPHA_ID)],
      }),
    });

    await expect(ensureOpenTuiSessionWorkspace("alpha", test.overrides)).resolves.toBe(true);
    expect(test.request).not.toHaveBeenCalled();
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({ input: { sessionId: ALPHA_ID } }),
    );
  });

  it("promotes an ordinary live session with the fleet's opaque session id", async () => {
    const test = dependencies({
      routing: routing({ liveSessions: [liveSession("alpha", ALPHA_ID)] }),
    });

    await expect(ensureOpenTuiSessionWorkspace("alpha", test.overrides)).resolves.toBe(true);
    expect(test.promote).toHaveBeenCalledOnce();
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:6060",
        ownerToken: "owner-secret",
        name: "workspace.promote",
        input: { sessionId: ALPHA_ID },
        operationId: expect.any(String),
      }),
    );
  });

  it("preserves the explicit target when several live sessions exist", async () => {
    const test = dependencies({
      routing: routing({
        liveSessions: [liveSession("alpha", ALPHA_ID), liveSession("beta", BETA_ID)],
      }),
    });

    await expect(ensureOpenTuiSessionWorkspace("beta", test.overrides)).resolves.toBe(true);
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({ input: { sessionId: BETA_ID } }),
    );
  });

  it("fails closed when the canonical daemon is missing or no longer alive", async () => {
    const missing = dependencies({ daemon: null });
    expect(await discoverOpenTuiLiveSessions(missing.overrides)).toEqual([]);
    await expect(ensureOpenTuiSessionWorkspace("alpha", missing.overrides)).resolves.toBe(false);
    expect(missing.isAlive).not.toHaveBeenCalled();
    expect(missing.fetchRouting).not.toHaveBeenCalled();

    const stale = dependencies({ alive: false });
    expect(await discoverOpenTuiLiveSessions(stale.overrides)).toEqual([]);
    await expect(ensureOpenTuiSessionWorkspace("alpha", stale.overrides)).resolves.toBe(false);
    expect(stale.fetchRouting).not.toHaveBeenCalled();
  });

  it("propagates generation-fenced routing failure without promotion", async () => {
    const test = dependencies({});
    test.fetchRouting.mockRejectedValue(new Error("daemon generation changed"));

    await expect(ensureOpenTuiSessionWorkspace("alpha", test.overrides)).rejects.toThrow(
      "daemon generation changed",
    );
    expect(test.request).not.toHaveBeenCalled();
    expect(test.promote).not.toHaveBeenCalled();
  });

  it("rejects a workspace catalog from another daemon generation", async () => {
    const test = dependencies({
      routing: routing({
        daemon: {
          protocolVersion: DAEMON.protocolVersion,
          productVersion: DAEMON.productVersion,
          instanceId: "22222222-2222-4222-8222-222222222222",
          startedAt: DAEMON.startedAt,
        },
        liveSessions: [liveSession("alpha", ALPHA_ID)],
      }),
    });

    await expect(ensureOpenTuiSessionWorkspace("alpha", test.overrides)).resolves.toBe(false);
    expect(test.promote).not.toHaveBeenCalled();
  });

  it("does not promote a session absent from exact live truth", async () => {
    const absentLive = dependencies({ routing: routing({ liveSessions: [] }) });
    await expect(ensureOpenTuiSessionWorkspace("alpha", absentLive.overrides)).resolves.toBe(false);
    expect(absentLive.request).not.toHaveBeenCalled();
  });

  it("does not confuse session names whose Fleet display labels normalize identically", async () => {
    const controlName = "alpha\tbeta";
    const normalizedName = "alpha beta";
    const test = dependencies({
      routing: routing({
        liveSessions: [liveSession(controlName, ALPHA_ID), liveSession(normalizedName, BETA_ID)],
      }),
    });

    await expect(ensureOpenTuiSessionWorkspace(controlName, test.overrides)).resolves.toBe(true);
    expect(test.promote).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { sessionId: ALPHA_ID } }),
    );
    await expect(ensureOpenTuiSessionWorkspace(normalizedName, test.overrides)).resolves.toBe(true);
    expect(test.promote).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: { sessionId: BETA_ID } }),
    );
  });

  it("does not confuse long session names whose Fleet display labels clamp identically", async () => {
    const prefix = "x".repeat(160);
    const first = `${prefix}-first`;
    const second = `${prefix}-second`;
    const test = dependencies({
      routing: routing({
        liveSessions: [liveSession(first, ALPHA_ID), liveSession(second, BETA_ID)],
      }),
    });

    await expect(ensureOpenTuiSessionWorkspace(second, test.overrides)).resolves.toBe(true);
    expect(test.promote).toHaveBeenCalledWith(
      expect.objectContaining({ input: { sessionId: BETA_ID } }),
    );
  });
});
