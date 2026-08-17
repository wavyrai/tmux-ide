import {
  TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION,
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  type TerminalRuntimeInventoryProjectionV1,
  type TerminalRuntimeInventoryResourceV1,
  type DaemonInstanceIdentity,
} from "@tmux-ide/contracts";

import type { NativeTerminalRuntimeSessionSnapshot } from "../../terminal/attachments/native-runtime.ts";
import { projectApplicationShellResource } from "./application-shell.ts";

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
