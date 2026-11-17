import {
  TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION,
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  TerminalRuntimeInventoryProjectionV2SchemaZ,
  type TerminalRuntimeInventoryProjectionV1,
  type TerminalRuntimeInventoryProjectionV2,
  type TerminalRuntimeInventoryResourceV1,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";

import type { NativeTerminalRuntimeSessionSnapshot } from "../../terminal/attachments/native-runtime.ts";
import { paneIdentities, projectApplicationShellResource } from "./application-shell.ts";

/** Pure, wire-safe agent-free topology projection. */
export function projectTerminalRuntimeInventory(
  session: NativeTerminalRuntimeSessionSnapshot,
  resourceRevision: number,
): TerminalRuntimeInventoryProjectionV1 {
  const shell = projectApplicationShellResource(session);
  return TerminalRuntimeInventoryProjectionV1SchemaZ.parse({
    workspaceName: session.workspaceName,
    workspaceId: shell.workspace.id,
    sessionId: shell.workspace.session.id,
    resourceRevision,
    semanticPaneIds: [
      ...new Set(
        shell.terminalInventory.resources.flatMap((resource) =>
          resource.attachability.status === "available"
            ? [resource.attachability.semanticPaneId]
            : [],
        ),
      ),
    ].sort(),
  });
}

/**
 * #806: version 1 plus each window and its panes, in tmux order. A window is
 * named only when it has a verified window stamp and every pane in it is
 * available, so its pane set is one a window-scoped issue can accept.
 */
export function projectTerminalRuntimeInventoryV2(
  session: NativeTerminalRuntimeSessionSnapshot,
  resourceRevision: number,
): TerminalRuntimeInventoryProjectionV2 {
  const identities = paneIdentities(session);
  const windows = new Map<
    string,
    { semanticWindowId: string | null; active: boolean; panes: string[]; complete: boolean }
  >();
  session.panes.forEach((pane, index) => {
    if (pane.windowId === undefined) return;
    const stamp = pane.windowStamp ?? null;
    const entry = windows.get(pane.windowId) ?? {
      semanticWindowId: stamp,
      active: false,
      panes: [] as string[],
      complete: true,
    };
    windows.set(pane.windowId, entry);
    const attachability = identities[index]!.attachability;
    if (attachability.status === "available") entry.panes.push(attachability.semanticPaneId);
    else entry.complete = false;
    if (pane.active) entry.active = true;
  });
  return TerminalRuntimeInventoryProjectionV2SchemaZ.parse({
    ...projectTerminalRuntimeInventory(session, resourceRevision),
    windows: [...windows.values()].flatMap((window) =>
      window.complete && window.semanticWindowId !== null && window.panes.length > 0
        ? [
            {
              semanticWindowId: window.semanticWindowId,
              active: window.active,
              semanticPaneIds: [...window.panes].sort(),
            },
          ]
        : [],
    ),
  });
}

export function terminalRuntimeInventoryEnvelope(
  daemon: DaemonInstanceIdentity,
  session: NativeTerminalRuntimeSessionSnapshot,
  resourceRevision: number,
): TerminalRuntimeInventoryResourceV1 {
  return {
    version: TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION,
    daemon,
    resource: projectTerminalRuntimeInventory(session, resourceRevision),
  };
}
