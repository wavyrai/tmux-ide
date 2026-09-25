import { mountTmuxServerNativeBackingRoute } from "./tmux-server-native-backing.ts";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { projectApplicationShellResource } from "./resources/application-shell.ts";
import { fleetSessionIdForName } from "./resources/fleet-catalog.ts";
import { z } from "zod";
import {
  TMUX_SERVERS_API_PATH,
  PANE_STREAM_ISSUE_PATH,
  TmuxServerIdSchemaZ,
  TmuxServerScopeSchemaZ,
  TmuxServersResourceSchemaZ,
  TmuxServerSessionsResourceSchemaZ,
  WorkspaceMultiplexerMutationRequestSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspaceSessionCreateArgumentsSchemaZ,
} from "@tmux-ide/contracts";
import {
  TmuxServerOwners,
  TmuxServerRegistrationSchemaZ,
  TmuxServerScopeError,
} from "../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../lib/tmux-server-owner.ts";
import { WorkspaceMultiplexerError } from "../lib/workspace-multiplexer-verbs.ts";
import { ownerBearerMatches } from "./owner-authority.ts";
import { mountPaneStreamIssueRoute } from "./pane-stream-issue.ts";
import { projectTerminalRuntimeInventory } from "./resources/terminal-runtime-inventory.ts";

export interface TmuxServerRoutesOptions {
  readonly ownerToken: string | null;
  readonly owners: TmuxServerOwners<NativeTmuxServerOwner>;
}
const registrationSchema = TmuxServerRegistrationSchemaZ.omit({ serverId: true }).strict();
const workspaceSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => !/[\0\r\n]/u.test(value));
async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new TypeError("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) {
        void reader.cancel().catch(() => undefined);
        throw new TypeError("Body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function failure(c: Context, error: unknown): Response {
  if (error instanceof TmuxServerScopeError)
    return c.json(
      { error: { code: error.code } },
      error.code === "not-found" ? 404 : error.code === "capacity" ? 429 : 409,
    );
  if (error instanceof WorkspaceMultiplexerError)
    return c.json({ error: { code: error.code } }, 409);
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof TypeError)
    return c.json({ error: { code: "invalid-request" } }, 400);
  return c.json({ error: { code: "server-unavailable" } }, 503);
}
/** Owner capability is mandatory even when the ordinary local HTTP surface is open. */
export function mountTmuxServerRoutes(app: Hono, options: TmuxServerRoutesOptions): void {
  const base = TMUX_SERVERS_API_PATH;
  const authorize = async (c: Context, next: () => Promise<void>) => {
    c.header("Cache-Control", "no-store");
    if (!ownerBearerMatches(c.req.header("Authorization"), options.ownerToken))
      return c.json({ error: { code: "owner-required" } }, 401);
    await next();
  };
  app.use(base, authorize);
  app.use(`${base}/*`, authorize);
  const route = (work: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await work(c);
    } catch (error) {
      return failure(c, error);
    }
  };
  const scope = (c: Context) =>
    TmuxServerScopeSchemaZ.parse({
      serverId: c.req.param("serverId"),
      generation: c.req.param("generation"),
    });
  app.get(
    base,
    route(async (c) =>
      c.json(
        TmuxServersResourceSchemaZ.parse({ version: 1, servers: await options.owners.refresh() }),
      ),
    ),
  );
  app.post(
    base,
    route(async (c) =>
      c.json(
        await options.owners.register(registrationSchema.parse(await boundedJson(c.req.raw))),
        201,
      ),
    ),
  );
  app.delete(
    `${base}/:serverId`,
    route(async (c) => {
      await options.owners.remove(TmuxServerIdSchemaZ.parse(c.req.param("serverId")));
      return c.json({ removed: true });
    }),
  );
  const scoped = `${base}/:serverId/:generation`;
  mountTmuxServerNativeBackingRoute(app, {
    scopedPath: scoped,
    ownerToken: options.ownerToken,
    owners: options.owners,
  });
  app.post(
    `${scoped}/sessions/create`,
    route(async (c) => {
      const server = scope(c);
      const request = z
        .object({
          operationId: z.uuid(),
          expectedDaemonInstanceId: z.uuid(),
          intent: WorkspaceSessionCreateArgumentsSchemaZ,
        })
        .strict()
        .parse(await boundedJson(c.req.raw));
      if (
        request.expectedDaemonInstanceId !== server.generation ||
        (request.intent.expectedDaemonInstanceId &&
          request.intent.expectedDaemonInstanceId !== server.generation)
      )
        return c.json({ error: { code: "stale-generation" } }, 409);
      return c.json(
        await options.owners.withOwner(server, (owner) =>
          owner.createSession(request.operationId, {
            ...request.intent,
            expectedDaemonInstanceId: server.generation,
          }),
        ),
      );
    }),
  );
  app.post(
    `${scoped}/sessions/:liveSessionId/open`,
    route(async (c) => {
      const server = scope(c);
      const result = await options.owners.withOwner(server, (owner) =>
        owner.openSession(workspaceSchema.parse(c.req.param("liveSessionId"))),
      );
      return c.json({ version: 1, server, ...result });
    }),
  );
  app.get(
    `${scoped}/sessions`,
    route(async (c) => {
      const server = scope(c);
      return c.json(
        TmuxServerSessionsResourceSchemaZ.parse({
          version: 1,
          server,
          sessions: await options.owners.withOwner(server, async (owner) => {
            const sessions = await owner.catalog();
            const workspaces = owner.workspaceRegistry.list();
            return sessions.map((session) => {
              const aliases = workspaces.filter(
                (workspace) => workspace.sessionName === session.sessionName,
              );
              return { ...session, workspaceName: aliases.length === 1 ? aliases[0]!.name : null };
            });
          }),
        }),
      );
    }),
  );
  app.get(
    `${scoped}/inventory/:workspaceName`,
    route(async (c) => {
      const server = scope(c);
      const workspaceName = workspaceSchema.parse(c.req.param("workspaceName"));
      const resource = await options.owners.withOwner(server, async (owner) => {
        const sessions = await owner.catalog();
        const workspace = owner.workspaceRegistry.get(workspaceName);
        if (!workspace) return null;
        const expected = c.req.query("liveSessionId");
        if (
          expected &&
          !sessions.some(
            (row) => row.sessionName === workspace.sessionName && row.liveSessionId === expected,
          )
        )
          throw new TmuxServerScopeError("stale-generation");
        const snapshot = await owner.terminalInventoryRuntime.discoverTerminalRuntimeSession(
          workspace.sessionName,
          c.req.raw.signal,
        );
        return snapshot ? projectTerminalRuntimeInventory(snapshot, 0) : null;
      });
      return resource
        ? c.json({ version: 1, server, resource })
        : c.json({ error: { code: "workspace-not-found" } }, 404);
    }),
  );
  app.get(
    `${scoped}/catalog`,
    route(async (c) => {
      const server = scope(c);
      const resource = await options.owners.withOwner(server, async (owner) => {
        const sessions = await owner.catalog();
        return {
          intents: owner.workspaceRegistry.list().map((entry) => ({
            workspaceName: entry.name,
            sessionName: entry.sessionName,
            source: "workspace",
            availability: sessions.some((row) => row.sessionName === entry.sessionName)
              ? "live"
              : "stopped",
          })),
          liveSessions: sessions.map((row) => ({
            sessionName: row.sessionName,
            fleetSessionId: fleetSessionIdForName(row.sessionName),
            paneCount: row.paneCount,
          })),
        };
      });
      return c.json({ version: 1, server, resource });
    }),
  );
  app.get(
    `${scoped}/application-shell/:workspaceName`,
    route(async (c) => {
      const server = scope(c);
      const workspaceName = workspaceSchema.parse(c.req.param("workspaceName"));
      const resource = await options.owners.withOwner(server, async (owner) => {
        const sessions = await owner.catalog();
        const workspace = owner.workspaceRegistry.get(workspaceName);
        if (!workspace) return null;
        if (
          !sessions.some(
            (row) =>
              row.sessionName === workspace.sessionName &&
              row.liveSessionId === c.req.query("liveSessionId"),
          )
        )
          throw new TmuxServerScopeError("stale-generation");
        // Agent lists need the same status enrichment as pane headers. Raw
        // terminal inventory omits these facts and falls back to process activity.
        const snapshot = await owner.terminalInventoryRuntime.discoverApplicationShellSession(
          workspace.sessionName,
        );
        // Discovery can yield while a same-name session is replaced. Revalidate
        // the captured incarnation before publishing agent metadata as current.
        const currentSessions = await owner.catalog();
        if (
          !currentSessions.some(
            (row) =>
              row.sessionName === workspace.sessionName &&
              row.liveSessionId === c.req.query("liveSessionId"),
          )
        )
          throw new TmuxServerScopeError("stale-generation");
        return snapshot ? projectApplicationShellResource(snapshot) : null;
      });
      return resource
        ? c.json({ version: 1, server, resource })
        : c.json({ error: { code: "workspace-not-found" } }, 404);
    }),
  );
  // Subscribe before publishing ready: a topology change during the subsequent HTTP read
  // invalidates that read. This shares the owner's retained mirror, never a new tmux client.
  app.get(
    `${scoped}/session-events/:workspaceName`,
    route(async (c) => {
      const server = scope(c);
      const workspaceName = workspaceSchema.parse(c.req.param("workspaceName"));
      const owner = await options.owners.withOwner(server, async (candidate) => {
        const sessions = await candidate.catalog();
        const workspace = candidate.workspaceRegistry.get(workspaceName);
        if (
          !workspace ||
          !sessions.some(
            (row) =>
              row.sessionName === workspace.sessionName &&
              row.liveSessionId === c.req.query("liveSessionId"),
          )
        )
          throw new TmuxServerScopeError("stale-generation");
        return candidate;
      });
      const workspace = owner.workspaceRegistry.get(workspaceName)!;
      return streamSSE(c, async (stream) => {
        let stopped = false;
        let wake: (() => void) | null = null;
        let revision = 0;
        const dirty = () => {
          revision++;
          wake?.();
        };
        stream.onAbort(() => {
          stopped = true;
          wake?.();
        });
        const identity = await owner.sessionRuntimeRegistry.describeSessionAuthority(
          workspace.sessionName,
        );
        let topology: string | null = null;
        let sessionReplaced = false;
        const subscription = await owner.sessionRuntimeRegistry.subscribeLayout(
          workspace.sessionName,
          () => undefined,
          {
            expectedRuntimeSessionId: identity.runtimeSessionId,
            expectedSemanticPaneIds: identity.description.panes.map((pane) => pane.semanticPaneId),
            onAuthority(snapshot) {
              if (snapshot.windowLinks.liveSessionId !== c.req.query("liveSessionId")) {
                sessionReplaced = true;
                dirty();
                return;
              }
              // Full replacement observes removed windows and retains no historical keys.
              // Geometry, focus and active-link changes stay entirely on the pane stream.
              const signature = JSON.stringify(
                snapshot.layouts
                  .map((layout) => [
                    layout.semanticWindowId,
                    layout.windowName,
                    layout.panes.map((pane) => pane.semanticPaneId).sort(),
                  ])
                  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
              );
              if (topology === signature) return;
              topology = signature;
              dirty();
            },
          },
        );
        try {
          options.owners.current(server);
          if (sessionReplaced) throw new TmuxServerScopeError("stale-generation");
          await stream.writeSSE({
            data: JSON.stringify({ version: 1, server, type: "ready", revision }),
          });
          let sent = revision;
          let nextIdentityCheck = Date.now() + 5000;
          while (!stopped) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1000);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
              if (stopped || revision !== sent) wake();
            });
            wake = null;
            if (stopped) break;
            if (sessionReplaced) throw new TmuxServerScopeError("stale-generation");
            options.owners.current(server);
            if (Date.now() >= nextIdentityCheck) {
              const sessions = await owner.catalog();
              options.owners.current(server);
              if (
                !sessions.some(
                  (row) =>
                    row.sessionName === workspace.sessionName &&
                    row.liveSessionId === c.req.query("liveSessionId"),
                )
              )
                throw new TmuxServerScopeError("stale-generation");
              nextIdentityCheck = Date.now() + 5000;
            }
            if (revision !== sent) {
              sent = revision;
              await stream.writeSSE({
                data: JSON.stringify({ version: 1, server, type: "invalidate", revision }),
              });
            } else
              await stream.writeSSE({
                data: JSON.stringify({ version: 1, server, type: "heartbeat", revision }),
              });
          }
        } catch {
          if (!stopped)
            await stream
              .writeSSE({ data: JSON.stringify({ version: 1, server, type: "retired", revision }) })
              .catch(() => undefined);
        } finally {
          await subscription.close();
        }
      });
    }),
  );
  app.post(
    `${scoped}/panes/create`,
    route(async (c) => {
      const server = scope(c);
      const liveSessionId = workspaceSchema.parse(c.req.query("liveSessionId"));
      const request = WorkspacePaneCreateMutationRequestSchemaZ.parse(await boundedJson(c.req.raw));
      if (request.expectedDaemonInstanceId !== server.generation)
        return c.json({ error: { code: "stale-generation" } }, 409);
      return c.json(
        await options.owners.withOwner(server, (owner) =>
          owner.createSessionPane(liveSessionId, request),
        ),
      );
    }),
  );
  app.post(
    `${scoped}/mutations`,
    route(async (c) => {
      const server = scope(c);
      const request = WorkspaceMultiplexerMutationRequestSchemaZ.parse(
        await boundedJson(c.req.raw),
      );
      if (request.expectedDaemonInstanceId !== server.generation)
        return c.json({ error: { code: "stale-generation" } }, 409);
      const liveSessionId = c.req.query("liveSessionId");
      const result = await options.owners.withOwner(server, (owner) =>
        liveSessionId
          ? owner.mutateSession(liveSessionId, request, c.req.header("X-Tmux-Ide-Host-Client-Id"))
          : owner.multiplexerBackend.mutate(
              request,
              c.req.header("X-Tmux-Ide-Host-Client-Id"),
              undefined,
              true,
            ),
      );
      return c.json(result);
    }),
  );
  app.post(
    `${scoped}/pane-streams/issue`,
    route(async (c) => {
      const server = scope(c);
      return options.owners.withOwner(server, async (owner) => {
        const sessions = await owner.catalog();
        const liveSessionId = c.req.query("liveSessionId");
        if (liveSessionId) {
          const body = (await boundedJson(c.req.raw.clone())) as {
            stream?: { workspaceName?: string };
          };
          const workspace = owner.workspaceRegistry.get(body.stream?.workspaceName ?? "");
          if (
            !workspace ||
            !sessions.some(
              (row) =>
                row.sessionName === workspace.sessionName && row.liveSessionId === liveSessionId,
            )
          )
            throw new TmuxServerScopeError("stale-generation");
        }
        const issueApp = new Hono();
        mountPaneStreamIssueRoute(issueApp, {
          daemonInstanceId: server.generation,
          ownerToken: options.ownerToken,
          workspaceRegistry: owner.workspaceRegistry,
          backend: owner.paneStreamRuntime.coordinator,
        });
        const url = new URL(c.req.url);
        url.pathname = PANE_STREAM_ISSUE_PATH;
        url.search = "";
        return await issueApp.request(new Request(url, c.req.raw));
      });
    }),
  );
}
