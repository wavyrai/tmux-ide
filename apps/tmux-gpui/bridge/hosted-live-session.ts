import { releaseLiveSessionResources } from "./live-session-resources.ts";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  TERMINAL_GRAPHICS_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_CELL_PIXELS_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_PRECISE_PIXELS_CAPABILITY_VERSION,
  TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import type { WindowLinkTopology } from "../../../packages/contracts/src/window-links.ts";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamClientSocket,
  type PaneStreamRuntimeClient,
} from "../../../packages/daemon-client/src/pane-stream-client.ts";
import {
  createTmuxServerClient,
  requestHistoryAnchor,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { GENERIC_PANE_ACTION_ERROR } from "./agent-launch-guidance.ts";
import { createClosePanePreflight } from "./close-pane.ts";
import { connectionSchema, paneStreamSocketUrl } from "./config.ts";
import { windowForLayout } from "./geometry.ts";
import { createHistoryRestoration } from "./history-restoration.ts";
import { createHistoryViewport } from "./history.ts";
import { createHostedCommandQueue } from "./hosted-command-queue.ts";
import { runHostedLiveCommands } from "./hosted-live-commands.ts";
import type { HostedLiveOptions } from "./hosted-live-types.ts";
import { createHostedSessionLifecycle } from "./hosted-session-lifecycle.ts";
import { createInputPipeline } from "./input-pipeline.ts";
import { createKittyGraphicsReceiver } from "./kitty-graphics.ts";
import { createLiveDiagnostics } from "./live-diagnostics.ts";
import { createLiveWindowSettle } from "./live-window-settle.ts";
import { createMouseOwner } from "./mouse.ts";
import { createNewWindowExecutor } from "./new-window.ts";
import { createSourceFaultFence } from "./offscreen-source-fault.ts";
import { createPaneActionExecutor, createPaneActionFence } from "./pane-actions.ts";
import { createPaneResizeFence } from "./pane-resize.ts";
import { createReplica } from "./replica.ts";
import { createResizeGestureOwner } from "./resize-gesture.ts";
import { selectedWindowSurfaces } from "./selected-window-surfaces.ts";
import { createSelectionIdentity } from "./selection-identity.ts";
import { createSplitGestureOwner } from "./split-gesture.ts";
import { createSplitLayoutReader } from "./split-layout.ts";
import type { Layout } from "./topology.ts";
import { contentRect } from "./window-canvas.ts";

const selectPaneSchema = z
  .object({ kind: z.literal("select-pane"), id: z.string().min(1).max(512) })
  .strict();

export function createHostedLiveSession(options: HostedLiveOptions) {
  const commands = createHostedCommandQueue();
  let failed = false;
  let closed = false;
  const fail = () => {
    failed = true;
  };
  const interactive = options.mode === "interactive";
  const catalogOnly = options.mode === "catalog";
  const diagnostics = createLiveDiagnostics(options.diagnostic ?? (() => {}));
  const inputPipeline = createInputPipeline(() => {
    if (!stopped) diagnostics.report("runtime-failure");
    fail();
    stop();
  });
  let ready = false;
  let runtime: PaneStreamRuntimeClient | undefined;
  let disposeClient: (() => void) | undefined;
  let splitGesture: ReturnType<typeof createSplitGestureOwner> | undefined;
  const viewport = createHistoryViewport();
  let historyRestoration: ReturnType<typeof createHistoryRestoration> | undefined;
  let restorePending = false;
  const mouseOwner = createMouseOwner();
  const mouseIdentity = () =>
    JSON.stringify([
      connection,
      presentationEpoch,
      selectedActionPane ? lifetimes.get(selectedActionPane) : null,
      currentResizeToken,
    ]);
  const replicas = new Map<string, ReturnType<typeof createReplica>>();
  const surfaces = new Map<
    string,
    import("../../../packages/contracts/src/index.ts").TerminalReplicaSnapshot
  >();
  const lifetimes = new Map<string, string | null>();
  let presentationEpoch = 0;
  let stopped = false;
  let sequence = 0;
  let semanticWindow: string | null = null;
  let layouts: Layout[] = [];
  let resizeBlocked = false;
  let windowLinks: WindowLinkTopology | null = null;
  let splitReader: ReturnType<typeof createSplitLayoutReader> | undefined;
  let resizeGesture: ReturnType<typeof createResizeGestureOwner> | undefined;
  let gesturePublishQueued = false;
  const resizeFence = createPaneResizeFence();
  let currentResizeToken: string | null = null;
  const actionFence = createPaneActionFence();
  const executePaneAction = createPaneActionExecutor();
  const prepareClose = createClosePanePreflight();
  let closePaneReady: {
    token: string;
    id: string;
    presenceRevision: number;
    hostClientId: string;
  } | null = null;
  const executeNewWindow = createNewWindowExecutor();
  let newWindowReceipt: {
    token: string;
    result: import("../../../packages/contracts/src/workspace-pane-creation.ts").WorkspacePaneCreateMutationResult;
  } | null = null;
  let actionBusy = false;
  let actionFailed = false;
  let actionFailureMessage = GENERIC_PANE_ACTION_ERROR;
  let paneSplitReceipt: {
    token: string;
    result: import("../../../packages/contracts/src/workspace-multiplexer.ts").WorkspaceWindowSplitResult;
  } | null = null;
  let selectedActionPane: string | null = null;
  let foreground = false;
  let presenceRevision = 0;
  let admittedPresenceRevision = 0;
  const connection = randomUUID();
  let catalogReceived = false;
  const latest: {
    snapshot: import("../../../packages/contracts/src/index.ts").TerminalReplicaSnapshot | null;
  } = { snapshot: null };
  const selectionIdentity = createSelectionIdentity();
  const kitty = createKittyGraphicsReceiver({
    known: options.knownDigests ?? [],
    request: (pane, digests) => runtime?.requestTerminalGraphics(pane, digests),
    emit: (line) => emit(JSON.parse(line)),
    emitChunk: (chunk) => emit({ rawKittyImage: chunk }),
  });
  // The window's cell size in device pixels, forwarded once the daemon accepts it.
  let cellPixels: {
    width: number;
    height: number;
    precise?: { width: number; height: number };
  } | null = null;
  let appliedCellPixels = "";
  function applyCellPixels() {
    if (!cellPixels || !runtime || !kitty.takesCellPixels()) return;
    const precise = kitty.takesPreciseCellPixels() ? cellPixels.precise : undefined;
    const key = JSON.stringify([cellPixels.width, cellPixels.height, precise]);
    if (key === appliedCellPixels) return;
    appliedCellPixels = key;
    try {
      runtime.setTerminalCellPixels(cellPixels.width, cellPixels.height, precise);
    } catch {
      appliedCellPixels = "";
    }
  }
  const windowSettle = createLiveWindowSettle({ stopped: () => stopped, surfaces, publish });
  function output(snapshot: typeof latest.snapshot) {
    if (catalogOnly && !catalogReceived && !stopped) return;
    latest.snapshot = snapshot;
    const inputReady =
      foreground &&
      !stopped &&
      !restorePending &&
      historyRestoration?.publication().state !== "restoring" &&
      viewport.offset === 0 &&
      !!runtime?.ownsConnectionAuthority("input");
    const resizeLayout = layouts.find((l) => l.semanticWindowId === semanticWindow);
    const matchingLinks =
      windowLinks?.links.filter((link) => link.semanticWindowId === semanticWindow) ?? [];
    const selectedLink =
      matchingLinks.find((link) => link.linkId === windowLinks?.activeLinkId) ??
      (matchingLinks.length === 1 ? matchingLinks[0] : null);
    splitReader?.update(
      inputReady && selectedLink && windowLinks
        ? {
            liveSessionId: windowLinks.liveSessionId,
            linkId: selectedLink.linkId,
            linkRevision: windowLinks.linkRevision,
            expectedSemanticWindowId: selectedLink.semanticWindowId,
          }
        : null,
      resizeLayout,
      presentationEpoch,
    );
    currentResizeToken = resizeFence(resizeLayout, presentationEpoch);
    mouseOwner.observe(inputReady ? snapshot : null, mouseIdentity());
    resizeGesture?.observe();
    splitGesture?.observe();
    // State changes within one event-loop turn (a frame and the gesture it settles)
    // share one publication; the final publication is never deferred.
    unpublished = true;
    if (stopped) publish();
    else if (!publicationQueued) {
      publicationQueued = true;
      publicationTask = setImmediate(() => {
        publicationTask = undefined;
        publicationQueued = false;
        publish();
      });
    }
  }
  let unpublished = false;
  let publicationQueued = false;
  let publicationTask: ReturnType<typeof setImmediate> | undefined;
  function publish() {
    if (!unpublished) return;
    const snapshot = latest.snapshot;
    const inputReady =
      foreground &&
      !stopped &&
      !restorePending &&
      historyRestoration?.publication().state !== "restoring" &&
      viewport.offset === 0 &&
      !!runtime?.ownsConnectionAuthority("input");
    const resizeLayout = layouts.find((l) => l.semanticWindowId === semanticWindow);
    if (windowSettle.hold(resizeLayout)) return;
    unpublished = false;
    const { surfaces: published = [], ...fields } =
      interactive || catalogOnly
        ? {
            inputReady,
            presentationEpoch,
            selectedPane: selectedActionPane,
            ...(catalogOnly ? { catalogReady: catalogReceived && !stopped } : {}),
            resizeBlocked,
            splitLayout: splitReader?.current() ?? null,
            splitGesture: splitGesture?.publication() ?? null,
            resizeGestureSupported: true,
            resizeGesture: resizeGesture?.publication() ?? null,
            paneActions:
              inputReady && !actionBusy && !actionFailed && selectedActionPane
                ? actionFence.current(
                    resizeLayout,
                    selectedActionPane,
                    lifetimes.get(selectedActionPane),
                  )
                : null,
            paneSplitReceipt,
            newWindowReceipt,
            closePaneReady:
              inputReady &&
              runtime?.ownsConnectionAuthority("geometry") &&
              !!closePaneReady &&
              closePaneReady.token ===
                actionFence.current(
                  resizeLayout,
                  closePaneReady.id,
                  lifetimes.get(closePaneReady.id),
                )?.token
                ? closePaneReady
                : null,
            paneActionError: actionFailed ? actionFailureMessage : null,
            resizeToken: currentResizeToken,
            selectionIdentity: selectionIdentity(
              stopped || catalogOnly
                ? null
                : ((selectedActionPane ? replicas.get(selectedActionPane)?.current() : null) ??
                    null),
              snapshot,
              viewport.offset,
              viewport.captureIndex(),
              restorePending
                ? { state: "restoring", token: null }
                : (historyRestoration?.publication() ?? null),
            ),
            scrollOffset: viewport.offset,
            historyReady:
              foreground &&
              !stopped &&
              !restorePending &&
              historyRestoration?.publication().state !== "restoring" &&
              viewport.offset > 0 &&
              !!runtime?.ownsConnectionAuthority("input"),
            historyAnchor: restorePending
              ? { state: "restoring", token: null }
              : (historyRestoration?.publication() ?? null),
            presenceRevision,
            layouts,
            surfaces: catalogOnly
              ? []
              : selectedWindowSurfaces(layouts, selectedActionPane, surfaces),
          }
        : {};
    const graphics = published.flatMap(({ paneId, snapshot }) => {
      const placements = kitty.placements(paneId, snapshot);
      return placements.length > 0 ? [{ paneId, placements }] : [];
    });
    emit({
      connection,
      sequence: ++sequence,
      ...fields,
      graphics,
      snapshot: catalogOnly ? null : snapshot,
      ...(interactive || catalogOnly ? { surfaces: published } : {}),
    });
  }
  function emit(event: Parameters<HostedLiveOptions["emit"]>[0]) {
    if (closed) return false;
    try {
      return options.emit(event);
    } catch {
      fail();
      if (!stopped) stop();
    }
  }
  const retirement = createHostedSessionLifecycle<never, void>({
    signal: options.signal,
    dispatch: () => {},
    unavailable: () => undefined,
    emit: () => output(null),
    drain: (signal) => options.drain?.(signal),
    revoke: () => {
      stopped = true;
      commands.close();
      windowSettle.cancel();
      clearImmediate(publicationTask);
      // A faulty disposer must not leave a later authority/resource alive.
      const failures: unknown[] = [];
      for (const release of [
        () => inputPipeline.retire(),
        () => resizeGesture?.retire(),
        () => splitReader?.dispose(),
        () => splitGesture?.retire(),
        () => historyRestoration?.dispose(),
        () => disposeClient?.(),
        () => runtime?.close(),
        () => releaseLiveSessionResources({ replicas, kitty, viewport, surfaces, lifetimes }),
      ]) {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length) throw new AggregateError(failures, "Session revocation failed");
    },
    close: () => {
      closed = true;
      options.close?.();
    },
    onRetired: (result) => {
      if (result.timedOut || result.failures.length) fail();
    },
  });
  function stop() {
    void retirement.dispose();
  }
  async function run() {
    try {
      if (stopped) return;
      const config = connectionSchema.parse(options.config);
      // In-window reselect retargets this helper; every input/history path reads it.
      let selected = config.semanticPaneId;
      selectedActionPane = selected;
      const sourceFaultFence = createSourceFaultFence(
        () => selected,
        () => layouts,
      );
      const stopForVisibleSourceFault = () => {
        const reason = sourceFaultFence.currentFailure();
        if (!reason) return false;
        diagnostics.sourceFault(reason);
        stop();
        return true;
      };
      const visiblePaneIds = config.visiblePaneIds ?? [selected];
      if (
        !visiblePaneIds.includes(selected) ||
        new Set(visiblePaneIds).size !== visiblePaneIds.length
      )
        throw new Error("Invalid visible pane subscription");
      resizeGesture = createResizeGestureOwner({
        runtime: () => runtime ?? null,
        current: (id, axis) => {
          const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
          const pane = layout?.panes.find((p) => p.pane === id);
          const lifetime = lifetimes.get(id);
          if (
            stopped ||
            !foreground ||
            viewport.offset !== 0 ||
            !latest.snapshot ||
            !runtime?.ownsConnectionAuthority("input") ||
            !visiblePaneIds.includes(id) ||
            !surfaces.has(id) ||
            !pane ||
            !layout?.semanticWindowId ||
            !lifetime
          )
            return null;
          const token = resizeFence(layout, presentationEpoch);
          return token
            ? {
                token,
                generation: config.scope.generation,
                workspace: config.workspaceName,
                window: layout.semanticWindowId,
                lifetime,
                presentationEpoch,
                statusRows: pane.height - contentRect(layout, pane).rows,
                layout,
                cells: axis === "cols" ? pane.width : pane.height,
                geometryOwned: runtime.ownsConnectionAuthority("geometry"),
                coherent: layout.panes.every((p) => {
                  const frame = p.pane ? surfaces.get(p.pane) : undefined;
                  const rect = contentRect(layout, p);
                  return !!frame && frame.cols === p.width && frame.rows === rect.rows;
                }),
              }
            : null;
        },
        changed: () => {
          if (gesturePublishQueued || stopped) return;
          gesturePublishQueued = true;
          queueMicrotask(() => {
            gesturePublishQueued = false;
            if (!stopped) output(latest.snapshot);
          });
        },
      });
      const origin = "tmux-ide://app";
      const hostClientId = `gpui:${randomUUID()}`;
      const client = createTmuxServerClient(
        {
          ...config,
          origin,
          hostClientId,
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal: AbortSignal.any([
                retirement.context.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
        },
        config.scope,
      );
      restorePending = !!config.historyAnchor;
      historyRestoration = createHistoryRestoration({
        current: () =>
          (selectedActionPane ? replicas.get(selectedActionPane)?.current() : null) ?? null,
        read: async (proof, operation, signal) => {
          const identity = {
            workspaceName: proof.workspaceName,
            semanticPaneId: proof.semanticPaneId,
            generation: proof.generation,
            incarnation: proof.incarnation,
          };
          const input =
            operation.kind === "capture"
              ? { version: 1 as const, liveSessionId: config.liveSessionId, proof, operation }
              : {
                  version: 1 as const,
                  liveSessionId: config.liveSessionId,
                  proof: identity,
                  operation,
                };
          return (
            (
              await requestHistoryAnchor(
                { ...config, origin, hostClientId, timeoutMs: 2000 },
                config.scope,
                input,
                signal,
              )
            )?.result ?? null
          );
        },
        restore: (row) => {
          const view = viewport.restoreRow(row);
          if (!view) return false;
          surfaces.set(selected, view);
          latest.snapshot = view;
          return true;
        },
        changed: () => {
          if (!stopped) output(surfaces.get(selected) ?? null);
        },
      });

      if (config.historyUnavailable) historyRestoration.unavailable();
      disposeClient = () => client.dispose();
      splitReader = createSplitLayoutReader({
        read: async (target, signal) =>
          (await client.windowSplitLayout(config.workspaceName, target, signal)).resource,
        changed: () => {
          if (gesturePublishQueued || stopped) return;
          gesturePublishQueued = true;
          queueMicrotask(() => {
            gesturePublishQueued = false;
            if (!stopped) output(latest.snapshot);
          });
        },
      });
      splitGesture = createSplitGestureOwner({
        runtime: () => runtime ?? null,
        current: () => {
          const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
          const matches =
            windowLinks?.links.filter((link) => link.semanticWindowId === semanticWindow) ?? [];
          const link =
            matches.find((link) => link.linkId === windowLinks?.activeLinkId) ??
            (matches.length === 1 ? matches[0] : null);
          if (
            stopped ||
            !foreground ||
            viewport.offset !== 0 ||
            !latest.snapshot ||
            !runtime?.ownsConnectionAuthority("input") ||
            !windowLinks ||
            !link ||
            !layout ||
            layout.zoomed ||
            layout.panes.some((p) => !p.pane || !lifetimes.get(p.pane))
          )
            return null;
          return {
            generation: config.scope.generation,
            workspace: config.workspaceName,
            lifetime: `${connection}:${presentationEpoch}`,
            window: {
              liveSessionId: windowLinks.liveSessionId,
              linkId: link.linkId,
              linkRevision: windowLinks.linkRevision,
              expectedSemanticWindowId: link.semanticWindowId,
            },
            resource: splitReader?.current() ?? null,
            geometryOwned: runtime.ownsConnectionAuthority("geometry"),
            coherent: layout.panes.every((p) => {
              const frame = p.pane ? surfaces.get(p.pane) : null;
              const rect = contentRect(layout, p);
              return !!frame && frame.cols === p.width && frame.rows === rect.rows;
            }),
          };
        },
        changed: () => {
          if (gesturePublishQueued || stopped) return;
          gesturePublishQueued = true;
          queueMicrotask(() => {
            gesturePublishQueued = false;
            if (!stopped) output(latest.snapshot);
          });
        },
      });
      const stream = {
        protocolVersion: 2 as const,
        workspaceName: config.workspaceName,
        panes: visiblePaneIds,
        viewerMode: interactive ? ("interactive" as const) : ("read-only" as const),
        terminalDelivery: {
          protocolVersions: interactive
            ? [
                1,
                TERMINAL_GRAPHICS_CAPABILITY_VERSION,
                TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION,
                TERMINAL_GRAPHICS_CELL_PIXELS_CAPABILITY_VERSION,
                TERMINAL_GRAPHICS_PRECISE_PIXELS_CAPABILITY_VERSION,
              ]
            : [1],
          encodings: ["semantic-compact-v1" as const, "semantic-v1" as const],
          richPlacements: false,
        },
      };
      const issued = await client.issuePaneStream(randomUUID(), stream, config.liveSessionId);
      if (issued.status !== "issued" || issued.descriptor.effectiveViewerMode !== stream.viewerMode)
        throw new Error("Stream capability was not issued");
      const queuedAcks: Parameters<PaneStreamRuntimeClient["ack"]>[0][] = [];
      runtime = await connectIssuedPaneStreamRuntimeClient(
        {
          origin,
          hostClientId,
          stream,
          requestInitialInputAuthority: false,
          signal: retirement.context.signal,
          createSocket: (descriptor, headers) => {
            const socket = new WebSocket(
              paneStreamSocketUrl(config, descriptor.webSocketUrl),
              [descriptor.subprotocol],
              {
                headers,
                maxPayload: 1024 * 1024,
              },
            );
            type Listener = Parameters<PaneStreamClientSocket["addEventListener"]>[1];
            const listeners = new Map<
              Listener,
              (event: WebSocket.WebSocketEventMap[keyof WebSocket.WebSocketEventMap]) => void
            >();
            return {
              get readyState() {
                return socket.readyState;
              },
              get bufferedAmount() {
                return socket.bufferedAmount;
              },
              send: (data) => socket.send(data),
              close: (code, reason) => socket.close(code, reason),
              addEventListener(type, listener) {
                const wrapper = (
                  event: WebSocket.WebSocketEventMap[keyof WebSocket.WebSocketEventMap],
                ) => {
                  if (!stopped && type === "close")
                    diagnostics.report(
                      "transport-closed",
                      "code" in event ? event.code : undefined,
                    );
                  else if (!stopped && type === "error") diagnostics.report("transport-error");
                  listener({
                    ...("data" in event ? { data: event.data } : {}),
                    ...("code" in event ? { code: event.code, reason: event.reason } : {}),
                  });
                };
                listeners.set(listener, wrapper);
                socket.addEventListener(type, wrapper);
              },
              removeEventListener(type, listener) {
                const wrapper = listeners.get(listener);
                if (wrapper) socket.removeEventListener(type, wrapper);
                listeners.delete(listener);
              },
            };
          },
          onLayoutSnapshot: (frame) => {
            windowLinks = frame.windowLinks;
            layouts = frame.layouts;
            catalogReceived = true;
            if (stopForVisibleSourceFault()) return;
            semanticWindow =
              frame.layouts.find((layout) => layout.panes.some((pane) => pane.pane === selected))
                ?.semanticWindowId ?? null;
            if (catalogOnly) output(null);
            else if (latest.snapshot) output(latest.snapshot);
          },
          onLayout: (frame) => {
            if (frame.semanticWindowId) {
              const index = layouts.findIndex(
                (layout) => layout.semanticWindowId === frame.semanticWindowId,
              );
              if (index < 0) layouts.push(frame);
              else layouts[index] = frame;
            }
            if (stopForVisibleSourceFault()) return;
            semanticWindow = windowForLayout(semanticWindow, selected, frame);
            if (latest.snapshot) output(latest.snapshot);
          },
          onNegotiated: (pane, result) => {
            if (
              !visiblePaneIds.includes(pane) ||
              replicas.has(pane) ||
              !result.accepted ||
              result.negotiated.generation !== config.scope.generation
            )
              throw new Error("Preview negotiation refused");
            replicas.set(
              pane,
              createReplica(
                result.negotiated,
                config.workspaceName,
                pane,
                (snapshot, lifetime) => {
                  const wasHistorical = pane === selected && viewport.offset > 0;
                  if (!lifetimes.has(pane) || lifetimes.get(pane) !== lifetime) {
                    // Saturation terminates the live stream; final retirement may still
                    // clear all surfaces without emitting an unsafe/reused epoch.
                    if (presentationEpoch === Number.MAX_SAFE_INTEGER) {
                      if (!stopped) throw new Error("Presentation lifetime limit exceeded");
                    } else presentationEpoch++;
                    lifetimes.set(pane, lifetime);
                    if (pane === selected) viewport.update(null);
                  }
                  if (snapshot)
                    surfaces.set(
                      pane,
                      pane === selected ? viewport.update(snapshot)! : { ...snapshot, history: [] },
                    );
                  else {
                    surfaces.delete(pane);
                    if (pane === selected) viewport.update(null);
                  }
                  if (wasHistorical && viewport.offset === 0) historyRestoration?.lost();
                  if (pane === selected) {
                    historyRestoration?.observe(replicas.get(pane)?.current() ?? null);
                    if (restorePending && snapshot) {
                      restorePending = false;
                      historyRestoration?.restore(config.historyAnchor!);
                    }
                  }
                  if (!stopped) output(surfaces.get(selected) ?? null);
                },
                (ack) => {
                  if (runtime) runtime.ack(ack);
                  else {
                    if (queuedAcks.length >= visiblePaneIds.length)
                      throw new Error("Unexpected delivery before ready");
                    queuedAcks.push(ack);
                  }
                },
              ),
            );
          },
          onTerminalDelivery: (pane, message) => {
            try {
              const replica = replicas.get(pane);
              if (!replica) throw new Error("Unnegotiated pane");
              if (message.type === "terminal.delivery.fault") {
                if (sourceFaultFence.isolate(pane, message.reason)) {
                  replica.retire();
                  return;
                }
                diagnostics.sourceFault(message.reason);
                stop();
                return;
              }
              replica.accept(message);
            } catch {
              diagnostics.report("replica-validation");
              stop();
            }
          },
          onAuthoritySnapshot: () => {
            if (interactive && latest.snapshot) output(latest.snapshot);
          },
          onTerminalGraphics: (pane, state) => {
            // Redraws of a visible image need only its bytes, not a publication.
            const relayout = kitty.state(pane, state);
            if (state.cellPixels) applyCellPixels();
            if (relayout && interactive && latest.snapshot && !stopped) output(latest.snapshot);
          },
          onTerminalGraphicsBlob: (pane, blob, bytes) => {
            if (!stopped) kitty.blob(pane, blob, bytes);
          },
          onFault: (error) => {
            if (!stopped) diagnostics.runtimeFault(error);
            stop();
          },
        },
        issued.descriptor,
      );
      ready = true;
      applyCellPixels();
      if (stopped) runtime.close();
      else for (const ack of queuedAcks) runtime.ack(ack);
      if (stopped) disposeClient();
      if (interactive && !stopped) {
        const inputRuntime = runtime;
        if (latest.snapshot) output(latest.snapshot);
        await runHostedLiveCommands({
          hostClientId,
          get commands() {
            return commands;
          },
          get stopped() {
            return stopped;
          },
          get inputPipeline() {
            return inputPipeline;
          },
          get foreground() {
            return foreground;
          },
          set foreground(value) {
            foreground = value;
          },
          get closePaneReady() {
            return closePaneReady;
          },
          set closePaneReady(value) {
            closePaneReady = value;
          },
          get actionFence() {
            return actionFence;
          },
          get mouseOwner() {
            return mouseOwner;
          },
          get splitGesture() {
            return splitGesture!;
          },
          get resizeGesture() {
            return resizeGesture!;
          },
          get runtime() {
            return runtime!;
          },
          get historyRestoration() {
            return historyRestoration!;
          },
          get publish() {
            return publish;
          },
          get emit() {
            return emit;
          },
          get stop() {
            return stop;
          },
          get kitty() {
            return kitty;
          },
          get latest() {
            return latest;
          },
          get output() {
            return output;
          },
          get admittedPresenceRevision() {
            return admittedPresenceRevision;
          },
          set admittedPresenceRevision(value) {
            admittedPresenceRevision = value;
          },
          get presenceRevision() {
            return presenceRevision;
          },
          set presenceRevision(value) {
            presenceRevision = value;
          },
          get resizeBlocked() {
            return resizeBlocked;
          },
          set resizeBlocked(value) {
            resizeBlocked = value;
          },
          get selectPaneSchema() {
            return selectPaneSchema;
          },
          get selected() {
            return selected;
          },
          set selected(value) {
            selected = value;
          },
          get replicas() {
            return replicas;
          },
          get layouts() {
            return layouts;
          },
          get semanticWindow() {
            return semanticWindow;
          },
          set semanticWindow(value) {
            semanticWindow = value;
          },
          get visiblePaneIds() {
            return visiblePaneIds;
          },
          get surfaces() {
            return surfaces;
          },
          get lifetimes() {
            return lifetimes;
          },
          get viewport() {
            return viewport;
          },
          get restorePending() {
            return restorePending;
          },
          set restorePending(value) {
            restorePending = value;
          },
          get actionBusy() {
            return actionBusy;
          },
          set actionBusy(value) {
            actionBusy = value;
          },
          get actionFailed() {
            return actionFailed;
          },
          set actionFailed(value) {
            actionFailed = value;
          },
          get selectedActionPane() {
            return selectedActionPane;
          },
          set selectedActionPane(value) {
            selectedActionPane = value;
          },
          get presentationEpoch() {
            return presentationEpoch;
          },
          set presentationEpoch(value) {
            presentationEpoch = value;
          },
          get config() {
            return config;
          },
          get prepareClose() {
            return prepareClose;
          },
          get newWindowReceipt() {
            return newWindowReceipt;
          },
          set newWindowReceipt(value) {
            newWindowReceipt = value;
          },
          get actionFailureMessage() {
            return actionFailureMessage;
          },
          set actionFailureMessage(value) {
            actionFailureMessage = value;
          },
          get executeNewWindow() {
            return executeNewWindow;
          },
          get client() {
            return client;
          },
          get paneSplitReceipt() {
            return paneSplitReceipt;
          },
          set paneSplitReceipt(value) {
            paneSplitReceipt = value;
          },
          get executePaneAction() {
            return executePaneAction;
          },
          get resizeFence() {
            return resizeFence;
          },
          get mouseIdentity() {
            return mouseIdentity;
          },
          get cellPixels() {
            return cellPixels;
          },
          set cellPixels(value) {
            cellPixels = value;
          },
          get applyCellPixels() {
            return applyCellPixels;
          },
          get inputRuntime() {
            return inputRuntime!;
          },
        });
        await inputPipeline.barrier();
        stop();
      }
    } catch {
      if (!stopped) diagnostics.report(ready ? "runtime-failure" : "startup");
      fail();
      stop();
    }
  }
  void run();
  return {
    send: (command: unknown) => {
      if (stopped) throw new Error("Hosted session retired");
      commands.send(command);
    },
    admit: commands.admit,
    end: () => {
      commands.end();
      return retirement.done;
    },
    dispose: () => retirement.dispose(),
    done: retirement.done,
    get failed() {
      return failed;
    },
  };
}
