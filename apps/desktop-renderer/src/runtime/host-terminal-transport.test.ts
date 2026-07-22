import { describe, expect, it, vi } from "vitest";
import type { DaemonInstanceIdentity, HostCapabilities } from "@tmux-ide/contracts";
import type { NativeTerminalWebSocketTransportDependencies } from "../terminal/native-terminal-websocket-transport.ts";

const nativeFactory = vi.hoisted(() =>
  vi.fn((_dependencies: NativeTerminalWebSocketTransportDependencies) => ({ connect: vi.fn() })),
);

vi.mock("../terminal/native-terminal-websocket-transport.ts", () => ({
  createNativeTerminalWebSocketTransport: nativeFactory,
}));

import { createHostNativeTerminalTransport } from "./host-terminal-transport.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-22T00:00:00.000Z",
};

const REQUEST = {
  protocolVersion: 1 as const,
  target: { workspaceName: "alpha", semanticPaneId: "pane.shell" },
  viewerMode: "interactive" as const,
  viewport: { cols: 80, rows: 24 },
};

function hostWithDescriptor(daemonInstanceId = DAEMON.instanceId) {
  const issueTerminalAttachment = vi.fn(async () => ({
    status: "issued" as const,
    descriptor: {
      protocolVersion: 1 as const,
      webSocketUrl: "ws://127.0.0.1:6070/v1/terminal/attachments/redeem",
      subprotocol: "tmux-ide-terminal.v1" as const,
      redemptionTicket: `ta1_${"a".repeat(43)}`,
      daemonInstanceId,
      requestId: "2a215cf2-547e-42a2-91c7-454df8e56121",
      expiresAt: Date.now() + 15_000,
      effectiveViewerMode: "interactive" as const,
    },
  }));
  return {
    host: { daemon: { issueTerminalAttachment } } as unknown as Pick<HostCapabilities, "daemon">,
    issueTerminalAttachment,
  };
}

describe("HostCapabilities-backed native terminal transport", () => {
  it("delegates semantic issuance to the reviewed host and unwraps the descriptor", async () => {
    const { host, issueTerminalAttachment } = hostWithDescriptor();
    createHostNativeTerminalTransport(host, DAEMON);
    const dependencies = nativeFactory.mock.calls.at(-1)?.[0];
    if (!dependencies) throw new Error("Expected native transport dependencies.");

    await expect(dependencies.issueAttachment(REQUEST)).resolves.toMatchObject({
      daemonInstanceId: DAEMON.instanceId,
      requestId: "2a215cf2-547e-42a2-91c7-454df8e56121",
    });
    expect(issueTerminalAttachment).toHaveBeenCalledWith(REQUEST);
    expect(JSON.stringify(issueTerminalAttachment.mock.calls)).not.toMatch(
      /tmuxPaneId|sessionName|authorization/iu,
    );
  });

  it("rejects host errors and descriptors from another daemon generation", async () => {
    const mismatch = hostWithDescriptor("66ab67ed-18fe-431b-913b-70972b78c96f");
    createHostNativeTerminalTransport(mismatch.host, DAEMON);
    const mismatchDependencies = nativeFactory.mock.calls.at(-1)?.[0];
    if (!mismatchDependencies) throw new Error("Expected mismatch transport dependencies.");
    await expect(mismatchDependencies.issueAttachment(REQUEST)).rejects.toThrow(
      "another daemon generation",
    );

    const host = {
      daemon: {
        issueTerminalAttachment: vi.fn(async () => ({
          status: "error" as const,
          error: {
            code: "daemon-unavailable" as const,
            reason: "The daemon is unavailable.",
            retryable: true,
          },
        })),
      },
    } as unknown as Pick<HostCapabilities, "daemon">;
    createHostNativeTerminalTransport(host, DAEMON);
    const errorDependencies = nativeFactory.mock.calls.at(-1)?.[0];
    if (!errorDependencies) throw new Error("Expected error transport dependencies.");
    await expect(errorDependencies.issueAttachment(REQUEST)).rejects.toThrow(
      "daemon is unavailable",
    );
  });
});
