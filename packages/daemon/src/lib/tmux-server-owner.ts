import { execFileSync } from "node:child_process";
import { requireSupportedTmuxVersion } from "./tmux-version.ts";
import { PaneSourceDiscovery } from "./pane-source-discovery.ts";
import { createBackgroundNativeCapture } from "./background-native-capture.ts";
import { createOwnedViewerAdapterFactory } from "./owned-viewer-factory.ts";
import { createAuthoredNativeCommandRunner } from "./authored-native-command-runner.ts";
import { AuthoredNativeReceiptEnricher } from "./authored-native-receipt-staging.ts";
import {
  OwnerInteractionObservation,
  nativeInteractionObservationRequested,
} from "./owner-interaction-observation.ts";
import type { SessionRuntimeAutomationAuthority } from "../terminal/session-runtime/semantic-mutation-executor.ts";
import type { SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import {
  PaneSourceCredentialAuthority,
  STARTUP_PANE_CREDENTIAL_TIMEOUT_MS,
} from "./pane-source-credentials.ts";
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
import { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import { InteractionEvidenceAuthority } from "./interaction-evidence-authority.ts";
import {
  createTmuxInteractionObservationHandler,
  externalTmuxInteractionDraft,
} from "./tmux-interaction-observation-handler.ts";
import { WorkspaceMultiplexerAuthority } from "./workspace-multiplexer-verbs.ts";
import {
  WorkspacePaneCreationAuthority,
  createPinnedWorkspaceTmuxRunner,
  type WorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import {
  createServerGenerationFencedTmuxRunner,
  createServerGenerationFencedTmuxAsyncRunner,
  type NativeTmuxServerIdentity,
} from "./tmux-server-generation-runner.ts";

export interface NativeTmuxServerOwnerOptions {
  readonly environmentId: string;
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
  requireSupportedTmuxVersion(
    execFileSync(authority.executablePath, ["-V"], { encoding: "utf8", timeout: 3000 }),
  );
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
  requireSupportedTmuxVersion(generationRun(["display-message", "-p", "#{version}"]));
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
    io: {
      runTmux: generationRun,
      runAuthoredNative: createAuthoredNativeCommandRunner({
        environmentId: options.environmentId,
        serverScope: { serverId: options.serverId, generation },
        sessionGuard: () => sessionMutationFence.snapshot(),
        observation: () => observationSelector,
        runPinnedTmux: createPinnedWorkspaceTmuxRunner(authority, { timeoutMs: 5_000 }),
      }),
    },
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
  const interactionReceipts = new InteractionReceiptJournal();
  const interactionEvidence = new InteractionEvidenceAuthority(options.environmentId, {
    serverId: options.serverId,
    generation,
  });
  const interactionObservation = new InteractionObservationStatusStore(options.environmentId, {
    serverId: options.serverId,
    generation,
  });
  const authoredReceiptEnricher = new AuthoredNativeReceiptEnricher({
    journal: interactionReceipts,
    publishRaw: (evidence) => interactionReceipts.appendEvidence(evidence),
    noteGap: () => observationSelector.noteOwnedOperationUncertainty(),
    onFailure: () => observationSelector.failOwnedOperationObservation(),
  });
  const observationSelector = new OwnerInteractionObservation({
    environmentId: options.environmentId,
    serverScope: { serverId: options.serverId, generation },
    tmuxAuthority: authority,
    nativeServerIdentity,
    enabled: nativeInteractionObservationRequested(),
    status: interactionObservation,
    onOwnedPlanComplete: (proof) => {
      sessionRuntimeRegistry.observeOwnedNativePlan(proof);
    },
    publishOwnedEvidence: (decision) => authoredReceiptEnricher.consume(decision),
    publishEvidence: (evidence) => {
      interactionReceipts.appendEvidence(evidence);
    },
  });
  const assertOpen = () => {
    if (disposed) throw new Error("Tmux server owner is retired");
  };
  const credentialLifetime = new AbortController();
  const sourceCredentials = new PaneSourceCredentialAuthority({
    run: (args) => {
      assertOpen();
      return generationRun(args);
    },
    runAsync: async (args, signal) => {
      assertOpen();
      const output = await generationRunAsync(
        args,
        AbortSignal.any([credentialLifetime.signal, ...(signal ? [signal] : [])]),
      );
      assertOpen();
      return output;
    },
  });
  const sourceDiscovery = new PaneSourceDiscovery(sourceCredentials, () =>
    workspaceRegistry.list(),
  );
  const sessionRuntimeRegistry: SessionRuntimeRegistry = new SessionRuntimeRegistry({
    generation,
    semanticMutations: {
      captureInteractionContext: (intent) => ({
        destination:
          ("semanticPaneId" in intent &&
            interactionEvidence.captureAuthoredEndpoint(
              intent.workspaceName,
              intent.semanticPaneId,
            )) ||
          interactionEvidence.captureUnavailableEndpoint(),
        source: null,
      }),
      validateInteractionContext: (context) => {
        if (
          context.destination.kind !== "pane" ||
          !interactionEvidence.isCurrent(context.destination)
        )
          throw new Error("Interaction target lifetime is no longer current");
      },
      resolveSession: (name) => workspaceRegistry.get(name)?.sessionName ?? null,
      execute: (operationId, intent, timing, execution) => {
        assertOpen();
        if (intent.verb === "workspace.pane.read")
          return multiplexer.readPane(operationId, intent, execution);
        if (
          intent.verb === "workspace.window.link.select" ||
          intent.verb === "workspace.window.link.unlink" ||
          intent.verb === "workspace.pane.select"
        ) {
          return multiplexer.mutateWindowLink(
            { operationId, expectedDaemonInstanceId: generation, intent },
            (session, action) => sessionRuntimeRegistry.executeWindowLinkAction(session, action),
            timing,
          );
        }
        if (intent.verb === "workspace.pane.resize") {
          return multiplexer.mutateResize(
            { operationId, expectedDaemonInstanceId: generation, intent },
            (session) => {
              if (!sessionRuntimeRegistry) throw new Error("Session runtime unavailable");
              return sessionRuntimeRegistry.paneResizeTransport(session);
            },
          );
        }
        return multiplexer.mutate(
          { operationId, expectedDaemonInstanceId: generation, intent },
          timing,
          execution,
        );
      },
      publishReceipt: (receipt) => interactionReceipts.publish(receipt),
      traceAuthority: { generation, incarnation: null },
    },
    mirror: {
      createOwnedViewerAdapter: createOwnedViewerAdapterFactory({
        environmentId: options.environmentId,
        serverScope: { serverId: options.serverId, generation },
        observation: observationSelector,
        status: interactionObservation,
      }),
      executable: authority.executablePath,
      socketPath,
      resolveSocketPath: () => generationRun(["display-message", "-p", "#{socket_path}"]),
      nativeServerIdentity,
      internalReadHookEmission: (pane, marker) => observer.internalReadHookEmission(pane, marker),
    },
  });
  const backgroundCapture = createBackgroundNativeCapture({
    environmentId: options.environmentId,
    serverScope: { serverId: options.serverId, generation },
    observation: () => observationSelector,
    runPinnedTmux: generationRunAsync,
  });
  const terminalInventoryRuntime = new WorkspaceTerminalInventoryRuntime({
    registry: workspaceRegistry,
    sessionRuntimeRegistry,
    tmuxAuthority: { ...authority, trustedCwd: options.stateDirectory, nativeServerIdentity },
    agentStatusProbeFactory: ({ run }) =>
      createTmuxAgentStatusProbe({
        run,
        captureNative: (pane, signal) =>
          backgroundCapture(
            {
              paneId: pane.runtimePaneId,
              nativeIdentity: pane.nativeIdentity ?? null,
              mode: "agent-status",
            },
            signal,
          ),
      }),
    nativeServerEpoch: () => observationSelector.nativeServerEpoch ?? null,
    resolveInteractionEndpoint: (workspaceName, semanticPaneId) =>
      interactionEvidence?.captureAuthoredEndpoint(workspaceName, semanticPaneId) ?? null,
    onInventory: async (snapshot, signal) => {
      multiplexer.adoptPaneInventory(snapshot.panes);
      interactionEvidence.adoptInventory(snapshot.panes);
      await sourceDiscovery.prepare(
        snapshot.panes.map((pane) => ({
          ...pane,
          paneLifetimeId: pane.semanticPaneId
            ? (interactionEvidence?.captureInventoryEndpoint(
                pane.sessionName,
                pane.runtimePaneId,
                pane.semanticPaneId,
              )?.paneLifetimeId ?? null)
            : null,
        })),
        signal,
      );
    },
    onSessionInventory: async (session, snapshot, signal) => {
      multiplexer.adoptSessionPaneInventory(session, snapshot?.panes ?? []);
      interactionEvidence.adoptSessionInventory(session, snapshot?.panes ?? []);
      if (snapshot)
        await sourceDiscovery.prepare(
          snapshot.panes.map((pane) => ({
            ...pane,
            paneLifetimeId: pane.semanticPaneId
              ? (interactionEvidence?.captureInventoryEndpoint(
                  pane.sessionName,
                  pane.runtimePaneId,
                  pane.semanticPaneId,
                )?.paneLifetimeId ?? null)
              : null,
          })),
          signal,
        );
    },
  });
  const observer: TmuxExternalInteractionObserver = new TmuxExternalInteractionObserver({
    daemonInstanceId: generation,
    onAvailability: (available) => observationSelector.stockAvailable(available),
    onGap: (gap) => {
      terminalInventoryRuntime.invalidate();
      observationSelector.stockGap(
        gap.reason === "overflow"
          ? "retention-overflow"
          : gap.reason === "hooks-replaced"
            ? "hooks-replaced"
            : "uncertain-consume",
      );
    },
    internalReadOwnerToken: randomUUID(),
    registry: workspaceRegistry,
    tmuxAuthority: authority,
    io: { runTmux: generationRunAsync },
    resolveCapturedTarget: (target) => {
      const endpoint = interactionEvidence.captureObservedEndpoint(target);
      return endpoint.kind === "pane" ? endpoint : null;
    },
    onUnresolvedObservation: () => {
      observationSelector.stockGap("unresolved-target", 1);
      terminalInventoryRuntime.invalidate();
    },
    onObserved: createTmuxInteractionObservationHandler({
      invalidateInventory: () => terminalInventoryRuntime.invalidate(),
      consumeAuthored: (observation) =>
        sessionRuntimeRegistry.observeTmuxInteraction({
          ...observation,
          operationId: observation.operationId!,
        }),
      publishExternal: (observation) => {
        if (!observationSelector.allowStockPublication()) return;
        interactionReceipts.publish(
          externalTmuxInteractionDraft(
            observation,
            observation.capturedTarget
              ? interactionEvidence.captureObservedEndpoint(observation.capturedTarget)
              : interactionEvidence.captureUnavailableEndpoint(),
          ),
        );
      },
      reportPublicationFailure: () => {
        terminalInventoryRuntime.invalidate();
      },
    }),
  });
  const paneStreamRuntime = createPaneStreamRuntime({
    daemonInstanceId: generation,
    webSocketUrl: options.webSocketUrl,
    sessionRuntimeRegistry,
    semanticPaneCatalog: terminalInventoryRuntime.semanticPaneCatalog,
  });
  const backend = createSessionRuntimeMultiplexerBackend({
    resolvePaneSourceCredential: (credential, session, claimed) =>
      sourceCredentials.resolve(credential, session, claimed),
    resolvePaneSourceBinding: (credential, session, claimed) => {
      const grant = sourceCredentials.resolveBinding(credential, session, claimed);
      return grant ? interactionEvidence.captureSourceBinding(grant) : null;
    },
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
    credentialLifetime.abort();
    sourceCredentials.dispose();
    authoredReceiptEnricher.dispose();
    const observationDisposal = observationSelector.dispose();
    disposePromise = (async () => {
      const failures: unknown[] = [];
      for (const close of [
        () => observationDisposal,
        () => sessionOpener.dispose(),
        () => sessionCreator.dispose(),
        () => paneCreation.dispose(),
        () => paneStreamRuntime.dispose(),
        () => observer.dispose(),
        () => terminalInventoryRuntime.dispose(),
        () => multiplexer.dispose(),
        () => sessionRuntimeRegistry.dispose(),
        () => interactionReceipts.dispose(),
        () => interactionEvidence.dispose(),
        () => interactionObservation.dispose(),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Tmux server owner retirement failed");
    })();
    return disposePromise;
  };
  try {
    await terminalInventoryRuntime.whenReady();
    await catalog();
    await terminalInventoryRuntime.discoverTerminalInventory();
    // One bounded startup pass, sequential to cap subprocess concurrency. New
    // panes/sessions are reconciled on demand, never by a credential poller.
    const startupSignal = AbortSignal.timeout(STARTUP_PANE_CREDENTIAL_TIMEOUT_MS);
    for (const workspace of workspaceRegistry.list()) {
      if (startupSignal.aborted) break;
      try {
        await sourceCredentials.reconcileSessionAsync(workspace.sessionName, startupSignal);
      } catch {
        // A failed grant is unavailable; request-time reconciliation can retry.
      }
    }
    await observationSelector.start();
    observerStarted ??= observer.start();
    await observerStarted;
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
    submitAutomationIntent: (
      operationId: string,
      intent: SessionRuntimeSemanticIntent,
      authority: SessionRuntimeAutomationAuthority,
    ) => {
      assertOpen();
      return sessionRuntimeRegistry.submitAutomationIntent(operationId, intent, authority);
    },
    workspaceRegistry,
    interactionReceipts,
    get interactionObservation(): InteractionObservationStatusStore | null {
      return disposed ? null : interactionObservation;
    },
    get interactionEvidence(): InteractionEvidenceAuthority | null {
      return disposed ? null : interactionEvidence;
    },
    resolveInteractionSource: (
      credential: string,
      workspaceName: string,
      claimedSemanticPaneId: string,
    ): ReturnType<InteractionEvidenceAuthority["captureSourceBinding"]> => {
      if (disposed) return null;
      const session = workspaceRegistry.get(workspaceName)?.sessionName;
      if (!session) return null;
      const grant = sourceCredentials.resolveBinding(credential, session, claimedSemanticPaneId);
      return grant ? interactionEvidence.captureSourceBinding(grant) : null;
    },
    multiplexerBackend,
    sessionRuntimeRegistry,
    terminalInventoryRuntime,
    paneStreamRuntime,
    dispose,
  };
}

export type NativeTmuxServerOwner = Awaited<ReturnType<typeof createNativeTmuxServerOwner>>;
