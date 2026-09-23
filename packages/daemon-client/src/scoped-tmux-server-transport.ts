import {
  ActionContractsZ,
  ApplicationShellProjectionInputV2SchemaZ,
  DesktopApplicationShellTargetSchemaZ,
  TerminalRuntimeInventoryProjectionV1SchemaZ,
  TmuxServerScopeSchemaZ,
  WorkspaceCatalogResourceV2SchemaZ,
  WorkspaceMultiplexerIntentSchemaZ,
  WorkspacePaneCreateArgumentsSchemaZ,
  type ActionResult,
  type DesktopApplicationShellTarget,
  type TerminalRuntimeInventoryProjectionV1,
  type TmuxServerScope,
} from "@tmux-ide/contracts";
import type { TerminalFirstDaemonTransport } from "./direct-application-shell-transport.ts";
import type { ApplicationShellEventHandlers } from "./application-shell-session.ts";
import type { PreparedTerminalRuntimeInventory } from "./workspace-event-supervisor.ts";
import type {
  WorkspaceClientCatalogPort,
  WorkspaceClientOwnerActionPort,
} from "./workspace-client-types.ts";
import { createTmuxServerClient, type TmuxServerClientOptions } from "./tmux-server-client.ts";

export interface ScopedTmuxServerTransportOptions {
  readonly clientOptions: TmuxServerClientOptions;
  readonly scope: TmuxServerScope;
  readonly target: DesktopApplicationShellTarget;
  readonly sessionName: string;
  readonly liveSessionId: string;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** One selected incarnation and live session. No endpoint in this adapter can fall back to default. */
export function createScopedTmuxServerTransport(
  options: ScopedTmuxServerTransportOptions,
): TerminalFirstDaemonTransport {
  const scope = TmuxServerScopeSchemaZ.parse(options.scope);
  const target = DesktopApplicationShellTargetSchemaZ.parse(options.target);
  if (target.daemon.instanceId !== scope.generation)
    throw new Error("Scoped owner generation mismatch");
  const base = `/api/v1/tmux-servers/${scope.serverId}/${scope.generation}`;
  const fetcher = options.clientOptions.fetch ?? fetch;
  const lifetime = new AbortController();
  let retired = false;
  let revision = 0;
  let ready: Promise<void> | null = null;
  let sink: ((resource: TerminalRuntimeInventoryProjectionV1) => void) | null = null;
  const handlers = new Set<ApplicationShellEventHandlers>();
  const catalogListeners = new Set<() => void>();
  let refreshing = false;
  let refreshAgain = false;
  const validateTarget = (input: unknown): DesktopApplicationShellTarget => {
    const candidate = DesktopApplicationShellTargetSchemaZ.parse(input);
    if (
      retired ||
      candidate.workspaceName !== target.workspaceName ||
      candidate.daemon.instanceId !== scope.generation ||
      candidate.daemon.protocolVersion !== target.daemon.protocolVersion ||
      candidate.daemon.productVersion !== target.daemon.productVersion ||
      candidate.daemon.startedAt !== target.daemon.startedAt
    )
      throw new Error("Retired or mismatched scoped target");
    return candidate;
  };
  const checkEnvelope = (raw: unknown): Record<string, unknown> => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("version" in raw) ||
      raw.version !== 1 ||
      !("server" in raw)
    )
      throw new Error("Invalid scoped response");
    const candidate = TmuxServerScopeSchemaZ.parse(raw.server);
    if (
      retired ||
      candidate.serverId !== scope.serverId ||
      candidate.generation !== scope.generation
    )
      throw new Error("Scoped response generation mismatch");
    return raw as Record<string, unknown>;
  };
  const url = (path: string) => new URL(`${base}/${path}`, options.clientOptions.baseUrl);
  const headers = { Authorization: `Bearer ${options.clientOptions.ownerToken}` };
  const request = async (path: string, signal: AbortSignal) => {
    validateTarget(target);
    const response = await fetcher(url(path), {
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(options.clientOptions.timeoutMs ?? 5000),
      ]),
    });
    if (!response.ok) throw new Error(`Scoped resource unavailable (${response.status})`);
    return checkEnvelope(await response.json());
  };
  const workspacePath = (kind: string) =>
    `${kind}/${encodeURIComponent(target.workspaceName)}?liveSessionId=${encodeURIComponent(options.liveSessionId)}`;
  const readInventory = async (signal: AbortSignal) => {
    const raw = await request(workspacePath("inventory"), signal);
    const resource = TerminalRuntimeInventoryProjectionV1SchemaZ.parse(raw.resource);
    if (resource.workspaceName !== target.workspaceName)
      throw new Error("Scoped workspace mismatch");
    return resource;
  };
  const refresh = () => {
    if (!sink || retired) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    void (async () => {
      do {
        refreshAgain = false;
        const observed = revision;
        const resource = await readInventory(lifetime.signal);
        if (retired) return;
        if (observed !== revision) {
          refreshAgain = true;
          continue;
        }
        sink?.({ ...resource, resourceRevision: revision });
      } while (refreshAgain && !retired);
    })()
      .catch((error: unknown) => {
        if (!retired) for (const listener of handlers) listener.onError(String(error));
      })
      .finally(() => {
        refreshing = false;
      });
  };
  const ensureEvents = (): Promise<void> => {
    if (ready) return ready;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const deadline = setTimeout(() => {
      rejectReady(new Error("Scoped subscription deadline exceeded"));
      lifetime.abort();
    }, options.clientOptions.timeoutMs ?? 5000);
    void ready.then(
      () => clearTimeout(deadline),
      () => clearTimeout(deadline),
    );
    void (async () => {
      const response = await fetcher(url(workspacePath("session-events")), {
        headers,
        redirect: "error",
        cache: "no-store",
        signal: lifetime.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`Scoped event stream unavailable (${response.status})`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let opened = false;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) throw new Error("Scoped event stream closed");
          buffer += decoder.decode(next.value, { stream: true });
          if (buffer.length > 65536) throw new Error("Scoped event frame too large");
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end < 0) break;
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = event
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const frame = checkEnvelope(JSON.parse(data));
            if (
              !Number.isSafeInteger(frame.revision) ||
              Number(frame.revision) < revision ||
              !["ready", "invalidate", "heartbeat"].includes(String(frame.type))
            )
              throw new Error("Invalid scoped event frame");
            if (!opened) {
              if (frame.type !== "ready") throw new Error("Missing scoped subscription barrier");
              opened = true;
              revision = Number(frame.revision);
              resolveReady();
            } else if (frame.type === "ready")
              throw new Error("Repeated scoped subscription barrier");
            if (frame.type === "invalidate") {
              revision = Number(frame.revision);
              for (const listener of handlers) listener.onInvalidate();
              for (const invalidate of catalogListeners) invalidate();
              refresh();
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    })().catch((error: unknown) => {
      rejectReady(error);
      if (retired) return;
      retired = true;
      sink = null;
      lifetime.abort();
      for (const listener of handlers) listener.onPeerMismatch(String(error));
    });
    return ready;
  };
  return {
    validateTarget,
    async fetchApplicationShell(candidate, signal) {
      validateTarget(candidate);
      await abortable(ensureEvents(), signal);
      const raw = await request(workspacePath("application-shell"), signal);
      return ApplicationShellProjectionInputV2SchemaZ.parse(raw.resource);
    },
    connectEvents(candidate, listener) {
      validateTarget(candidate);
      handlers.add(listener);
      void ensureEvents().then(
        () => {
          if (handlers.has(listener) && !retired) listener.onVerifiedOpen();
        },
        () => undefined,
      );
      return {
        close() {
          handlers.delete(listener);
        },
      };
    },
    async prepareTerminalRuntimeInventory(candidate, signal) {
      validateTarget(candidate);
      await abortable(ensureEvents(), signal);
      for (let attempt = 0; attempt < 4; attempt++) {
        signal.throwIfAborted();
        const observed = revision;
        const resource = await readInventory(signal);
        if (observed !== revision) continue;
        let consumed = false;
        return {
          resource,
          consume() {
            if (consumed || retired || signal.aborted || observed !== revision) return null;
            consumed = true;
            return { ...resource, resourceRevision: revision };
          },
          dispose() {
            consumed = true;
          },
        };
      }
      throw new Error("Scoped topology changed during preparation");
    },
    adoptTerminalRuntimeInventory(prepared: PreparedTerminalRuntimeInventory, onResource) {
      const resource = prepared.consume();
      if (resource) sink = onResource;
      return resource;
    },
    refreshTerminalRuntimeInventory: refresh,
    selectApplicationShellFallback() {
      sink = null;
    },
    disposeEventSupervisor() {
      retired = true;
      sink = null;
      handlers.clear();
      catalogListeners.clear();
      lifetime.abort();
    },
    connectWorkspaceCatalog(candidate, invalidate) {
      validateTarget(candidate);
      catalogListeners.add(invalidate);
      return {
        ready: ensureEvents(),
        close() {
          catalogListeners.delete(invalidate);
        },
      };
    },
  };
}

export function createScopedTmuxServerCatalogPort(
  options: ScopedTmuxServerTransportOptions,
  transport: TerminalFirstDaemonTransport,
): WorkspaceClientCatalogPort {
  return {
    async read(target, signal) {
      transport.validateTarget(target);
      const barrier = transport.connectWorkspaceCatalog(target, () => undefined);
      try {
        await abortable(barrier.ready, signal);
      } finally {
        barrier.close();
      }
      const { scope, clientOptions } = options;
      const response = await (clientOptions.fetch ?? fetch)(
        new URL(
          `/api/v1/tmux-servers/${scope.serverId}/${scope.generation}/catalog`,
          clientOptions.baseUrl,
        ),
        {
          headers: { Authorization: `Bearer ${clientOptions.ownerToken}` },
          redirect: "error",
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok) throw new Error(`Scoped catalog unavailable (${response.status})`);
      const envelope = (await response.json()) as {
        version: number;
        server: unknown;
        resource: object;
      };
      const actual = TmuxServerScopeSchemaZ.parse(envelope.server);
      if (
        envelope.version !== 1 ||
        actual.serverId !== scope.serverId ||
        actual.generation !== scope.generation
      )
        throw new Error("Scoped catalog mismatch");
      transport.validateTarget(target);
      return WorkspaceCatalogResourceV2SchemaZ.parse({
        ...envelope.resource,
        version: 2,
        daemon: target.daemon,
      });
    },
    subscribe(target, invalidate) {
      return transport.connectWorkspaceCatalog(target, invalidate);
    },
  };
}

export function createScopedTmuxServerOwnerActions(
  options: ScopedTmuxServerTransportOptions,
  transport: TerminalFirstDaemonTransport,
): WorkspaceClientOwnerActionPort {
  const client = createTmuxServerClient(options.clientOptions, options.scope);
  return {
    async dispatch(request) {
      transport.validateTarget(request.target);
      if (request.name === "workspace.pane.create") {
        const intent = WorkspacePaneCreateArgumentsSchemaZ.parse(request.input);
        if (intent.workspaceName !== options.target.workspaceName)
          throw new Error("Scoped action workspace mismatch");
        const result = await client.createPane(request.operationId, intent, options.liveSessionId);
        transport.validateTarget(request.target);
        transport.refreshTerminalRuntimeInventory();
        return result as ActionResult<typeof request.name>;
      }
      const intent = WorkspaceMultiplexerIntentSchemaZ.parse({
        ...request.input,
        verb: request.name,
      });
      if (intent.workspaceName !== options.target.workspaceName)
        throw new Error("Scoped action workspace mismatch");
      const result = await client.mutate(request.operationId, intent, options.liveSessionId);
      transport.validateTarget(request.target);
      transport.refreshTerminalRuntimeInventory();
      return ActionContractsZ[request.name].result.parse(result) as ActionResult<
        typeof request.name
      >;
    },
  };
}
