import {
  WorkspaceCatalogResourceV2SchemaZ,
  WorkspaceCatalogResourceV3SchemaZ,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV2,
  type WorkspaceCatalogResourceV3,
} from "@tmux-ide/contracts";

import { canonicalDaemonUrl } from "../../lib/canonical-daemon.ts";

const WORKSPACE_CATALOG_ATTEMPTS = 3;
const WORKSPACE_CATALOG_ATTEMPT_TIMEOUT_MS = 1_000;

function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

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
  signal?: AbortSignal,
): Promise<WorkspaceCatalogResourceV2> {
  return WorkspaceCatalogResourceV2SchemaZ.parse(
    await fetchCanonicalCatalog(daemon, 2, request, signal),
  );
}

/** One catalog read binds new connections to the observed live incarnation. */
export async function fetchCanonicalLiveWorkspaceRouting(
  daemon: CanonicalDaemonInfo,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WorkspaceCatalogResourceV3> {
  return WorkspaceCatalogResourceV3SchemaZ.parse(
    await fetchCanonicalCatalog(daemon, 3, request, signal),
  );
}

async function fetchCanonicalCatalog(
  daemon: CanonicalDaemonInfo,
  version: 2 | 3,
  request: typeof fetch,
  signal?: AbortSignal,
): Promise<WorkspaceCatalogResourceV2 | WorkspaceCatalogResourceV3> {
  const baseUrl = canonicalDaemonUrl("http", daemon.bindHostname, daemon.port);
  let response: Response | null = null;
  for (let attempt = 0; attempt < WORKSPACE_CATALOG_ATTEMPTS; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(WORKSPACE_CATALOG_ATTEMPT_TIMEOUT_MS);
      response = await request(`${baseUrl}/api/resources/workspace-catalog?version=${version}`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        cache: "no-store",
      });
      break;
    } catch (error) {
      if (signal?.aborted || !isTimeout(error) || attempt === WORKSPACE_CATALOG_ATTEMPTS - 1)
        throw error;
    }
  }
  if (!response) throw new Error("workspace catalog did not return a response");
  if (!response.ok) throw new Error(`workspace catalog returned HTTP ${response.status}`);

  const catalog =
    version === 3
      ? WorkspaceCatalogResourceV3SchemaZ.parse(await response.json())
      : WorkspaceCatalogResourceV2SchemaZ.parse(await response.json());
  if (catalog.daemon.instanceId !== daemon.instanceId) {
    throw new Error("daemon generation changed while resolving the workspace");
  }
  return catalog;
}

export function workspaceNameForLiveSession(
  catalog: WorkspaceCatalogResourceV2 | WorkspaceCatalogResourceV3,
  sessionName: string,
): string | null {
  return (
    catalog.intents.find(
      (workspace) => workspace.sessionName === sessionName && workspace.availability === "live",
    )?.workspaceName ?? null
  );
}
