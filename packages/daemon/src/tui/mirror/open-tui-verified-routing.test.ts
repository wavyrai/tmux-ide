import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import type {
  OpenPaneStreamClientOptions,
  PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";

import { createOpenTuiVerifiedRoutingContext } from "./open-tui-verified-routing.ts";

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

describe("OpenTUI verified routing capability", () => {
  it.each([
    ["daemon", { daemonInstanceId: "22222222-2222-4222-8222-222222222222" }],
    ["workspace", { workspaceName: "workspace.beta" }],
    ["session", { sessionName: "beta" }],
  ])("fails closed for a mismatched %s identity", (_label, mismatch) => {
    const context = createOpenTuiVerifiedRoutingContext(
      daemon,
      "workspace.alpha",
      "alpha",
      vi.fn(async () => ({}) as PaneStreamRuntimeClient),
    )!;
    expect(() =>
      context.assertCurrent({
        daemonInstanceId: daemon.instanceId,
        workspaceName: "workspace.alpha",
        sessionName: "alpha",
        ...mismatch,
      }),
    ).toThrow(/another/u);
  });

  it("retires the capability without exposing its bearer token", () => {
    const context = createOpenTuiVerifiedRoutingContext(
      daemon,
      "workspace.alpha",
      "alpha",
      vi.fn(async () => ({}) as PaneStreamRuntimeClient),
    )!;
    expect(Object.keys(context)).not.toContain("ownerToken");
    expect(JSON.stringify(context)).not.toContain("owner-secret");
    context.retire();
    expect(() =>
      context.assertCurrent({
        daemonInstanceId: daemon.instanceId,
        workspaceName: "workspace.alpha",
        sessionName: "alpha",
      }),
    ).toThrow("has been retired");
  });

  it("rejects a pane-stream request that escapes the verified workspace", async () => {
    const open = vi.fn(
      async (_options: OpenPaneStreamClientOptions) => ({}) as PaneStreamRuntimeClient,
    );
    const context = createOpenTuiVerifiedRoutingContext(daemon, "workspace.alpha", "alpha", open)!;
    await expect(
      context.openPaneStream(
        {
          daemonInstanceId: daemon.instanceId,
          workspaceName: "workspace.alpha",
          sessionName: "alpha",
        },
        {
          origin: "tmux-ide://opentui",
          hostClientId: "opentui:test",
          requestId: "request",
          stream: {
            protocolVersion: 1,
            workspaceName: "workspace.beta",
            panes: ["pane.editor"],
            viewerMode: "interactive",
            terminalDelivery: {
              protocolVersions: [1],
              encodings: ["semantic-v1"],
              richPlacements: true,
            },
          },
          createSocket: vi.fn(),
          onNegotiated: vi.fn(),
          onTerminalDelivery: vi.fn(),
        },
      ),
    ).rejects.toThrow("escaped its verified workspace route");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("SSH pane-stream endpoint authority", () => {
  function fixture() {
    const remote = { ...daemon, port: 7070 };
    let endpoint: import("./runtime/application-daemon-authority.ts").ApplicationDaemonEndpoint = {
      kind: "ssh",
      label: "test",
      remote,
      localBaseUrl: "http://127.0.0.1:6060",
      epoch: 4,
      state: "ready",
    };
    let captured!: OpenPaneStreamClientOptions;
    const open = vi.fn(async (options: OpenPaneStreamClientOptions) => {
      captured = options;
      return {} as PaneStreamRuntimeClient;
    });
    const context = createOpenTuiVerifiedRoutingContext(
      daemon,
      "workspace.alpha",
      "alpha",
      open,
      () => endpoint,
    )!;
    const socket = vi.fn();
    const options = {
      origin: "tmux-ide://opentui",
      hostClientId: "client",
      requestId: "request",
      stream: {
        protocolVersion: 1,
        workspaceName: "workspace.alpha",
        panes: ["pane.editor"],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: true,
        },
      },
      createSocket: socket,
      onNegotiated: vi.fn(),
      onTerminalDelivery: vi.fn(),
    } satisfies Parameters<typeof context.openPaneStream>[1];
    const connect = (url: string) =>
      captured.createSocket(
        {
          webSocketUrl: url,
          subprotocol: "tmux-test",
          requestId: "request",
        } as Parameters<typeof captured.createSocket>[0],
        { Origin: "tmux-ide://opentui" },
      );
    return {
      context,
      socket,
      options,
      connect,
      retire: () => {
        endpoint = { ...endpoint, epoch: 5 };
      },
    };
  }

  it("rewrites only the verified original daemon origin, preserving path, query and protocol", async () => {
    const f = fixture();
    await f.context.openPaneStream(f.context, f.options);
    f.connect("ws://127.0.0.1:7070/ws/panes?ticket=a%2Fb&revision=3");
    expect(f.socket).toHaveBeenCalledWith(
      expect.objectContaining({
        webSocketUrl: "ws://127.0.0.1:6060/ws/panes?ticket=a%2Fb&revision=3",
        subprotocol: "tmux-test",
      }),
      { Origin: "tmux-ide://opentui" },
    );
  });

  it.each([
    "ws://attacker.invalid:7070/ws/panes",
    "ws://127.0.0.1:6060/ws/panes",
    "wss://127.0.0.1:7070/ws/panes",
    "ws://user:secret@127.0.0.1:7070/ws/panes",
    "ws://127.0.0.1:7070/ws/panes#fragment",
  ])("rejects an untrusted issued endpoint before opening a socket: %s", async (url) => {
    const f = fixture();
    await f.context.openPaneStream(f.context, f.options);
    expect(() => f.connect(url)).toThrow(/verified SSH daemon origin/u);
    expect(f.socket).not.toHaveBeenCalled();
  });

  it("fences late issuance after reconnection even with the same pane and daemon IDs", async () => {
    const f = fixture();
    await f.context.openPaneStream(f.context, f.options);
    f.retire();
    expect(() => f.connect("ws://127.0.0.1:7070/ws/panes")).toThrow(/connection has been retired/u);
    await expect(f.context.openPaneStream(f.context, f.options)).rejects.toThrow(
      /connection has been retired/u,
    );
    expect(f.socket).not.toHaveBeenCalled();
  });
});
