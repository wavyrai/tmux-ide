import WebSocket from "ws";
import type { PaneStreamClientSocket } from "@tmux-ide/daemon-client/pane-stream-client";

type PaneStreamSocketConstructor = new (...args: unknown[]) => PaneStreamClientSocket;

export interface OpenTuiPaneStreamSocketDependencies {
  readonly bunRuntime?: boolean;
  readonly bunWebSocket?: PaneStreamSocketConstructor;
  readonly nodeWebSocket?: PaneStreamSocketConstructor;
}

/**
 * Construct a pane-stream socket without losing the trusted host headers.
 * Bun and Node's `ws` intentionally use different constructor shapes.
 */
export function createOpenTuiPaneStreamSocket(
  descriptor: { readonly webSocketUrl: string; readonly subprotocol: string },
  headers: Readonly<Record<string, string>>,
  dependencies: OpenTuiPaneStreamSocketDependencies = {},
): PaneStreamClientSocket {
  const bunRuntime = dependencies.bunRuntime ?? typeof process.versions.bun === "string";
  if (bunRuntime) {
    const BunWebSocket = dependencies.bunWebSocket ?? globalThis.WebSocket;
    if (typeof BunWebSocket !== "function") {
      throw new Error("Bun pane-stream runtime requires the native global WebSocket client");
    }
    const Socket = BunWebSocket as unknown as PaneStreamSocketConstructor;
    return new Socket(descriptor.webSocketUrl, {
      protocols: [descriptor.subprotocol],
      headers: {
        Origin: headers.Origin!,
        "X-Tmux-Ide-Host-Client-Id": headers["X-Tmux-Ide-Host-Client-Id"]!,
      },
    });
  }
  const NodeWebSocket =
    dependencies.nodeWebSocket ?? (WebSocket as unknown as PaneStreamSocketConstructor);
  return new NodeWebSocket(descriptor.webSocketUrl, descriptor.subprotocol, {
    origin: headers.Origin,
    headers: { "X-Tmux-Ide-Host-Client-Id": headers["X-Tmux-Ide-Host-Client-Id"]! },
    perMessageDeflate: false,
  });
}
