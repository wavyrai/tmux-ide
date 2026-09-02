import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { openPaneStreamRuntimeClient } from "@tmux-ide/daemon-client/pane-stream-client";
import type { PaneStreamServerFrame } from "@tmux-ide/contracts";

import { createOpenTuiPaneStreamSocket } from "../packages/daemon/src/tui/mirror/open-tui-pane-stream-socket.ts";

const workspaceName = required("TMUX_IDE_REFERENCE_WORKSPACE");
const semanticPaneId = required("TMUX_IDE_REFERENCE_PANE");
const daemon = JSON.parse(
  readFileSync(join(process.env.HOME ?? "", ".tmux-ide", "daemon.json"), "utf8"),
) as {
  bindHostname: string;
  port: number;
  authToken: string;
  instanceId: string;
};

let resolveLayout!: (frame: Extract<PaneStreamServerFrame, { type: "layout" }>) => void;
let resolveNegotiation!: (value: { accepted: boolean }) => void;
const layout = new Promise<Extract<PaneStreamServerFrame, { type: "layout" }>>((resolve) => {
  resolveLayout = resolve;
});
const negotiation = new Promise<{ accepted: boolean }>((resolve) => {
  resolveNegotiation = resolve;
});
const client = await openPaneStreamRuntimeClient({
  baseUrl: `http://${daemon.bindHostname}:${daemon.port}`,
  ownerToken: daemon.authToken,
  daemonInstanceId: daemon.instanceId,
  origin: "tmux-ide://opentui",
  hostClientId: `reference-bun:${process.pid}`,
  requestId: randomUUID(),
  stream: {
    protocolVersion: 1,
    workspaceName,
    panes: [semanticPaneId],
    viewerMode: "read-only",
    terminalDelivery: {
      protocolVersions: [1],
      encodings: ["semantic-v1"],
      richPlacements: true,
    },
  },
  createSocket: createOpenTuiPaneStreamSocket,
  onNegotiated: (_pane, result) => resolveNegotiation(result),
  onTerminalDelivery: () => undefined,
  onLayout: resolveLayout,
});
try {
  const [layoutFrame, negotiated] = await Promise.race([
    Promise.all([layout, negotiation]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Bun pane-stream live preflight timed out")), 2_000),
    ),
  ]);
  if (!negotiated.accepted) throw new Error("Bun pane-stream terminal delivery was rejected");
  if (!layoutFrame.panes.some(({ pane }) => pane === semanticPaneId)) {
    throw new Error("Bun pane-stream layout omitted the requested semantic pane");
  }
  process.stdout.write(
    `${JSON.stringify({ status: "passed", workspaceName, semanticPaneId, paneCount: layoutFrame.panes.length })}\n`,
  );
} finally {
  client.close();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
