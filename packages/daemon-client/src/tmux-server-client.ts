import {
  TMUX_SERVERS_API_PATH,
  PANE_STREAM_REDEEM_PATH,
  TmuxServerIdSchemaZ,
  TmuxServerDescriptorSchemaZ,
  TmuxServerRegistrationRequestSchemaZ,
  type TmuxServerRegistrationRequest,
  TmuxServerScopeSchemaZ,
  TmuxServersResourceSchemaZ,
  TmuxServerSessionsResourceSchemaZ,
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  WorkspaceMultiplexerMutationRequestSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  type WorkspacePaneCreateArguments,
  WorkspaceSessionCreateArgumentsSchemaZ,
  WorkspaceSessionCreateResultSchemaZ,
  type WorkspaceSessionCreateArguments,
  WorkspaceMultiplexerMutationResultSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  tmuxServerPaneStreamPath,
  tmuxServerScopedResourceKey,
  type TmuxServerScope,
  type WorkspaceMultiplexerIntent,
  type PaneStreamLeaseRequest,
} from "@tmux-ide/contracts";

export interface TmuxServerClientOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly hostClientId: string;
  readonly origin: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}
export class TmuxServerClientError extends Error {
  constructor(
    readonly code: "disposed" | "scope-mismatch" | "request-failed",
    readonly status?: number,
  ) {
    super(`tmux server client ${code}`);
    this.name = "TmuxServerClientError";
  }
}
async function request(
  options: TmuxServerClientOptions,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  method?: "DELETE",
) {
  const response = await (options.fetch ?? fetch)(new URL(path, options.baseUrl), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${options.ownerToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  if (!response.ok) throw new TmuxServerClientError("request-failed", response.status);
  return (await response.json()) as unknown;
}
export async function listTmuxServers(options: TmuxServerClientOptions) {
  return TmuxServersResourceSchemaZ.parse(await request(options, TMUX_SERVERS_API_PATH));
}

export async function registerTmuxServer(
  options: TmuxServerClientOptions,
  registration: TmuxServerRegistrationRequest,
) {
  return TmuxServerDescriptorSchemaZ.parse(
    await request(
      options,
      TMUX_SERVERS_API_PATH,
      TmuxServerRegistrationRequestSchemaZ.parse(registration),
    ),
  );
}
export async function removeTmuxServer(
  options: TmuxServerClientOptions,
  serverId: string,
): Promise<void> {
  const response = await request(
    options,
    `${TMUX_SERVERS_API_PATH}/${TmuxServerIdSchemaZ.parse(serverId)}`,
    undefined,
    undefined,
    "DELETE",
  );
  if (
    !response ||
    typeof response !== "object" ||
    !("removed" in response) ||
    response.removed !== true ||
    Object.keys(response).length !== 1
  )
    throw new TypeError("Invalid server removal response");
}

/** Bind once. Selection changes dispose this client and create another; no implicit fallback. */
export function createTmuxServerClient(
  optionsInput: TmuxServerClientOptions,
  scopeInput: TmuxServerScope,
) {
  const options = Object.freeze({ ...optionsInput });
  const scope = Object.freeze(TmuxServerScopeSchemaZ.parse(scopeInput));
  const base = `${TMUX_SERVERS_API_PATH}/${scope.serverId}/${scope.generation}`;
  let disposed = false;
  function assertCurrent() {
    if (disposed) throw new TmuxServerClientError("disposed");
  }
  function assertScope(candidate: TmuxServerScope) {
    if (candidate.serverId !== scope.serverId || candidate.generation !== scope.generation)
      throw new TmuxServerClientError("scope-mismatch");
  }
  async function scopedRequest(suffix: string, body?: unknown, headers?: Record<string, string>) {
    assertCurrent();
    const result = await request(options, `${base}/${suffix}`, body, headers);
    assertCurrent();
    return result;
  }
  return {
    scope,
    dispose() {
      disposed = true;
    },
    cacheKey(kind: string, resourceId: string) {
      return tmuxServerScopedResourceKey(scope, kind, resourceId);
    },
    async sessions() {
      const response = TmuxServerSessionsResourceSchemaZ.parse(await scopedRequest("sessions"));
      assertScope(response.server);
      return response;
    },
    async openSession(liveSessionId: string) {
      const raw = await scopedRequest(`sessions/${encodeURIComponent(liveSessionId)}/open`, {});
      if (
        !raw ||
        typeof raw !== "object" ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("server" in raw) ||
        !("workspaceName" in raw) ||
        typeof raw.workspaceName !== "string" ||
        !raw.workspaceName ||
        !("liveSessionId" in raw) ||
        raw.liveSessionId !== liveSessionId ||
        Object.keys(raw).length !== 4
      )
        throw new TypeError("Invalid scoped session-open response");
      assertScope(TmuxServerScopeSchemaZ.parse(raw.server));
      return {
        version: 1 as const,
        server: scope,
        workspaceName: raw.workspaceName,
        liveSessionId,
      };
    },
    async inventory(workspaceName: string) {
      const raw = await scopedRequest(`inventory/${encodeURIComponent(workspaceName)}`);
      if (
        !raw ||
        typeof raw !== "object" ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("server" in raw) ||
        !("resource" in raw) ||
        Object.keys(raw).length !== 3
      )
        throw new TypeError("Invalid scoped inventory response");
      assertScope(TmuxServerScopeSchemaZ.parse(raw.server));
      const resource = TerminalRuntimeInventoryProjectionV1SchemaZ.parse(raw.resource);
      if (resource.workspaceName !== workspaceName)
        throw new TmuxServerClientError("scope-mismatch");
      return { version: 1 as const, server: scope, resource };
    },
    async createSession(operationId: string, intent: WorkspaceSessionCreateArguments) {
      const safeIntent = WorkspaceSessionCreateArgumentsSchemaZ.parse(intent);
      if (
        safeIntent.expectedDaemonInstanceId &&
        safeIntent.expectedDaemonInstanceId !== scope.generation
      )
        throw new TmuxServerClientError("scope-mismatch");
      const result = WorkspaceSessionCreateResultSchemaZ.parse(
        await scopedRequest("sessions/create", {
          operationId,
          expectedDaemonInstanceId: scope.generation,
          intent: safeIntent,
        }),
      );
      if (result.daemonInstanceId !== scope.generation || result.operationId !== operationId)
        throw new TmuxServerClientError("scope-mismatch");
      return result;
    },
    async createPane(
      operationId: string,
      intent: WorkspacePaneCreateArguments,
      liveSessionId: string,
    ) {
      const body = WorkspacePaneCreateMutationRequestSchemaZ.parse({
        operationId,
        expectedDaemonInstanceId: scope.generation,
        intent,
      });
      const result = WorkspacePaneCreateMutationResultSchemaZ.parse(
        await scopedRequest(
          `panes/create?liveSessionId=${encodeURIComponent(liveSessionId)}`,
          body,
        ),
      );
      if (
        result.daemonInstanceId !== scope.generation ||
        result.operationId !== operationId ||
        result.resource.workspaceName !== intent.workspaceName
      )
        throw new TmuxServerClientError("scope-mismatch");
      return result;
    },
    async mutate(operationId: string, intent: WorkspaceMultiplexerIntent, liveSessionId?: string) {
      const body = WorkspaceMultiplexerMutationRequestSchemaZ.parse({
        operationId,
        expectedDaemonInstanceId: scope.generation,
        intent,
      });
      const result = WorkspaceMultiplexerMutationResultSchemaZ.parse(
        await scopedRequest(
          `mutations${liveSessionId ? `?liveSessionId=${encodeURIComponent(liveSessionId)}` : ""}`,
          body,
          intent.verb === "workspace.session.kill" && intent.fleetTarget
            ? undefined
            : { "X-Tmux-Ide-Host-Client-Id": options.hostClientId },
        ),
      );
      if (
        result.daemonInstanceId !== scope.generation ||
        result.operationId !== operationId ||
        result.verb !== intent.verb ||
        result.workspaceName !== intent.workspaceName
      )
        throw new TmuxServerClientError("scope-mismatch");
      return result;
    },
    async issuePaneStream(
      requestId: string,
      stream: PaneStreamLeaseRequest,
      liveSessionId?: string,
    ) {
      const body = PaneStreamIssueMutationRequestSchemaZ.parse({
        requestId,
        expectedDaemonInstanceId: scope.generation,
        stream,
      });
      const result = PaneStreamIssueResultSchemaZ.parse(
        await scopedRequest(
          `pane-streams/issue${liveSessionId ? `?liveSessionId=${encodeURIComponent(liveSessionId)}` : ""}`,
          body,
          {
            Origin: options.origin,
            "X-Tmux-Ide-Request-Id": requestId,
            "X-Tmux-Ide-Expected-Daemon-Instance-Id": scope.generation,
            "X-Tmux-Ide-Host-Client-Id": options.hostClientId,
          },
        ),
      );
      if (
        result.status === "issued" &&
        (result.descriptor.daemonInstanceId !== scope.generation ||
          result.descriptor.requestId !== requestId ||
          // The adopted default owner retains its original redemption address.
          // Its exact generation and request are still proven by this bound issue response.
          ![tmuxServerPaneStreamPath(scope), PANE_STREAM_REDEEM_PATH].includes(
            new URL(result.descriptor.webSocketUrl).pathname,
          ) ||
          JSON.stringify([...result.descriptor.panes].sort()) !==
            JSON.stringify([...stream.panes].sort()))
      )
        throw new TmuxServerClientError("scope-mismatch");
      return result;
    },
  };
}
export type TmuxServerClient = ReturnType<typeof createTmuxServerClient>;
