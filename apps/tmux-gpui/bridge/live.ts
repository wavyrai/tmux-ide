import { createSelectionIdentity } from "./selection-identity.ts";
import { agentLaunchGuidance, GENERIC_PANE_ACTION_ERROR } from "./agent-launch-guidance.ts";
import { z } from "zod";
import { createSourceFaultFence } from "./offscreen-source-fault.ts";
import { createLiveDiagnostics } from "./live-diagnostics.ts";
import { selectedWindowSurfaces } from "./selected-window-surfaces.ts";
import { createClosePanePreflight } from "./close-pane.ts";
import { createNewWindowExecutor } from "./new-window.ts";
import { createSplitGestureOwner, splitGestureSchema } from "./split-gesture.ts";
import { createSplitLayoutReader } from "./split-layout.ts";
import type { WindowLinkTopology } from "../../../packages/contracts/src/window-links.ts";
import { createResizeGestureOwner, resizeGestureSchema } from "./resize-gesture.ts";
import {
  createPaneActionFence,
  createPaneActionExecutor,
  paneActionSchema,
} from "./pane-actions.ts";
import { contentRect } from "./window-canvas.ts";
import { createPaneResizeFence, paneResizeSchema, resizePane } from "./pane-resize.ts";
import { createHistoryRestoration } from "./history-restoration.ts";
import { createHistoryViewport, scrollSchema } from "./history.ts";
import { createMouseOwner, mouseSchema } from "./mouse.ts";
import { routeWheel, wheelSchema } from "./wheel.ts";
import type { Layout } from "./topology.ts";
import { applyPresence, presenceSchema } from "./presence.ts";
import { resizeSchema, resizeWindow, windowForLayout } from "./geometry.ts";
import { deliverInput, deliverPreviewInput, MAX_INPUT_LINE } from "./input.ts";
import { connectionSchema, readPrivateConfig, paneStreamSocketUrl } from "./config.ts";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  requestHistoryAnchor,
  createTmuxServerClient,
} from "../../../packages/daemon-client/src/tmux-server-client.ts";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamRuntimeClient,
  type PaneStreamClientSocket,
} from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { createReplica } from "./replica.ts";

const selectPaneSchema = z
  .object({ kind: z.literal("select-pane"), id: z.string().min(1).max(512) })
  .strict();

const diagnostics = createLiveDiagnostics((line) => process.stderr.write(line));
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
let pending: string | null = null;
let blocked = false;
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
const interactive = process.argv[3] === "--interactive";
const catalogOnly = process.argv[3] === "--catalog";
let catalogReceived = false;
const latest: {
  snapshot: import("../../../packages/contracts/src/index.ts").TerminalReplicaSnapshot | null;
} = { snapshot: null };
const selectionIdentity = createSelectionIdentity();
// Surface snapshots are replaced, never mutated, so each object serializes once.
const serialized = new WeakMap<object, string>();
function snapshotJson(snapshot: object | null) {
  if (!snapshot) return "null";
  let text = serialized.get(snapshot);
  if (text === undefined) serialized.set(snapshot, (text = JSON.stringify(snapshot)));
  return text;
}
// After a resize tmux reflows the window's panes one by one. A mix of old and new
// sizes cannot be presented, so it is withheld briefly instead of published.
const SKEW_HOLD_MS = 100;
let skewSince: number | null = null;
let skewTimer: ReturnType<typeof setTimeout> | undefined;
function holdSkewedWindow(layout: Layout | undefined) {
  const skewed =
    !stopped &&
    !!layout &&
    layout.panes.every((p) => !!p.pane && surfaces.has(p.pane)) &&
    layout.panes.some((p) => {
      const frame = surfaces.get(p.pane!)!;
      return frame.cols !== p.width || frame.rows !== contentRect(layout, p).rows;
    });
  if (!skewed) {
    skewSince = null;
    clearTimeout(skewTimer);
    skewTimer = undefined;
    return false;
  }
  skewSince ??= performance.now();
  const remaining = SKEW_HOLD_MS - (performance.now() - skewSince);
  if (remaining <= 0) return false;
  skewTimer ??= setTimeout(() => {
    skewTimer = undefined;
    if (!stopped) publish();
  }, remaining);
  return true;
}
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
    setImmediate(() => {
      publicationQueued = false;
      publish();
    });
  }
}
let unpublished = false;
let publicationQueued = false;
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
  if (holdSkewedWindow(resizeLayout)) return;
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
              actionFence.current(resizeLayout, closePaneReady.id, lifetimes.get(closePaneReady.id))
                ?.token
              ? closePaneReady
              : null,
          paneActionError: actionFailed ? actionFailureMessage : null,
          resizeToken: currentResizeToken,
          selectionIdentity: selectionIdentity(
            stopped || catalogOnly
              ? null
              : ((selectedActionPane ? replicas.get(selectedActionPane)?.current() : null) ?? null),
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
  // Same JSON as one stringify, but unchanged panes reuse their text. Terminal content
  // goes last behind its byte length so the browser can skip decoding an unchanged tail.
  const head = `"connection":${JSON.stringify(connection)},"sequence":${++sequence}`;
  const content = `"snapshot":${catalogOnly ? "null" : snapshotJson(snapshot)}`;
  let line: string;
  if (interactive || catalogOnly) {
    const tail = `,${content},"surfaces":[${published
      .map((s) => `{"paneId":${JSON.stringify(s.paneId)},"snapshot":${snapshotJson(s.snapshot)}}`)
      .join(",")}]}`;
    line = `{"surfaceBytes":${Buffer.byteLength(tail)},${head},${JSON.stringify(fields).slice(1, -1)}${tail}\n`;
  } else line = `{${head},${content}}\n`;
  diagnostics.publication(line);
  if (blocked) {
    pending = line;
    return;
  }
  blocked = !process.stdout.write(line);
}
process.stdout.on("drain", () => {
  blocked = false;
  if (pending) {
    const line = pending;
    pending = null;
    blocked = !process.stdout.write(line);
  }
});
function stop() {
  if (stopped) return;
  stopped = true;
  resizeGesture?.retire();
  splitReader?.dispose();
  splitGesture?.retire();
  historyRestoration?.dispose();
  disposeClient?.();
  runtime?.close();
  if (interactive) process.stdin.destroy();
  for (const replica of replicas.values()) replica.retire();
  surfaces.clear();
  lifetimes.clear();
  output(null);
  // Flush the final unavailable state even if the native reader was slow.
  const finish = () => process.stdout.end();
  if (blocked) process.stdout.once("drain", finish);
  else finish();
}
process.stdout.on("error", () => {
  runtime?.close();
  process.exitCode = 1;
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  if (process.argv.length !== (interactive || catalogOnly ? 4 : 3))
    throw new Error("Usage: live.ts CONNECTION.json");
  const path = process.argv[2]!;
  const config = connectionSchema.parse(readPrivateConfig(path));
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
  if (!visiblePaneIds.includes(selected) || new Set(visiblePaneIds).size !== visiblePaneIds.length)
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
  const client = createTmuxServerClient({ ...config, origin, hostClientId }, config.scope);
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
      protocolVersions: [1],
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
                diagnostics.report("transport-closed", "code" in event ? event.code : undefined);
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
      onFault: (error) => {
        if (!stopped) diagnostics.runtimeFault(error);
        stop();
      },
    },
    issued.descriptor,
  );
  ready = true;
  if (stopped) runtime.close();
  else for (const ack of queuedAcks) runtime.ack(ack);
  if (stopped) disposeClient();
  if (interactive && !stopped) {
    if (latest.snapshot) output(latest.snapshot);
    let buffer = Buffer.alloc(0);
    inputLoop: for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end > MAX_INPUT_LINE || stopped) throw new Error("Input rejected");
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        const value: unknown = JSON.parse(line);
        const handoff = z
          .object({ kind: z.literal("history-handoff"), intent: z.uuid() })
          .strict()
          .safeParse(value);
        if (handoff.success) {
          // Ordered after accepted history navigation; no later command may act.
          foreground = false;
          closePaneReady = null;
          actionFence.invalidate();
          mouseOwner.retire();
          splitGesture.retire();
          resizeGesture.retire();
          await applyPresence(runtime, false);
          const captured = await historyRestoration?.settleCapture();
          publish();
          if (!stopped)
            process.stdout.write(
              JSON.stringify({
                kind: "history-handoff",
                intent: handoff.data.intent,
                ...(captured ?? { state: "unavailable", token: null }),
              }) + "\n",
            );
          stop();
          break inputLoop;
        }
        const presence = presenceSchema.safeParse(value);
        if (presence.success) {
          admittedPresenceRevision = presence.data.revision;
          closePaneReady = null;
          actionFence.invalidate();
          mouseOwner.retire();
          foreground = presence.data.active;
          if (!foreground) splitGesture.retire();
          if (!foreground && latest.snapshot) output(latest.snapshot);
          await applyPresence(runtime, foreground);
          presenceRevision = presence.data.revision;
          if (foreground) resizeBlocked = false;
          if (latest.snapshot) output(latest.snapshot);
          continue;
        }
        const reselect = selectPaneSchema.safeParse(value);
        if (reselect.success) {
          const id = reselect.data.id;
          if (id === selected) {
            output(latest.snapshot);
            continue;
          }
          const frame = replicas.get(id)?.current();
          const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
          if (
            !frame ||
            !visiblePaneIds.includes(id) ||
            !surfaces.has(id) ||
            !lifetimes.get(id) ||
            !layout?.panes.some((pane) => pane.pane === id) ||
            viewport.offset !== 0 ||
            restorePending ||
            historyRestoration.publication().state === "restoring" ||
            actionBusy
          ) {
            // Never leave later input addressed to the previous pane; the browser
            // replaces a refusing helper with a fresh attachment for the target.
            stop();
            break inputLoop;
          }
          closePaneReady = null;
          actionFailed = false;
          actionFence.invalidate();
          mouseOwner.retire();
          splitGesture.retire();
          resizeGesture.retire();
          selected = id;
          selectedActionPane = id;
          viewport.update(null);
          surfaces.set(id, viewport.update(frame.snapshot)!);
          historyRestoration.observe(null);
          historyRestoration.observe(frame);
          if (historyRestoration.publication().state !== "live") historyRestoration.live();
          // Rotate resize/mouse/action identities: nothing granted for the old pane carries over.
          if (presentationEpoch === Number.MAX_SAFE_INTEGER)
            throw new Error("Presentation lifetime limit exceeded");
          presentationEpoch++;
          output(surfaces.get(selected) ?? null);
          continue;
        }
        if (restorePending || historyRestoration?.publication().state === "restoring") {
          const returnLive = scrollSchema.safeParse(value);
          if (!returnLive.success || returnLive.data.data !== 0) continue;
        }
        const splitCommand = splitGestureSchema.safeParse(value);
        if (splitCommand.success) {
          if (foreground || splitCommand.data.phase === "cancel") {
            resizeGesture.retire();
            if (splitCommand.data.phase === "begin" && !runtime.ownsConnectionAuthority("geometry"))
              await runtime.requestAuthority("geometry");
            if (foreground || splitCommand.data.phase === "cancel")
              splitGesture.command(splitCommand.data);
          }
          continue;
        }
        const gesture = resizeGestureSchema.safeParse(value);
        if (gesture.success) {
          if (foreground || gesture.data.phase === "cancel") {
            splitGesture.retire();
            resizeGesture.command(gesture.data);
          }
          continue;
        }
        if (!foreground) continue;
        const paneAction = paneActionSchema.safeParse(value);
        if (paneAction.success) {
          if (actionBusy) continue;
          resizeGesture.retire();
          splitGesture.retire();
          const target = () => {
            const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
            const lifetime = lifetimes.get(selected);
            if (
              stopped ||
              !foreground ||
              viewport.offset !== 0 ||
              !latest.snapshot ||
              actionFailed ||
              paneAction.data.id !== selected ||
              !surfaces.has(selected) ||
              !layout?.semanticWindowId ||
              !lifetime
            )
              return null;
            const capability = actionFence.current(layout, selected, lifetime);
            return capability
              ? {
                  token: capability.token,
                  id: selected,
                  generation: config.scope.generation,
                  workspace: config.workspaceName,
                  window: layout.semanticWindowId,
                  lifetime,
                }
              : null;
          };
          if (target()?.token !== paneAction.data.token) continue;
          if (paneAction.data.action === "close") {
            const revision = admittedPresenceRevision;
            actionBusy = true;
            closePaneReady = null;
            output(latest.snapshot);
            void prepareClose(runtime, () => {
              const value = target();
              return value && admittedPresenceRevision === revision
                ? { ...value, session: config.liveSessionId, presenceRevision: revision }
                : null;
            })
              .then((result) => {
                actionFailed = !result;
                if (result)
                  closePaneReady = {
                    token: result.token,
                    id: result.id,
                    hostClientId,
                    presenceRevision: revision,
                  };
              })
              .catch(() => {
                actionFailed = true;
              })
              .finally(() => {
                actionBusy = false;
                if (!stopped) output(latest.snapshot);
              });
            continue;
          }
          if (paneAction.data.action === "new-window" || paneAction.data.action === "new-agent") {
            const revision = admittedPresenceRevision;
            actionBusy = true;
            newWindowReceipt = null;
            actionFailureMessage = GENERIC_PANE_ACTION_ERROR;
            output(latest.snapshot);
            void executeNewWindow(
              client,
              runtime,
              () => {
                const value = target();
                return value && admittedPresenceRevision === revision
                  ? { ...value, session: config.liveSessionId, presenceRevision: revision }
                  : null;
              },
              paneAction.data.action === "new-agent"
                ? { name: paneAction.data.name, harness: paneAction.data.harness }
                : undefined,
            )
              .then((result) => {
                actionFailed = !result;
                if (result) newWindowReceipt = { token: paneAction.data.token, result };
              })
              .catch((error: unknown) => {
                actionFailed = true;
                actionFailureMessage = agentLaunchGuidance(
                  error,
                  paneAction.data.action === "new-agent",
                );
              })
              .finally(() => {
                actionBusy = false;
                actionFence.invalidate();
                if (!stopped) output(latest.snapshot);
              });
            continue;
          }
          actionBusy = true;
          paneSplitReceipt = null;
          output(latest.snapshot);
          try {
            const result = await executePaneAction(runtime, target, paneAction.data);
            actionFailed = !result;
            if (typeof result === "object")
              paneSplitReceipt = { token: paneAction.data.token, result };
          } catch {
            actionFailed = true;
          } finally {
            actionBusy = false;
            actionFence.invalidate();
          }
          output(latest.snapshot);
          continue;
        }
        const paneResize = paneResizeSchema.safeParse(value);
        if (paneResize.success) {
          if (resizeGesture.active()) continue;
          const target = () => {
            const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
            const lifetime = lifetimes.get(paneResize.data.id);
            if (
              stopped ||
              !foreground ||
              viewport.offset !== 0 ||
              !latest.snapshot ||
              !visiblePaneIds.includes(paneResize.data.id) ||
              !surfaces.has(paneResize.data.id) ||
              !layout?.panes.some((p) => p.pane === paneResize.data.id) ||
              !lifetime ||
              !layout.semanticWindowId
            )
              return null;
            const pane = layout.panes.find((p) => p.pane === paneResize.data.id)!;
            const token = resizeFence(layout, presentationEpoch);
            return token
              ? {
                  token,
                  generation: config.scope.generation,
                  workspace: config.workspaceName,
                  window: layout.semanticWindowId,
                  lifetime,
                  statusRows: pane.height - contentRect(layout, pane).rows,
                }
              : null;
          };
          try {
            const receipt = await resizePane(runtime, target, paneResize.data);
            resizeBlocked = receipt === null;
          } catch {
            resizeBlocked = true;
          }
          output(latest.snapshot);
          continue;
        }
        const mouse = mouseSchema.safeParse(value);
        if (mouse.success) {
          if (
            !latest.snapshot ||
            viewport.offset > 0 ||
            !runtime.ownsConnectionAuthority("input")
          ) {
            mouseOwner.retire();
            continue;
          }
          const input = mouseOwner.route(latest.snapshot, mouseIdentity(), mouse.data);
          if (input) {
            try {
              await deliverInput(runtime, config.workspaceName, selected, input);
            } catch (error) {
              mouseOwner.retire();
              throw error;
            }
          }
          continue;
        }
        const wheel = wheelSchema.safeParse(value);
        if (wheel.success) {
          mouseOwner.retire();
          resizeGesture.retire();
          if (!latest.snapshot) continue;
          const route = routeWheel(latest.snapshot, viewport.offset, wheel.data);
          if (!route) continue;
          if (route.kind === "application") {
            for (const input of route.inputs) {
              await deliverInput(runtime, config.workspaceName, selected, input);
            }
          } else {
            const view = viewport.scroll(route.lines);
            if (view) surfaces.set(selected, view);
            historyRestoration?.capture(viewport.captureIndex());
            output(view);
          }
          continue;
        }
        const scroll = scrollSchema.safeParse(value);
        if (scroll.success) {
          mouseOwner.retire();
          resizeGesture.retire();
          const view = viewport.scroll(scroll.data.data);
          restorePending = false;
          if (view) surfaces.set(selected, view);
          historyRestoration?.capture(viewport.captureIndex());
          output(view);
          continue;
        }
        const resize = resizeSchema.safeParse(value);
        if (resize.success) {
          mouseOwner.retire();
          resizeGesture.retire();
          if (!resizeBlocked && latest.snapshot) {
            try {
              resizeBlocked = !(await resizeWindow(runtime, () => semanticWindow, resize.data));
            } catch {
              resizeBlocked = true;
            }
            output(latest.snapshot);
          }
          continue;
        }
        if (
          restorePending ||
          historyRestoration?.publication().state === "restoring" ||
          viewport.offset > 0
        )
          continue; // Never type into a historical view.
        if (!latest.snapshot) throw new Error("No verified input target");
        await deliverPreviewInput(
          runtime,
          config.workspaceName,
          selected,
          value,
          latest.snapshot.modes.bracketedPaste,
        );
      }
      if (buffer.length > MAX_INPUT_LINE) throw new Error("Input command too large");
    }
    stop();
  }
} catch {
  if (!stopped) diagnostics.report(ready ? "runtime-failure" : "startup");
  process.exitCode = 1;
  stop();
}
