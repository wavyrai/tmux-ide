import { describe, expect, it } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  type PaneStreamLeaseRequest,
  type TerminalAttachRequest,
} from "@tmux-ide/contracts";
import {
  AttachmentLeaseManager,
  type AttachmentViewExecutor,
} from "./attachments/lease-manager.ts";
import { SemanticPaneCatalog } from "./attachments/semantic-pane-catalog.ts";
import { TerminalInputAuthority } from "./input-authority.ts";
import { PaneStreamLeaseManager } from "./pane-stream/lease-manager.ts";

const DAEMON = "daemon-generation-a";
const PROJECT = "workspace.alpha";

function uuid(index: number): string {
  return `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const rows = [
  {
    workspaceName: PROJECT,
    semanticPaneId: "pane.left",
    sessionId: "$1",
    windowId: "@1",
    runtimePaneId: "%1",
    windowStamp: "window.shared",
    windowPaneCount: 2,
    sessionWindowCount: 2,
  },
  {
    workspaceName: PROJECT,
    semanticPaneId: "pane.right",
    sessionId: "$1",
    windowId: "@1",
    runtimePaneId: "%2",
    windowStamp: "window.shared",
    windowPaneCount: 2,
    sessionWindowCount: 2,
  },
  {
    workspaceName: PROJECT,
    semanticPaneId: "pane.other-window",
    sessionId: "$1",
    windowId: "@2",
    runtimePaneId: "%3",
    windowStamp: "window.other",
    windowPaneCount: 1,
    sessionWindowCount: 2,
  },
];

const viewExecutor: AttachmentViewExecutor = {
  guardedCleanup: async () => "absent",
  executeGuardedViewOperation: async () => "executed",
  enumerateMarkedViews: async () => [],
};

function attachRequest(
  semanticPaneId: string,
  viewerMode: "interactive" | "read-only" = "interactive",
): TerminalAttachRequest {
  return {
    protocolVersion: 1,
    target: { workspaceName: PROJECT, semanticPaneId },
    viewerMode,
    viewport: { cols: 100, rows: 30 },
  };
}

function streamRequest(
  panes: readonly string[],
  viewerMode: "interactive" | "read-only" = "interactive",
): PaneStreamLeaseRequest {
  return {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    workspaceName: PROJECT,
    panes: [...panes],
    viewerMode,
  };
}

function world() {
  let nextId = 1;
  const authority = new TerminalInputAuthority();
  const catalog = new SemanticPaneCatalog({ discover: () => rows });
  const attachments = new AttachmentLeaseManager({
    daemonInstanceId: DAEMON,
    catalog,
    viewExecutor,
    inputAuthority: authority,
    createId: () => uuid(nextId++),
    randomBytes: (size) => new Uint8Array(size).fill(nextId),
  });
  const streams = new PaneStreamLeaseManager({
    daemonInstanceId: DAEMON,
    inputAuthority: authority,
    semanticPaneCatalog: catalog,
    createId: () => uuid(nextId++),
    randomBytes: (size) => new Uint8Array(size).fill(nextId),
  });
  return { attachments, streams, authority };
}

function attachmentContext(index: number) {
  return { requestId: uuid(100 + index), projectIdentity: PROJECT };
}

function attachmentBinding(requestId: string) {
  return { daemonInstanceId: DAEMON, requestId, projectIdentity: PROJECT };
}

function streamContext(index: number) {
  return { requestId: uuid(200 + index), projectIdentity: PROJECT, sessionName: "alpha" };
}

function streamBinding(requestId: string) {
  return { daemonInstanceId: DAEMON, requestId, projectIdentity: PROJECT };
}

describe("unified terminal input authority", () => {
  it("rejects a pane stream for a sibling pane in an attachment-owned window", async () => {
    const { attachments, streams } = world();
    const attachment = await attachments.issue(attachRequest("pane.left"), attachmentContext(1));

    await expect(
      streams.issue(streamRequest(["pane.right"]), streamContext(1)),
    ).rejects.toMatchObject({ code: "interactive-viewer-conflict" });

    // Passive secondary clients remain available while the window is owned.
    await expect(
      streams.issue(streamRequest(["pane.right"], "read-only"), streamContext(2)),
    ).resolves.toMatchObject({ descriptor: { viewerMode: "read-only" } });

    // A different live tmux window can be controlled concurrently.
    await expect(
      streams.issue(streamRequest(["pane.other-window"]), streamContext(3)),
    ).resolves.toMatchObject({ descriptor: { viewerMode: "interactive" } });

    await attachments.release(
      attachment.descriptor.leaseId,
      attachmentBinding(attachment.descriptor.requestId),
    );
    await expect(
      streams.issue(streamRequest(["pane.right"]), streamContext(4)),
    ).resolves.toMatchObject({ descriptor: { viewerMode: "interactive" } });
  });

  it("rejects an attachment for a sibling pane in a pane-stream-owned window", async () => {
    const { attachments, streams } = world();
    const stream = await streams.issue(streamRequest(["pane.left"]), streamContext(1));

    await expect(
      attachments.issue(attachRequest("pane.right"), attachmentContext(1)),
    ).rejects.toMatchObject({ code: "interactive-viewer-conflict" });

    await streams.release(stream.descriptor.leaseId, streamBinding(stream.descriptor.requestId));
    await expect(
      attachments.issue(attachRequest("pane.right"), attachmentContext(2)),
    ).resolves.toMatchObject({ descriptor: { viewerMode: "interactive" } });
  });

  it("retains control during attachment disconnect grace and frees it on release", async () => {
    const { attachments, streams, authority } = world();
    const issued = await attachments.issue(attachRequest("pane.left"), attachmentContext(1));
    const binding = attachmentBinding(issued.descriptor.requestId);
    await attachments.redeem(issued.redemptionTicket, binding);
    await attachments.disconnect(issued.descriptor.leaseId, binding);

    await expect(
      streams.issue(streamRequest(["pane.right"]), streamContext(1)),
    ).rejects.toMatchObject({ code: "interactive-viewer-conflict" });
    expect(authority.snapshot().owners).toHaveLength(1);

    await attachments.release(issued.descriptor.leaseId, binding);
    await expect(
      streams.issue(streamRequest(["pane.right"]), streamContext(2)),
    ).resolves.toMatchObject({ descriptor: { viewerMode: "interactive" } });
  });
});
