import { describe, expect, it } from "vitest";

import type { PaneStreamClientSocket } from "@tmux-ide/daemon-client/pane-stream-client";

import { createOpenTuiPaneStreamSocket } from "./application-shell-daemon-runtime.ts";

const descriptor = {
  webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/pane-streams/redeem",
  subprotocol: "tmux-ide-pane-stream.v1",
};
const headers = {
  Origin: "tmux-ide://opentui",
  "X-Tmux-Ide-Host-Client-Id": "opentui:42",
};

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
