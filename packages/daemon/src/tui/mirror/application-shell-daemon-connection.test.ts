import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV2,
} from "@tmux-ide/contracts";
import type { DesktopDaemonTransport } from "@tmux-ide/daemon-client/direct-application-shell-transport";

import {
  openTuiDaemonDescriptor,
  resolveOpenTuiApplicationShellConnection,
} from "./application-shell-daemon-connection.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-09T12:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-secret",
};

const catalog = {
  version: 2,
  daemon: {
    protocolVersion: daemon.protocolVersion,
    productVersion: daemon.productVersion,
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
  },
  intents: [
    {
      workspaceName: "workspace.alpha",
      sessionName: "alpha",
      source: "workspace",
      availability: "live",
    },
  ],
  liveSessions: [
    {
      sessionName: "alpha",
      fleetSessionId: "session.aaaaaaaaaaaaaaaaaaaa",
      paneCount: 1,
    },
  ],
} as WorkspaceCatalogResourceV2;

describe("OpenTUI canonical daemon connection", () => {
  it("derives an uncredentialed host descriptor", () => {
    expect(openTuiDaemonDescriptor(daemon)).toEqual({
      apiBaseUrl: "http://127.0.0.1:6060/",
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    });
  });

  it("resolves transport capabilities without constructing a client session", async () => {
    const transport = {} as DesktopDaemonTransport;
    const createTransport = vi.fn(() => transport);
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toMatchObject({
      workspaceName: "workspace.alpha",
      transport,
      target: { workspaceName: "workspace.alpha" },
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: openTuiDaemonDescriptor(daemon),
        ownerToken: "owner-secret",
        sessionName: "alpha",
        workspaceName: "workspace.alpha",
        applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      }),
    );

    connection?.dispose();
    expect(() =>
      connection?.routing?.assertCurrent({
        daemonInstanceId: daemon.instanceId,
        workspaceName: "workspace.alpha",
        sessionName: "alpha",
      }),
    ).toThrow("has been retired");
  });

  it("returns null before allocating a transport when the session is not live", async () => {
    const createTransport = vi.fn();
    const connection = await resolveOpenTuiApplicationShellConnection("missing", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });
});
