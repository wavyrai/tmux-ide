import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo, WorkspaceCatalogResourceV1 } from "@tmux-ide/contracts";
import type {
  ApplicationShellSession,
  ApplicationShellTransport,
} from "@tmux-ide/daemon-client/application-shell-session";

import {
  connectOpenTuiApplicationShellAuthority,
  openTuiDaemonDescriptor,
} from "./application-shell-daemon-session.ts";

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
  version: 1,
  daemon: {
    protocolVersion: daemon.protocolVersion,
    productVersion: daemon.productVersion,
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
  },
  workspaces: [{ workspaceName: "workspace.alpha", sessionName: "alpha" }],
} as WorkspaceCatalogResourceV1;

describe("OpenTUI canonical application-shell authority", () => {
  it("derives an uncredentialed descriptor from the canonical daemon", () => {
    expect(openTuiDaemonDescriptor(daemon)).toEqual({
      apiBaseUrl: "http://127.0.0.1:6060/",
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    });
  });

  it("maps the runtime session through the catalog and creates the shared client session", async () => {
    const transport = {} as ApplicationShellTransport;
    const session = {} as ApplicationShellSession;
    const createTransport = vi.fn(() => transport);
    const createSession = vi.fn(() => session);
    const authority = await connectOpenTuiApplicationShellAuthority("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceCatalog: async () => catalog,
      createTransport,
      createSession,
    });

    expect(authority).toMatchObject({ workspaceName: "workspace.alpha", session });
    expect(authority?.target.workspaceName).toBe("workspace.alpha");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: "alpha", ownerToken: "owner-secret" }),
    );
    expect(createSession).toHaveBeenCalledWith({ target: authority?.target, transport });
  });

  it("keeps standalone TUI mode when no canonical authority owns the session", async () => {
    const authority = await connectOpenTuiApplicationShellAuthority("missing", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceCatalog: async () => catalog,
    });
    expect(authority).toBeNull();
  });
});
