import { render } from "solid-js/web";

import type {
  NativeTerminalAttachment,
  NativeTerminalTransport,
} from "./native-terminal-transport.ts";
import { TerminalSurface } from "./terminal-surface.tsx";

const attachment: NativeTerminalAttachment = {
  write: async () => ({ status: "ok" }),
  resize: async () => ({ status: "ok" }),
  dispose: () => undefined,
};

const transport: NativeTerminalTransport = {
  async connect(request, listener) {
    setTimeout(() => {
      void listener({
        type: "state",
        state: "connected",
        error: null,
        sourceGrid: request.viewport,
        clientViewport: request.viewport,
      });
      void listener({
        type: "output",
        bytes: new TextEncoder().encode("\u001b[32mCSP terminal ready\u001b[0m\r\n"),
      });
    }, 0);
    return { status: "connected", attachment };
  },
};

/** Real xterm/transport smoke fixture; never mounted by the product shell. */
export function mountTerminalSurfaceSmokeFixture(root: HTMLElement): () => void {
  root.className = "tmi-terminal-smoke-fixture";
  return render(
    () => (
      <TerminalSurface
        target={{ workspaceName: "csp-smoke", semanticPaneId: "terminal.csp-smoke" }}
        title="Strict CSP smoke"
        transport={transport}
        focused
      />
    ),
    root,
  );
}
