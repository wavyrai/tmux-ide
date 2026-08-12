import { describe, expect, it, vi } from "vitest";

import type {
  OpenPaneStreamClientOptions,
  PaneStreamClientSocket,
  PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";
import type { CanonicalDaemonInfo, WorkspaceCatalogResourceV1 } from "@tmux-ide/contracts";

import {
  connectOpenTuiSessionRuntime,
  createOpenTuiPaneStreamSocket,
} from "./application-shell-daemon-runtime.ts";
import { createOpenTuiVerifiedRoutingContext } from "./open-tui-verified-routing.ts";

const descriptor = {
  webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
  subprotocol: "tmux-ide-pane-stream.v1",
};
const headers = {
  Origin: "tmux-ide://opentui",
  "X-Tmux-Ide-Host-Client-Id": "opentui:42",
};

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

function runtimeClient(): PaneStreamRuntimeClient {
  return {
    daemonInstanceId: daemon.instanceId,
    requestId: "request",
    effectiveViewerMode: "interactive",
    sendText: vi.fn(),
    sendKey: vi.fn(),
    fitViewport: vi.fn(async () => undefined),
    ack: vi.fn(),
    nack: vi.fn(),
    setVisibility: vi.fn(),
    submitIntent: vi.fn(async () => null),
    close: vi.fn(),
  };
}

function runtimeOptions() {
  return {
    sessionName: "alpha",
    semanticPaneIds: ["pane.editor"],
    onPaneChange: vi.fn(),
  };
}

function socketConstructor(record: unknown[][]) {
  return class {
    constructor(...args: unknown[]) {
      record.push(args);
    }
  } as unknown as new (...args: unknown[]) => PaneStreamClientSocket;
}

describe("OpenTUI pane-stream socket construction", () => {
  it("uses Bun's native protocols-and-headers options so admission identity is not dropped", () => {
    const calls: unknown[][] = [];
    createOpenTuiPaneStreamSocket(descriptor, headers, {
      bunRuntime: true,
      bunWebSocket: socketConstructor(calls),
    });
    expect(calls).toEqual([
      [
        descriptor.webSocketUrl,
        {
          protocols: [descriptor.subprotocol],
          headers,
        },
      ],
    ]);
  });

  it("retains the Node ws constructor contract outside Bun", () => {
    const calls: unknown[][] = [];
    createOpenTuiPaneStreamSocket(descriptor, headers, {
      bunRuntime: false,
      nodeWebSocket: socketConstructor(calls),
    });
    expect(calls).toEqual([
      [
        descriptor.webSocketUrl,
        descriptor.subprotocol,
        {
          origin: headers.Origin,
          headers: {
            "X-Tmux-Ide-Host-Client-Id": headers["X-Tmux-Ide-Host-Client-Id"],
          },
          perMessageDeflate: false,
        },
      ],
    ]);
  });

  it("fails explicitly when a Bun host has no native WebSocket client", () => {
    const original = globalThis.WebSocket;
    try {
      Reflect.deleteProperty(globalThis, "WebSocket");
      expect(() =>
        createOpenTuiPaneStreamSocket(descriptor, headers, { bunRuntime: true }),
      ).toThrow("requires the native global WebSocket client");
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("OpenTUI pane-stream startup routing", () => {
  it("reuses established authority without another health or catalog lookup", async () => {
    const client = runtimeClient();
    const open = vi.fn(async (_options: OpenPaneStreamClientOptions) => client);
    const routing = createOpenTuiVerifiedRoutingContext(daemon, "workspace.alpha", "alpha", open)!;
    const readCanonicalDaemonInfo = vi.fn(() => daemon);
    const isCanonicalDaemonAlive = vi.fn(async () => true);
    const fetchCanonicalWorkspaceCatalog = vi.fn(async () => catalog);

    const lane = await connectOpenTuiSessionRuntime(
      { ...runtimeOptions(), routing },
      { readCanonicalDaemonInfo, isCanonicalDaemonAlive, fetchCanonicalWorkspaceCatalog },
    );

    expect(lane).toMatchObject({
      daemonInstanceId: daemon.instanceId,
      workspaceName: "workspace.alpha",
      viewerMode: "interactive",
    });
    expect(readCanonicalDaemonInfo).not.toHaveBeenCalled();
    expect(isCanonicalDaemonAlive).not.toHaveBeenCalled();
    expect(fetchCanonicalWorkspaceCatalog).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0]).toMatchObject({
      daemonInstanceId: daemon.instanceId,
      ownerToken: "owner-secret",
      stream: { workspaceName: "workspace.alpha" },
    });
  });

  it("retains canonical health and catalog discovery without established authority", async () => {
    const client = runtimeClient();
    const open = vi.fn(async (_options: OpenPaneStreamClientOptions) => client);
    const readCanonicalDaemonInfo = vi.fn(() => daemon);
    const isCanonicalDaemonAlive = vi.fn(async () => true);
    const fetchCanonicalWorkspaceCatalog = vi.fn(async () => catalog);
    const createRoutingContext = vi.fn(
      (candidate: CanonicalDaemonInfo, workspaceName: string, sessionName: string) =>
        createOpenTuiVerifiedRoutingContext(candidate, workspaceName, sessionName, open),
    );

    const lane = await connectOpenTuiSessionRuntime(runtimeOptions(), {
      readCanonicalDaemonInfo,
      isCanonicalDaemonAlive,
      fetchCanonicalWorkspaceCatalog,
      createRoutingContext,
    });

    expect(lane?.workspaceName).toBe("workspace.alpha");
    expect(readCanonicalDaemonInfo).toHaveBeenCalledOnce();
    expect(isCanonicalDaemonAlive).toHaveBeenCalledOnce();
    expect(fetchCanonicalWorkspaceCatalog).toHaveBeenCalledOnce();
    expect(createRoutingContext).toHaveBeenCalledWith(daemon, "workspace.alpha", "alpha");
    expect(open).toHaveBeenCalledOnce();
  });

  it("fails closed when the accepted authority is stale or belongs to another session", async () => {
    const open = vi.fn(async (_options: OpenPaneStreamClientOptions) => runtimeClient());
    const mismatched = createOpenTuiVerifiedRoutingContext(
      daemon,
      "workspace.alpha",
      "alpha",
      open,
    )!;
    await expect(
      connectOpenTuiSessionRuntime({
        ...runtimeOptions(),
        sessionName: "beta",
        routing: mismatched,
      }),
    ).rejects.toThrow("another tmux session");

    const stale = createOpenTuiVerifiedRoutingContext(daemon, "workspace.alpha", "alpha", open)!;
    stale.retire();
    await expect(
      connectOpenTuiSessionRuntime({ ...runtimeOptions(), routing: stale }),
    ).rejects.toThrow("has been retired");
    expect(open).not.toHaveBeenCalled();
  });
});
