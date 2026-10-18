import {
  HistoryAnchorRequestSchemaZ,
  HistoryAnchorResponseSchemaZ,
  type HistoryAnchorRequest,
  TmuxServerDiagnosticsSchemaZ,
  TmuxAgentOpenRequestSchemaZ,
  TmuxAgentOpenResponseSchemaZ,
  type TmuxAgentOpenRequest,
  PaneEditorContextTargetSchemaZ,
  PaneEditorContextResponseSchemaZ,
  type PaneEditorContextTarget,
  WindowLinkTargetSchemaZ,
  WindowSplitLayoutResourceSchemaZ,
  type WindowLinkTarget,
  TMUX_SERVERS_API_PATH,
  ApplicationShellProjectionInputV2SchemaZ,
  WorkspaceCatalogLiveSessionIdSchemaZ,
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
  signal?: AbortSignal,
  responseLimit?: number,
) {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 5_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 5_000);
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
    signal: requestSignal,
  });
  if (!response.ok) throw new TmuxServerClientError("request-failed", response.status);
  let result: unknown;
  if (responseLimit === undefined) result = await response.json();
  else {
    const reader = response.body?.getReader();
    if (!reader) throw new TmuxServerClientError("request-failed");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > responseLimit) {
          void reader.cancel().catch(() => undefined);
          throw new TmuxServerClientError("request-failed");
        }
        chunks.push(item.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      reader.releaseLock();
    }
  }
  requestSignal.throwIfAborted();
  return result;
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
  async function scopedRequest(
    suffix: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    defaultTimeoutMs?: number,
  ) {
    assertCurrent();
    const result = await request(
      defaultTimeoutMs === undefined
        ? options
        : { ...options, timeoutMs: options.timeoutMs ?? defaultTimeoutMs },
      `${base}/${suffix}`,
      body,
      headers,
      undefined,
      signal,
    );
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
    /** Authenticated directory observation only; does not open an editor or acquire input. */
    async paneEditorContext(input: PaneEditorContextTarget, signal?: AbortSignal) {
      const parsed = PaneEditorContextTargetSchemaZ.safeParse(input);
      if (!parsed.success) throw new TypeError("Invalid editor context target");
      const target = parsed.data;
      if (target.generation !== scope.generation) throw new TmuxServerClientError("scope-mismatch");
      signal?.throwIfAborted();
      const raw = await scopedRequest("pane-editor-context", target, undefined, signal);
      const response = PaneEditorContextResponseSchemaZ.safeParse(raw);
      if (!response.success) throw new TypeError("Invalid editor context response");
      assertScope(response.data.server);
      if (
        Object.entries(target).some(
          ([key, value]) => response.data.context[key as keyof PaneEditorContextTarget] !== value,
        )
      )
        throw new TmuxServerClientError("scope-mismatch");
      return response.data;
    },
    /** A single admission attempt may promote a session; never automatically retry. */
    async openAgent(liveSessionId: string, input: TmuxAgentOpenRequest, signal?: AbortSignal) {
      const session = WorkspaceCatalogLiveSessionIdSchemaZ.parse(liveSessionId);
      const target = TmuxAgentOpenRequestSchemaZ.parse(input);
      signal?.throwIfAborted();
      const raw = await scopedRequest(
        `sessions/${encodeURIComponent(session)}/open-agent`,
        target,
        undefined,
        signal,
      );
      const response = TmuxAgentOpenResponseSchemaZ.safeParse(raw);
      if (!response.success) throw new TypeError("Invalid scoped agent-open response");
      assertScope(response.data.server);
      if (response.data.liveSessionId !== session)
        throw new TmuxServerClientError("scope-mismatch");
      return response.data;
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
    /** Observe canonical split handles; does not acquire a channel or resize a pane. */
    async windowSplitLayout(workspaceName: string, input: WindowLinkTarget, signal?: AbortSignal) {
      if (
        typeof workspaceName !== "string" ||
        !workspaceName.length ||
        workspaceName.length > 160 ||
        /[\0\r\n]/u.test(workspaceName)
      )
        throw new TypeError("Invalid split-layout workspace name");
      const target = WindowLinkTargetSchemaZ.parse(input);
      signal?.throwIfAborted();
      const raw = await scopedRequest(
        `split-layout/${encodeURIComponent(workspaceName)}`,
        target,
        undefined,
        signal,
        // Six 5s capability probes + 6s lazy readiness + 5s owner catalog
        // validation and transport margin. Other reads retain their 5s default.
        45_000,
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("server" in raw) ||
        !("resource" in raw) ||
        Object.keys(raw).length !== 3
      )
        throw new TypeError("Invalid scoped split-layout response");
      assertScope(TmuxServerScopeSchemaZ.parse(raw.server));
      const resource = WindowSplitLayoutResourceSchemaZ.parse(raw.resource);
      const actual = resource.window;
      if (
        actual.liveSessionId !== target.liveSessionId ||
        actual.linkId !== target.linkId ||
        actual.expectedSemanticWindowId !== target.expectedSemanticWindowId ||
        actual.linkRevision !== target.linkRevision
      )
        throw new TmuxServerClientError("scope-mismatch");
      return { version: 1 as const, server: scope, resource };
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
    /** Observe an already registered session without opening it or issuing a pane stream. */
    async applicationShell(workspaceName: string, liveSessionId: string, signal?: AbortSignal) {
      if (
        typeof workspaceName !== "string" ||
        workspaceName.length < 1 ||
        workspaceName.length > 160 ||
        /[\0\r\n]/u.test(workspaceName)
      )
        throw new TypeError("Invalid application-shell workspace name");
      const liveId = WorkspaceCatalogLiveSessionIdSchemaZ.parse(liveSessionId);
      signal?.throwIfAborted();
      const raw = await scopedRequest(
        `application-shell/${encodeURIComponent(workspaceName)}?liveSessionId=${encodeURIComponent(liveId)}`,
        undefined,
        undefined,
        signal,
      );
      if (
        !raw ||
        typeof raw !== "object" ||
        !("version" in raw) ||
        raw.version !== 1 ||
        !("server" in raw) ||
        !("resource" in raw) ||
        Object.keys(raw).length !== 3
      )
        throw new TypeError("Invalid scoped application-shell response");
      assertScope(TmuxServerScopeSchemaZ.parse(raw.server));
      const resource = ApplicationShellProjectionInputV2SchemaZ.parse(raw.resource);
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

/** Optional metadata; old servers have no route. Callers own selected-scope currentness. */
export async function readTmuxServerDiagnostics(
  options: TmuxServerClientOptions,
  scopeInput: TmuxServerScope,
  signal?: AbortSignal,
) {
  const scope = TmuxServerScopeSchemaZ.parse(scopeInput);
  signal?.throwIfAborted();
  try {
    const result = TmuxServerDiagnosticsSchemaZ.parse(
      await request(
        options,
        `${TMUX_SERVERS_API_PATH}/${scope.serverId}/${scope.generation}/diagnostics`,
        undefined,
        undefined,
        undefined,
        signal,
        4096,
      ),
    );
    if (result.server.serverId !== scope.serverId || result.server.generation !== scope.generation)
      throw new TmuxServerClientError("scope-mismatch");
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TmuxServerClientError && error.status === 404) return null;
    throw error;
  }
}

/** Optional old-daemon endpoint. Never retries, creates sessions, or admits input. */
export async function requestHistoryAnchor(
  options: TmuxServerClientOptions,
  scopeInput: TmuxServerScope,
  input: HistoryAnchorRequest,
  signal?: AbortSignal,
) {
  const scope = TmuxServerScopeSchemaZ.parse(scopeInput),
    body = HistoryAnchorRequestSchemaZ.parse(input);
  if (body.proof.generation !== scope.generation) throw new TmuxServerClientError("scope-mismatch");
  signal?.throwIfAborted();
  try {
    const value = HistoryAnchorResponseSchemaZ.parse(
      await request(
        options,
        `${TMUX_SERVERS_API_PATH}/${scope.serverId}/${scope.generation}/history-anchor`,
        body,
        undefined,
        undefined,
        signal,
        4096,
      ),
    );
    if (value.server.serverId !== scope.serverId || value.server.generation !== scope.generation)
      throw new TmuxServerClientError("scope-mismatch");
    if (
      value.result.status === "resolved" &&
      Object.entries(body.proof).some(
        ([key, v]) =>
          value.result.status === "resolved" &&
          value.result.proof[key as keyof typeof body.proof] !== v,
      )
    )
      throw new TmuxServerClientError("scope-mismatch");
    if (
      (body.operation.kind === "capture" && value.result.status === "resolved") ||
      (body.operation.kind === "resolve" && value.result.status === "captured")
    )
      throw new TmuxServerClientError("scope-mismatch");
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof TmuxServerClientError && error.status === 404) return null;
    throw error;
  }
}
