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
