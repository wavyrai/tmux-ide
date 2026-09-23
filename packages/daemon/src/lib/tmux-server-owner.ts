import { createNativeTmuxSessionCreator } from "./tmux-server-session-create.ts";
import type { WorkspacePaneCreateMutationRequest } from "@tmux-ide/contracts";
import { createTmuxSessionMutationFence } from "./tmux-session-mutation-fence.ts";
import { createNativeTmuxSessionOpener } from "./tmux-server-session-open.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { WorkspaceMultiplexerBackend } from "../command-center/actions/handlers/workspace-multiplexer.ts";
import { isVisibleFleetSession, type LiveSessionSummary } from "../command-center/discovery.ts";
import { WorkspaceTerminalInventoryRuntime } from "../terminal/attachments/native-runtime.ts";
import { createTmuxAgentStatusProbe } from "../terminal/attachments/agent-status-probe.ts";
import { createPaneStreamRuntime } from "../terminal/pane-stream/runtime.ts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";
import { SessionRuntimeRegistry } from "../terminal/session-runtime/registry.ts";
import { createSessionRuntimeMultiplexerBackend } from "../terminal/session-runtime/multiplexer-backend.ts";
import { TmuxExternalInteractionObserver } from "./tmux-external-interaction-observer.ts";
import { WorkspaceMultiplexerAuthority } from "./workspace-multiplexer-verbs.ts";
import {
  WorkspacePaneCreationAuthority,
  type WorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import {
  createServerGenerationFencedTmuxRunner,
  createServerGenerationFencedTmuxAsyncRunner,
  type NativeTmuxServerIdentity,
} from "./tmux-server-generation-runner.ts";

export interface NativeTmuxServerOwnerOptions {
  readonly serverId: string;
  readonly generation: string;
  readonly tmuxAuthority: WorkspacePaneTmuxAuthority;
  readonly stateDirectory: string;
  readonly webSocketUrl: string;
  readonly nativeServerIdentity?: NativeTmuxServerIdentity;
}

/** Refresh discovered live membership without changing durable workspace intent or aliases. */
export function createNativeTmuxServerCatalog(
  workspaceRegistry: WorkspaceRegistry,
  run: (args: readonly string[], signal?: AbortSignal) => Promise<string>,
  assertOpen: () => void = () => undefined,
): () => Promise<LiveSessionSummary[]> {
  return async (): Promise<LiveSessionSummary[]> => {
    assertOpen();
    const raw = await run(
      [
        "list-panes",
        "-a",
        "-F",
        "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}\t#{pane_id}\t#{session_path}",
      ],
      AbortSignal.timeout(2_000),
    );
    assertOpen();
    const rows = new Map<
      string,
      { summary: LiveSessionSummary; panes: Set<string>; dir: string }
    >();
    for (const line of raw.trim().split("\n")) {
      const [pid, id, created, name, pane, dir] = line.split("\t");
      if (
        !pid ||
        !/^\d+$/.test(pid) ||
        !id ||
        !/^\$\d+$/.test(id) ||
        !created ||
        !/^\d+$/.test(created) ||
        !name ||
        !pane ||
        !/^%\d+$/.test(pane) ||
        !dir
      )
        throw new Error("Invalid native server catalog");
      if (!isVisibleFleetSession(name)) continue;
      const liveSessionId = liveSessionIdForNativeIdentity(pid, id, created);
      const row = rows.get(liveSessionId) ?? {
        summary: { liveSessionId, sessionName: name, paneCount: 0 },
        panes: new Set<string>(),
        dir,
      };
      row.panes.add(pane);
      rows.set(liveSessionId, row);
    }
    const names = new Set([...rows.values()].map(({ summary }) => summary.sessionName));
    for (const workspace of workspaceRegistry.list())
      if (workspaceRegistry.isVolatile(workspace.name) && !names.has(workspace.sessionName))
        workspaceRegistry.remove(workspace.name);
    for (const { summary, dir } of rows.values())
      if (
        !workspaceRegistry.has(summary.sessionName) &&
        !workspaceRegistry.list().some((workspace) => workspace.sessionName === summary.sessionName)
      )
        workspaceRegistry.add({
          name: summary.sessionName,
          sessionName: summary.sessionName,
          projectDir: dir,
          persistence: "volatile",
        });
    return [...rows.values()].map(({ summary, panes }) => ({ ...summary, paneCount: panes.size }));
  };
}

/** One proven server incarnation. Never elects an endpoint or changes ambient tmux authority. */
export async function createNativeTmuxServerOwner(options: NativeTmuxServerOwnerOptions) {
  const generation = z.uuid().parse(options.generation);
  const authority = options.tmuxAuthority;
  if (authority.socketSelector.kind !== "path") {
    throw new Error("A server owner requires a proven direct socket authority");
  }
  const socketPath = authority.socketSelector.path;
  mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
  const workspaceRegistry = new WorkspaceRegistry({
    dir: options.stateDirectory,
    listSessions: () => [],
  });
  const sessionMutationFence = createTmuxSessionMutationFence();
  const generationRun = sessionMutationFence.wrap(
    createServerGenerationFencedTmuxRunner(authority, options.nativeServerIdentity),
  );
  const identityParts = generationRun(["display-message", "-p", "#{pid}\t#{start_time}"]).split(
    "\t",
  );
  const nativeServerIdentity = options.nativeServerIdentity ?? {
    pid: identityParts[0]!,
    startTime: identityParts[1]!,
  };
  const generationRunAsync = createServerGenerationFencedTmuxAsyncRunner(
    authority,
    nativeServerIdentity,
  );
  const multiplexer = new WorkspaceMultiplexerAuthority({
    daemonInstanceId: generation,
    registry: workspaceRegistry,
    tmuxAuthority: authority,
    io: { runTmux: generationRun },
  });
  const paneCreation = new WorkspacePaneCreationAuthority({
    daemonInstanceId: generation,
    registry: workspaceRegistry,
    tmuxAuthority: authority,
    io: { runTmux: generationRun },
  });
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let observerStarted: Promise<void> | null = null;
  let receiptSequence = 0;
  const assertOpen = () => {
    if (disposed) throw new Error("Tmux server owner is retired");
  };
  const sessionRuntimeRegistry: SessionRuntimeRegistry = new SessionRuntimeRegistry({
    generation,
    semanticMutations: {
      resolveSession: (name) => workspaceRegistry.get(name)?.sessionName ?? null,
      execute: (operationId, intent, timing) => {
        assertOpen();
        if (intent.verb === "workspace.pane.read") return multiplexer.readPane(operationId, intent);
        if (
          intent.verb === "workspace.window.link.select" ||
          intent.verb === "workspace.window.link.unlink" ||
          intent.verb === "workspace.pane.select"
        ) {
          return multiplexer.mutateWindowLink(
            { operationId, expectedDaemonInstanceId: generation, intent },
            (session, action) => sessionRuntimeRegistry.executeWindowLinkAction(session, action),
          );
        }
        return multiplexer.mutate(
          { operationId, expectedDaemonInstanceId: generation, intent },
          timing,
        );
      },
      publishReceipt: (receipt) => ({
        ...receipt,
        type: "interaction.receipt",
        sequence: ++receiptSequence,
      }),
      traceAuthority: { generation, incarnation: null },
    },
    mirror: {
      executable: authority.executablePath,
      socketPath,
      resolveSocketPath: () => generationRun(["display-message", "-p", "#{socket_path}"]),
      nativeServerIdentity,
      internalReadHookEmission: (pane, marker) => observer.internalReadHookEmission(pane, marker),
    },
  });
  const terminalInventoryRuntime = new WorkspaceTerminalInventoryRuntime({
    registry: workspaceRegistry,
    sessionRuntimeRegistry,
    tmuxAuthority: { ...authority, trustedCwd: options.stateDirectory, nativeServerIdentity },
    agentStatusProbeFactory: ({ run }) => createTmuxAgentStatusProbe({ run }),
    onInventory: (snapshot) => multiplexer.adoptPaneInventory(snapshot.panes),
    onSessionInventory: (session, snapshot) =>
      multiplexer.adoptSessionPaneInventory(session, snapshot?.panes ?? []),
  });
  const observer: TmuxExternalInteractionObserver = new TmuxExternalInteractionObserver({
    daemonInstanceId: generation,
    internalReadOwnerToken: randomUUID(),
    registry: workspaceRegistry,
    tmuxAuthority: authority,
    io: { runTmux: generationRunAsync },
    onGap: () => terminalInventoryRuntime.invalidate(),
    onObserved: ({ workspaceName, semanticPaneId, operationKind, operationId }) =>
      operationId !== null &&
      sessionRuntimeRegistry.observeTmuxInteraction({
        workspaceName,
        semanticPaneId,
        operationKind,
        operationId,
      }),
  });
  const paneStreamRuntime = createPaneStreamRuntime({
    daemonInstanceId: generation,
    webSocketUrl: options.webSocketUrl,
    sessionRuntimeRegistry,
    semanticPaneCatalog: terminalInventoryRuntime.semanticPaneCatalog,
  });
  const backend = createSessionRuntimeMultiplexerBackend({
    registry: sessionRuntimeRegistry,
    resolveSession: (name) => workspaceRegistry.get(name)?.sessionName ?? null,
  });
  const catalog = createNativeTmuxServerCatalog(workspaceRegistry, generationRunAsync, assertOpen);
  const sessionCreator = createNativeTmuxSessionCreator({
    generation,
    registry: workspaceRegistry,
    run: generationRun,
    assertOpen,
  });
  const sessionOpener = createNativeTmuxSessionOpener({
    generation,
    registry: workspaceRegistry,
    run: generationRunAsync,
    assertOpen,
  });
  const openSession = async (liveSessionId: string) => {
    await catalog();
    const result = await sessionOpener.openSession(liveSessionId);
    terminalInventoryRuntime.invalidate();
    return result;
  };
  const multiplexerBackend: WorkspaceMultiplexerBackend = {
    mutate: async (...args) => {
      assertOpen();
      if (args[0].expectedDaemonInstanceId !== generation)
        throw new Error("Tmux server generation mismatch");
      await catalog();
      observerStarted ??= observer.start();
      await observerStarted;
      assertOpen();
      return backend.mutate(...args);
    },
  };
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      await sessionOpener.dispose();
      await sessionCreator.dispose();
      await paneCreation.dispose();
      try {
        await paneStreamRuntime.dispose();
      } finally {
        try {
          await observer.dispose();
        } finally {
          terminalInventoryRuntime.dispose();
          try {
            await multiplexer.dispose();
          } finally {
            await sessionRuntimeRegistry.dispose();
          }
        }
      }
    })();
    return disposePromise;
  };
  try {
    await terminalInventoryRuntime.whenReady();
    await catalog();
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    serverId: options.serverId,
    generation,
    catalog,
    openSession,
    createSession: sessionCreator.createSession,
    createSessionPane: async (
      liveSessionId: string,
      request: WorkspacePaneCreateMutationRequest,
    ) => {
      assertOpen();
      await catalog();
      const sessionName = workspaceRegistry.get(request.intent.workspaceName)?.sessionName;
      if (!sessionName) throw new Error("Selected workspace is unavailable");
      const result = await sessionMutationFence.execute({
        liveSessionId,
        sessionName,
        run: generationRunAsync,
        mutate: () => paneCreation.create(request),
      });
      terminalInventoryRuntime.invalidate();
      return result;
    },
    mutateSession: async (
      liveSessionId: string,
      request: Parameters<WorkspaceMultiplexerBackend["mutate"]>[0],
      authenticatedHostClientId?: string,
    ) => {
      assertOpen();
      await catalog();
      const sessionName = workspaceRegistry.get(request.intent.workspaceName)?.sessionName;
      if (!sessionName) throw new Error("Selected workspace is unavailable");
      observerStarted ??= observer.start();
      await observerStarted;
      return sessionMutationFence.execute({
        liveSessionId,
        sessionName,
        run: generationRunAsync,
        mutate: () =>
          multiplexerBackend.mutate(request, authenticatedHostClientId, undefined, true),
      });
    },
    workspaceRegistry,
    multiplexerBackend,
    sessionRuntimeRegistry,
    terminalInventoryRuntime,
    paneStreamRuntime,
    dispose,
  };
}

export type NativeTmuxServerOwner = Awaited<ReturnType<typeof createNativeTmuxServerOwner>>;
