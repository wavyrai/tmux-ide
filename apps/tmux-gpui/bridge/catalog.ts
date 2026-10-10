import { TmuxServerSessionsResourceSchemaZ } from "../../../packages/contracts/src/tmux-server-scope.ts";
import { catalogStage, CatalogStageError } from "./catalog-errors.ts";
import { randomUUID } from "node:crypto";
import { createTmuxServerClient } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { connectionSchema, hostSchema, type PreviewHost } from "./config.ts";
import type { HomeAgentCatalogSession } from "../../../packages/presentation/src/home-agent-roster.ts";

export function createPreviewCatalog(hostInput: PreviewHost) {
  const host = hostSchema.parse(hostInput);
  const client = createTmuxServerClient(
    { ...host, hostClientId: `gpui-catalog:${randomUUID()}`, origin: "tmux-ide://app" },
    host.scope,
  );
  return {
    dispose: () => client.dispose(),
    async homeSessions(): Promise<HomeAgentCatalogSession[]> {
      const list = await catalogStage("list-sessions", () => client.sessions());
      return list.sessions.map((session) => ({
        id: session.liveSessionId,
        liveSessionId: session.liveSessionId,
        name: session.sessionName,
        paneCount: session.paneCount,
        ...(session.workspaceName === null ? {} : { workspaceName: session.workspaceName }),
        server: { ...host.scope },
      }));
    },
    readHomeShell(session: HomeAgentCatalogSession, signal: AbortSignal) {
      if (
        !session.workspaceName ||
        !session.liveSessionId ||
        session.server?.serverId !== host.scope.serverId ||
        session.server.generation !== host.scope.generation
      )
        throw new Error("Home session is unavailable for this server");
      return client.applicationShell(session.workspaceName, session.liveSessionId, signal);
    },
    createSession(operationId: string, displayName: string) {
      return client.createSession(operationId, {
        displayName,
        includeLiveSessionId: true,
        expectedDaemonInstanceId: host.scope.generation,
      });
    },
    async sessions() {
      return (await catalogStage("list-sessions", () => client.sessions())).sessions;
    },
    async workspacePanes(liveSessionId: string, workspaceName: string) {
      const list = await client.sessions();
      if (
        !list.sessions.some(
          (session) =>
            session.liveSessionId === liveSessionId && session.workspaceName === workspaceName,
        )
      )
        throw new Error("Workspace session changed");
      const inventory = await client.inventory(workspaceName);
      const current = await client.sessions();
      if (
        !current.sessions.some(
          (session) =>
            session.liveSessionId === liveSessionId && session.workspaceName === workspaceName,
        )
      )
        throw new Error("Workspace session changed");
      return inventory.resource.semanticPaneIds.map((semanticPaneId) =>
        connectionSchema.parse({
          ...host,
          workspaceName,
          liveSessionId,
          semanticPaneId,
          visiblePaneIds: inventory.resource.semanticPaneIds,
        }),
      );
    },
    async panes(liveSessionId: string) {
      // Revalidate the selected identity; names and list positions are not authority.
      await catalogStage("revalidate-sessions", async () => {
        const sessions = await client.sessions();
        if (!sessions.sessions.some((s) => s.liveSessionId === liveSessionId))
          throw new CatalogStageError("revalidate-sessions", undefined, true);
      });
      const opened = await catalogStage("open-session", () => client.openSession(liveSessionId));
      const inventory = await catalogStage("inventory", () =>
        client.inventory(opened.workspaceName),
      );
      return catalogStage("connection-validation", () =>
        inventory.resource.semanticPaneIds.map((semanticPaneId) =>
          connectionSchema.parse({
            ...host,
            workspaceName: opened.workspaceName,
            liveSessionId,
            semanticPaneId,
            visiblePaneIds: inventory.resource.semanticPaneIds,
          }),
        ),
      );
    },
  };
}

/** Display metadata only; identity continues to be the daemon's liveSessionId. */
export function sessionChoice(session: {
  liveSessionId: string;
  sessionName: string;
  paneCount?: number;
}) {
  const paneCount = TmuxServerSessionsResourceSchemaZ.shape.sessions.element.shape.paneCount
    .optional()
    .parse(session.paneCount);
  return {
    id: session.liveSessionId,
    label: session.sessionName,
    ...(paneCount === undefined ? {} : { paneCount }),
  };
}
