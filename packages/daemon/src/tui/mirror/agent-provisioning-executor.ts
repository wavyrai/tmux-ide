import { randomUUID } from "node:crypto";

import {
  type CanonicalDaemonInfo,
  type WorkspacePaneCreateArguments,
  type WorkspacePaneCreateMutationResult,
  type WorkspacePaneCreatedResource,
} from "@tmux-ide/contracts";
import { DaemonActionInvocationError } from "@tmux-ide/daemon-client/owner-action-client";
import { createWorkspacePaneAsOwner } from "@tmux-ide/daemon-client/workspace-pane-client";
import { provisioningPlacementForTarget } from "@tmux-ide/core";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import { CUSTOM_KIND_ID, type SpawnWhere } from "./agent-lifecycle.ts";
import {
  fetchCanonicalWorkspaceCatalog,
  workspaceNameForSession,
} from "./canonical-workspace-routing.ts";

export interface TuiAgentProvisioningRequest {
  readonly sessionName: string | null;
  readonly kind: string;
  readonly command: string;
  readonly displayTitle: string;
  readonly placement: SpawnWhere;
  readonly targetSemanticPaneId: string | null;
}

export type TuiAgentProvisioningResult =
  | {
      readonly status: "daemon";
      readonly resource: WorkspacePaneCreatedResource;
      readonly message: string;
    }
  | {
      /** This flow is still intentionally standalone (no daemon or fresh/custom launch). */
      readonly status: "legacy-local";
      readonly reason: "no-daemon" | "unsupported-placement" | "custom-command";
    }
  | { readonly status: "error"; readonly message: string };

interface TuiAgentProvisioningDeps {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (info: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetch: typeof fetch;
  readonly createWorkspacePane: (
    daemon: CanonicalDaemonInfo,
    intent: WorkspacePaneCreateArguments,
    options: { operationId: string; autostart: false },
  ) => Promise<WorkspacePaneCreateMutationResult | null>;
  readonly operationId: () => string;
}

const DEFAULT_DEPS: TuiAgentProvisioningDeps = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetch,
  createWorkspacePane: (daemon, intent, options) =>
    createWorkspacePaneAsOwner({
      baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
      ownerToken: daemon.authToken ?? "",
      intent,
      operationId: options.operationId,
    }),
  operationId: randomUUID,
};

/**
 * Provision an agent through the same semantic daemon action used by the GUI.
 *
 * A live canonical daemon is an authority boundary: lookup, authorization, or
 * transport failures fail closed and are never retried through raw tmux. The
 * only local cases are standalone operation and intent shapes that cannot yet
 * express fresh-session/custom-command launches.
 */
export async function executeTuiAgentProvisioning(
  request: TuiAgentProvisioningRequest,
  overrides: Partial<TuiAgentProvisioningDeps> = {},
): Promise<TuiAgentProvisioningResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const canonical = deps.readCanonicalDaemonInfo();
  if (!canonical || !(await deps.isCanonicalDaemonAlive(canonical))) {
    return { status: "legacy-local", reason: "no-daemon" };
  }

  if (request.kind === CUSTOM_KIND_ID) {
    return { status: "legacy-local", reason: "custom-command" };
  }
  if (request.placement === "session" || request.sessionName === null) {
    return { status: "legacy-local", reason: "unsupported-placement" };
  }
  if (request.placement !== "window" && request.targetSemanticPaneId === null) {
    return {
      status: "error",
      message: "the active pane does not have a durable semantic identity yet",
    };
  }
  if (!canonical.authToken) {
    return { status: "error", message: "the live daemon has no local owner credential" };
  }

  try {
    const catalog = await fetchCanonicalWorkspaceCatalog(canonical, deps.fetch);
    const workspaceName = workspaceNameForSession(catalog, request.sessionName);
    if (!workspaceName) {
      return {
        status: "error",
        message: `the live daemon does not own session ${request.sessionName}`,
      };
    }

    const result = await deps.createWorkspacePane(
      canonical,
      {
        kind: "agent",
        workspaceName,
        displayTitle: request.displayTitle,
        harnessProfileId: request.kind,
        role: "implementer",
        placement: provisioningPlacementForTarget(
          request.placement === "window"
            ? { kind: "workspace", semanticPaneId: null }
            : { kind: "pane", semanticPaneId: request.targetSemanticPaneId! },
          request.placement === "split-v" ? "down" : "right",
        ),
      },
      { operationId: deps.operationId(), autostart: false },
    );
    if (result === null) {
      return {
        status: "error",
        message: "the daemon did not confirm the agent creation; nothing was retried locally",
      };
    }
    return {
      status: "daemon",
      resource: result.resource,
      message: `started ${result.resource.displayTitle} in ${request.sessionName}`,
    };
  } catch (error) {
    const message =
      error instanceof DaemonActionInvocationError
        ? error.message
        : `agent creation unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return { status: "error", message };
  }
}
