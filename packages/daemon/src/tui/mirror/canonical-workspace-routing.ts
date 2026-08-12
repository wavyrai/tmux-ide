import {
  WorkspaceCatalogResourceV2SchemaZ,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV2,
} from "@tmux-ide/contracts";

import { canonicalDaemonUrl } from "../../lib/canonical-daemon.ts";

/**
 * Read the generation-stamped workspace catalog used by trusted TUI adapters.
 *
 * Keeping this lookup shared prevents each TUI mutation flow from inventing a
 * different session-name → workspace-identity rule. Runtime session names are
 * only routing hints; daemon-owned actions always receive the stable workspace
 * name from this catalog.
 */
export async function fetchCanonicalWorkspaceRouting(
  daemon: CanonicalDaemonInfo,
  request: typeof fetch = fetch,
): Promise<WorkspaceCatalogResourceV2> {
  const baseUrl = canonicalDaemonUrl("http", daemon.bindHostname, daemon.port);
  const response = await request(`${baseUrl}/api/resources/workspace-catalog?version=2`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`workspace catalog returned HTTP ${response.status}`);

  const catalog = WorkspaceCatalogResourceV2SchemaZ.parse(await response.json());
  if (catalog.daemon.instanceId !== daemon.instanceId) {
    throw new Error("daemon generation changed while resolving the workspace");
  }
  return catalog;
}

export function workspaceNameForLiveSession(
  catalog: WorkspaceCatalogResourceV2,
  sessionName: string,
): string | null {
  return (
    catalog.intents.find(
      (workspace) => workspace.sessionName === sessionName && workspace.availability === "live",
    )?.workspaceName ?? null
  );
}
