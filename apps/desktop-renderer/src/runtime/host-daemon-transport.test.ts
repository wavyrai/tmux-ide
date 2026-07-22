import {
  APPLICATION_SHELL_RESOURCE_VERSION,
  COHESION_FIXTURE_V1,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import { createHostDaemonTransport } from "./host-daemon-transport.ts";

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
} as const;

const RESOURCE = {
  project: COHESION_FIXTURE_V1.project,
  workspace: COHESION_FIXTURE_V1.workspace,
  dock: COHESION_FIXTURE_V1.dock,
  focus: COHESION_FIXTURE_V1.focus,
  connection: COHESION_FIXTURE_V1.connection,
};

function daemonHost(
  overrides: Partial<HostCapabilities["daemon"]> = {},
): Pick<HostCapabilities, "daemon"> {
  return {
    daemon: {
      refreshConnection: async () => ({
        outcome: "unchanged",
        daemon: { status: "connected", identity: DAEMON },
      }),
      listWorkspaces: async () => ({
        status: "ok",
        daemon: DAEMON,
        workspaces: [{ workspaceName: "product" }],
      }),
      fetchApplicationShell: async () => ({
        status: "ok",
        envelope: {
          version: APPLICATION_SHELL_RESOURCE_VERSION,
          daemon: DAEMON,
          resource: RESOURCE,
        },
      }),
      subscribe: async () => ({ status: "subscribed", unsubscribe: () => undefined }),
      ...overrides,
    },
  };
}

describe("HostCapabilities-backed daemon transport", () => {
  it("fetches by semantic workspace only and verifies the returned generation", async () => {
    const fetchApplicationShell = vi.fn(daemonHost().daemon.fetchApplicationShell);
    const transport = createHostDaemonTransport(
      daemonHost({
        fetchApplicationShell,
      }),
    );
    const result = await transport.fetchApplicationShell(
      { daemon: DAEMON, workspaceName: "product" },
      new AbortController().signal,
    );
    expect(result).toEqual(RESOURCE);
    expect(fetchApplicationShell).toHaveBeenCalledWith({ workspaceName: "product" });
    expect(JSON.stringify(fetchApplicationShell.mock.calls)).not.toMatch(
      /apiBaseUrl|sessionName|token|authorization/iu,
    );

    await expect(
      createHostDaemonTransport(
        daemonHost({
          fetchApplicationShell: async () => ({
            status: "ok",
            envelope: {
              version: APPLICATION_SHELL_RESOURCE_VERSION,
              daemon: { ...DAEMON, instanceId: "66ab67ed-18fe-431b-913b-70972b78c96f" },
              resource: RESOURCE,
            },
          }),
        }),
      ).fetchApplicationShell(
        { daemon: DAEMON, workspaceName: "product" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "daemon-identity-mismatch" });
  });

  it("maps bounded host failures and honors renderer cancellation", async () => {
    const unavailable = createHostDaemonTransport(
      daemonHost({
        fetchApplicationShell: async () => ({
          status: "error",
          error: { code: "workspace-not-found", reason: "The workspace is unavailable." },
        }),
      }),
    );
    await expect(
      unavailable.fetchApplicationShell(
        { daemon: DAEMON, workspaceName: "missing" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "not-found", statusCode: 404 });

    const pending = createHostDaemonTransport(
      daemonHost({
        fetchApplicationShell: async () => new Promise(() => undefined),
      }),
    );
    const controller = new AbortController();
    const request = pending.fetchApplicationShell(
      { daemon: DAEMON, workspaceName: "product" },
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("adapts sanitized host invalidations without creating another socket authority", async () => {
    let publish: ((event: DesktopDaemonEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(async (_request, listener) => {
      publish = listener;
      return { status: "subscribed" as const, unsubscribe };
    });
    const transport = createHostDaemonTransport(daemonHost({ subscribe }));
    const handlers = {
      onVerifiedOpen: vi.fn(),
      onInvalidate: vi.fn(),
      onProtocolError: vi.fn(),
      onPeerMismatch: vi.fn(),
      onMalformedFrame: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    };
    const connection = transport.connectEvents(
      { daemon: DAEMON, workspaceName: "product" },
      handlers,
    );
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    expect(subscribe.mock.calls[0]?.[0]).toEqual({ workspaceNames: ["product"] });

    publish?.({ type: "connection.changed", state: "live", error: null });
    publish?.({ type: "application-shell.changed", workspaceName: "another-workspace" });
    publish?.({ type: "application-shell.changed", workspaceName: "product" });
    publish?.({
      type: "connection.changed",
      state: "degraded",
      error: {
        code: "daemon-identity-mismatch",
        reason: "The daemon generation changed during the resource request.",
      },
    });
    publish?.({
      type: "daemon-generation.changed",
      previousIdentity: DAEMON,
      daemon: {
        status: "unavailable",
        code: "process-not-running",
        reason: "The canonical daemon is unavailable.",
      },
    });
    expect(handlers.onVerifiedOpen).toHaveBeenCalledOnce();
    expect(handlers.onInvalidate).toHaveBeenCalledOnce();
    expect(handlers.onPeerMismatch).toHaveBeenCalledTimes(2);

    publish?.({
      type: "connection.changed",
      state: "degraded",
      error: { code: "protocol-error", reason: "The subscription was rejected." },
    });
    expect(handlers.onProtocolError).toHaveBeenCalledOnce();

    connection.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    publish?.({ type: "workspaces.changed" });
    expect(handlers.onInvalidate).toHaveBeenCalledOnce();
  });

  it("rejects raw route metadata in a store target", () => {
    const transport = createHostDaemonTransport(daemonHost());
    expect(() =>
      transport.validateTarget({
        daemon: DAEMON,
        workspaceName: "product",
        apiBaseUrl: "http://127.0.0.1:6060",
        sessionName: "raw-session",
      }),
    ).toThrow("invalid or incompatible");
  });
});
