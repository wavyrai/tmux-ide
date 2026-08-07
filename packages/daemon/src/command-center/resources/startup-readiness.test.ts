import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { StartupReadinessResourceSchemaZ } from "@tmux-ide/contracts";

import { analyzeTrustedSemanticPaneCatalog } from "../../terminal/attachments/semantic-pane-catalog.ts";
import type {
  NativeTerminalInventoryPaneSnapshot,
  NativeTerminalInventorySnapshot,
} from "../../terminal/attachments/native-runtime.ts";
import {
  projectStartupReadinessLadder,
  summarizeStartupReadinessCatalog,
  type StartupReadinessFacts,
} from "./startup-readiness.ts";
import {
  mountStartupReadinessRoute,
  readStartupReadinessLadder,
  type StartupReadinessAttachmentAuthority,
  type StartupReadinessRouteOptions,
} from "./startup-readiness-route.ts";

const OBSERVED_AT = "2026-08-04T12:00:00.000Z";
const NOW = () => Date.parse(OBSERVED_AT);

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.7.0",
  instanceId: "0f5a2a3e-6f0a-4f1a-9f2b-1c2d3e4f5a6b",
  startedAt: "2026-08-04T11:59:00.000Z",
} as const;

function pane(
  overrides: Partial<NativeTerminalInventoryPaneSnapshot> = {},
): NativeTerminalInventoryPaneSnapshot {
  return {
    workspaceName: "workspace.alpha",
    sessionName: "zz-alpha",
    sessionId: "$1",
    windowId: "@1",
    runtimePaneId: "%1",
    semanticPaneId: "pane.worker",
    windowStamp: null,
    windowPaneCount: 1,
    sessionWindowCount: 1,
    index: 0,
    title: "worker",
    currentCommand: "zsh",
    active: true,
    role: null,
    name: null,
    type: null,
    missionStamp: null,
    dir: "/tmp/alpha",
    ...overrides,
  };
}

function inventory(
  panes: readonly NativeTerminalInventoryPaneSnapshot[],
): NativeTerminalInventorySnapshot {
  const rows = panes.map(
    ({
      sessionName: _sessionName,
      index: _index,
      title: _title,
      currentCommand: _currentCommand,
      active: _active,
      role: _role,
      name: _name,
      type: _type,
      missionStamp: _missionStamp,
      dir: _dir,
      ...row
    }) => row,
  );
  return { panes, catalog: analyzeTrustedSemanticPaneCatalog(rows) };
}

function facts(overrides: Partial<StartupReadinessFacts> = {}): StartupReadinessFacts {
  return {
    ownerCapability: true,
    identity: DAEMON,
    catalog: { status: "read", workspaceCount: 1, attachablePaneCount: 1, blockingReason: null },
    attachment: "ready",
    ...overrides,
  };
}

describe("catalog summary from a live inventory", () => {
  it("counts an attachable single-pane window", () => {
    const summary = summarizeStartupReadinessCatalog(inventory([pane()]), 1);
    expect(summary).toEqual({
      status: "read",
      workspaceCount: 1,
      attachablePaneCount: 1,
      blockingReason: null,
    });
  });

  it("reports the unstamped-pane fault when nothing is attachable", () => {
    const summary = summarizeStartupReadinessCatalog(
      inventory([pane({ semanticPaneId: null })]),
      1,
    );
    expect(summary).toEqual({
      status: "read",
      workspaceCount: 1,
      attachablePaneCount: 0,
      blockingReason: "missing-semantic-stamp",
    });
  });

  it("reports an unstamped multi-pane window as missing its window stamp", () => {
    const summary = summarizeStartupReadinessCatalog(
      inventory([
        pane({ semanticPaneId: "pane.one", runtimePaneId: "%1", windowPaneCount: 2 }),
        pane({
          semanticPaneId: "pane.two",
          runtimePaneId: "%2",
          windowPaneCount: 2,
          active: false,
        }),
      ]),
      1,
    );
    expect(summary).toMatchObject({
      attachablePaneCount: 0,
      blockingReason: "missing-window-stamp",
    });
  });

  it("counts both panes of a properly stamped multi-pane window", () => {
    const summary = summarizeStartupReadinessCatalog(
      inventory([
        pane({
          semanticPaneId: "pane.one",
          runtimePaneId: "%1",
          windowPaneCount: 2,
          windowStamp: "window.alpha",
        }),
        pane({
          semanticPaneId: "pane.two",
          runtimePaneId: "%2",
          windowPaneCount: 2,
          windowStamp: "window.alpha",
          active: false,
        }),
      ]),
      1,
    );
    expect(summary).toMatchObject({ attachablePaneCount: 2, blockingReason: null });
  });

  it("reports an empty pane set for registered workspaces without inventing a fault", () => {
    expect(summarizeStartupReadinessCatalog(inventory([]), 2)).toEqual({
      status: "read",
      workspaceCount: 2,
      attachablePaneCount: 0,
      blockingReason: null,
    });
  });
});

describe("ladder projection, rung by rung", () => {
  it("walks every rung when the daemon holds everything it needs", () => {
    const ladder = projectStartupReadinessLadder(facts(), OBSERVED_AT);
    expect(ladder.blockedAt).toBeNull();
    expect(ladder.rungs[3]).toMatchObject({
      status: "satisfied",
      population: { fleet: "populated", workspaceCount: 1, attachablePaneCount: 1 },
    });
  });

  it("stops at credential-held when the daemon holds no owner capability", () => {
    const ladder = projectStartupReadinessLadder(facts({ ownerCapability: false }), OBSERVED_AT);
    expect(ladder.blockedAt).toBe("credential-held");
    expect(ladder.rungs[1]).toMatchObject({
      status: "stuck",
      reason: { vocabulary: "startup-readiness", code: "owner-capability-unavailable" },
    });
  });

  it("stops at identity-established when no identity could be proven", () => {
    const ladder = projectStartupReadinessLadder(facts({ identity: null }), OBSERVED_AT);
    expect(ladder.blockedAt).toBe("identity-established");
    expect(ladder.rungs[2]).toMatchObject({
      reason: { vocabulary: "startup-readiness", code: "daemon-identity-unavailable" },
    });
  });

  it("treats an empty fleet as satisfied, not stuck", () => {
    const ladder = projectStartupReadinessLadder(
      facts({
        catalog: {
          status: "read",
          workspaceCount: 0,
          attachablePaneCount: 0,
          blockingReason: null,
        },
      }),
      OBSERVED_AT,
    );
    expect(ladder.blockedAt).toBeNull();
    expect(ladder.rungs[3]).toMatchObject({
      status: "satisfied",
      population: { fleet: "empty", workspaceCount: 0, attachablePaneCount: 0 },
    });
  });

  it("stops at catalog-populated with the typed catalog fault", () => {
    const ladder = projectStartupReadinessLadder(
      facts({
        catalog: {
          status: "read",
          workspaceCount: 1,
          attachablePaneCount: 0,
          blockingReason: "duplicate-semantic-stamp",
        },
      }),
      OBSERVED_AT,
    );
    expect(ladder.blockedAt).toBe("catalog-populated");
    expect(ladder.rungs[3]).toMatchObject({
      reason: { vocabulary: "terminal-resource-unavailable", code: "duplicate-semantic-stamp" },
    });
  });

  it("distinguishes registered-but-unreachable sessions from an empty fleet", () => {
    const ladder = projectStartupReadinessLadder(
      facts({
        catalog: {
          status: "read",
          workspaceCount: 2,
          attachablePaneCount: 0,
          blockingReason: null,
        },
      }),
      OBSERVED_AT,
    );
    expect(ladder.blockedAt).toBe("catalog-populated");
    expect(ladder.rungs[3]).toMatchObject({
      reason: { vocabulary: "startup-readiness", code: "catalog-sessions-unreachable" },
    });
  });

  it("stops at catalog-populated when discovery itself failed", () => {
    const ladder = projectStartupReadinessLadder(
      facts({ catalog: { status: "discovery-failed" } }),
      OBSERVED_AT,
    );
    expect(ladder.rungs[3]).toMatchObject({
      reason: { vocabulary: "startup-readiness", code: "catalog-discovery-failed" },
    });
  });

  it("stops at attachment-issuable when the runtime never passed its barrier", () => {
    const ladder = projectStartupReadinessLadder(facts({ attachment: "unready" }), OBSERVED_AT);
    expect(ladder.blockedAt).toBe("attachment-issuable");
    expect(ladder.rungs[4]).toMatchObject({
      reason: { vocabulary: "startup-readiness", code: "attachment-runtime-unready" },
    });
  });
});

function routeOptions(
  overrides: Partial<StartupReadinessRouteOptions> = {},
): StartupReadinessRouteOptions {
  const runtime: StartupReadinessAttachmentAuthority = {
    discoverTerminalInventory: async () => inventory([pane()]),
    lifecycleState: () => "ready",
  };
  return {
    daemon: DAEMON,
    ownerToken: "owner-token",
    registry: { list: () => [{ name: "workspace.alpha", sessionName: "zz-alpha" }] as never },
    attachmentRuntime: runtime,
    inspectCanonical: () =>
      ({
        status: "valid",
        info: { instanceId: DAEMON.instanceId },
        observation: {},
      }) as never,
    now: NOW,
    ...overrides,
  };
}

describe("readiness read from real state", () => {
  it("reports the fully walked ladder", async () => {
    const ladder = await readStartupReadinessLadder(routeOptions());
    expect(ladder.blockedAt).toBeNull();
    expect(ladder.observedAt).toBe(OBSERVED_AT);
  });

  it("reports a mismatched canonical record with the host-issue vocabulary", async () => {
    const ladder = await readStartupReadinessLadder(
      routeOptions({
        inspectCanonical: () =>
          ({
            status: "valid",
            info: { instanceId: "11111111-2222-3333-4444-555555555555" },
            observation: {},
          }) as never,
      }),
    );
    expect(ladder.blockedAt).toBe("identity-established");
    expect(ladder.rungs[2]).toMatchObject({
      reason: { vocabulary: "desktop-daemon-host-issue", code: "identity-mismatch" },
    });
  });

  it("reports a missing canonical record", async () => {
    const ladder = await readStartupReadinessLadder(
      routeOptions({ inspectCanonical: () => ({ status: "missing" }) as never }),
    );
    expect(ladder.rungs[2]).toMatchObject({
      reason: { vocabulary: "desktop-daemon-host-issue", code: "record-missing" },
    });
  });

  it("survives a discovery that throws — the ladder reports it, nothing crashes", async () => {
    const ladder = await readStartupReadinessLadder(
      routeOptions({
        attachmentRuntime: {
          discoverTerminalInventory: () => Promise.reject(new Error("tmux socket is gone")),
          lifecycleState: () => "ready",
        },
      }),
    );
    expect(ladder.blockedAt).toBe("catalog-populated");
    expect(ladder.rungs[3]).toMatchObject({
      reason: { vocabulary: "startup-readiness", code: "catalog-discovery-failed" },
    });
  });
});

describe("the readiness route", () => {
  async function get(
    options: Partial<StartupReadinessRouteOptions>,
    headers: Record<string, string> = { Authorization: "Bearer owner-token" },
  ): Promise<Response> {
    const app = new Hono();
    mountStartupReadinessRoute(app, routeOptions(options));
    return app.request("/api/resources/startup-readiness", { headers });
  }

  it("serves a schema-valid, generation-stamped, uncached resource", async () => {
    const response = await get({});
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const parsed = StartupReadinessResourceSchemaZ.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.daemon.instanceId).toBe(DAEMON.instanceId);
  });

  it("rejects a caller without the owner capability", async () => {
    const response = await get({}, { Authorization: "Bearer wrong-token" });
    expect(response.status).toBe(401);
  });

  it("answers the credential rung instead of 503 when the daemon holds no owner token", async () => {
    const app = new Hono();
    mountStartupReadinessRoute(app, routeOptions({ ownerToken: null }));
    const response = await app.request("/api/resources/startup-readiness");
    expect(response.status).toBe(200);
    const body = StartupReadinessResourceSchemaZ.parse(await response.json());
    expect(body.ladder.blockedAt).toBe("credential-held");
    expect(body.ladder.rungs[1]).toMatchObject({
      status: "stuck",
      reason: { vocabulary: "startup-readiness", code: "owner-capability-unavailable" },
    });
    // The stuck ladder carries no fleet facts at all.
    expect(JSON.stringify(body)).not.toContain("workspace");
  });

  it("keeps serving when the catalog pass fails", async () => {
    const response = await get({
      attachmentRuntime: {
        discoverTerminalInventory: () => Promise.reject(new Error("tmux socket is gone")),
        lifecycleState: () => "failed",
      },
    });
    expect(response.status).toBe(200);
    const body = StartupReadinessResourceSchemaZ.parse(await response.json());
    expect(body.ladder.blockedAt).toBe("catalog-populated");
  });
});
