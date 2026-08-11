import type { Hono } from "hono";

import {
  WORKSPACE_MISSIONS_RESOURCE_VERSION,
  WorkspaceMissionsEnvelopeV1SchemaZ,
  WorkspaceResourceWorkspaceNameSchemaZ,
  type AgentGraphOverlay,
  type AppWindowDocumentV1,
  type DaemonInstanceIdentity,
  type DesktopMissionWorkspaceResource,
} from "@tmux-ide/contracts";

import type { MissionRepositorySnapshot } from "../../lib/mission-repository.ts";
import type { WorkspaceRegistry } from "../../lib/workspace-registry.ts";
import { ownerAuthorityGate } from "../owner-authority.ts";
import {
  projectApplicationShellResource,
  type ApplicationShellSessionFacts,
} from "./application-shell.ts";
import { projectApplicationShellAgentGraphOverlay } from "./agent-graph-overlay.ts";

export interface WorkspaceMissionsRouteOptions {
  readonly daemon: DaemonInstanceIdentity;
  readonly ownerToken: string | null;
  readonly registry: Pick<WorkspaceRegistry, "get">;
  readonly inventoryBackend: {
    discoverApplicationShellSession(
      requestedSessionName: string,
    ): Promise<ApplicationShellSessionFacts | null>;
  } | null;
  readonly appWindowBackend: {
    load(
      projectDir: string,
      terminalSourceIds: readonly string[],
      focusedTerminalSourceId: string | null,
    ): Promise<AppWindowDocumentV1>;
  } | null;
  readonly missionBackend: {
    load(projectDir: string): Promise<DesktopMissionWorkspaceResource>;
    loadSnapshot?(projectDir: string): Promise<MissionRepositorySnapshot | null>;
  } | null;
}

const missionUnavailable = (reason: string): DesktopMissionWorkspaceResource => ({
  status: "degraded",
  reason,
});

/** Owner-only lazy Missions/Activity read, keyed by semantic workspace name. */
export function mountWorkspaceMissionsRoute(
  app: Hono,
  options: WorkspaceMissionsRouteOptions,
): void {
  const authorize = ownerAuthorityGate(options.ownerToken, {
    whenOwnerless: "unavailable",
    unavailableMessage: "Workspace missions capability is unavailable",
    mismatchMessage: "Workspace missions access requires owner authority",
  });

  app.get("/api/project/:name/missions", async (c) => {
    const denied = authorize(c);
    if (denied) return denied;
    const name = WorkspaceResourceWorkspaceNameSchemaZ.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "Invalid workspace name" }, 400);
    const workspace = options.registry.get(name.data);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);

    let missionWorkspace: DesktopMissionWorkspaceResource;
    if (!options.missionBackend) {
      missionWorkspace = missionUnavailable("Mission history is unavailable from this daemon.");
    } else {
      try {
        missionWorkspace = await options.missionBackend.load(workspace.projectDir);
      } catch {
        missionWorkspace = missionUnavailable(
          "Mission history could not be verified. The terminal workspace remains available.",
        );
      }
    }

    let agentGraphOverlay: AgentGraphOverlay | undefined;
    if (
      options.inventoryBackend &&
      options.appWindowBackend &&
      options.missionBackend?.loadSnapshot
    ) {
      try {
        const session = await options.inventoryBackend.discoverApplicationShellSession(
          workspace.sessionName,
        );
        if (session) {
          const shell = projectApplicationShellResource(session);
          const appWindows = await options.appWindowBackend.load(
            workspace.projectDir,
            shell.terminalInventory.resources.map(({ id }) => id),
            shell.terminalInventory.activeResourceId,
          );
          const missionSnapshot = await options.missionBackend.loadSnapshot(workspace.projectDir);
          const overlay = projectApplicationShellAgentGraphOverlay({
            session,
            appWindows,
            missionSnapshot,
            nowSec: Math.floor(Date.now() / 1_000),
          });
          if (Object.keys(overlay.nodes).length > 0) agentGraphOverlay = overlay;
        }
      } catch {
        // Mission data remains useful without a runtime graph. Never fail the
        // lazy resource because one best-effort correlation read raced tmux.
      }
    }

    const envelope = WorkspaceMissionsEnvelopeV1SchemaZ.parse({
      version: WORKSPACE_MISSIONS_RESOURCE_VERSION,
      daemon: options.daemon,
      resource: {
        workspaceName: workspace.name,
        missionWorkspace,
        ...(agentGraphOverlay ? { agentGraphOverlay } : {}),
      },
    });
    c.header("Cache-Control", "no-store");
    return c.json(envelope);
  });
}
