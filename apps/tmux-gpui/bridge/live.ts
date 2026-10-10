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
import { createHistoryViewport, scrollSchema } from "./history.ts";
import type { Layout } from "./topology.ts";
import { applyPresence, presenceSchema } from "./presence.ts";
import { resizeSchema, resizeWindow, windowForLayout } from "./geometry.ts";
import { deliverPreviewInput, MAX_INPUT_LINE } from "./input.ts";
import { connectionSchema, readPrivateConfig } from "./config.ts";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createTmuxServerClient } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamRuntimeClient,
  type PaneStreamClientSocket,
} from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { createReplica } from "./replica.ts";

let runtime: PaneStreamRuntimeClient | undefined;
let disposeClient: (() => void) | undefined;
let splitGesture: ReturnType<typeof createSplitGestureOwner> | undefined;
const viewport = createHistoryViewport();
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
let actionBusy = false;
let actionFailed = false;
let selectedActionPane: string | null = null;
let foreground = false;
let presenceRevision = 0;
const connection = randomUUID();
const interactive = process.argv[3] === "--interactive";
const catalogOnly = process.argv[3] === "--catalog";
let catalogReceived = false;
const latest: {
  snapshot: import("../../../packages/contracts/src/index.ts").TerminalReplicaSnapshot | null;
} = { snapshot: null };
function output(snapshot: typeof latest.snapshot) {
  if (catalogOnly && !catalogReceived && !stopped) return;
  latest.snapshot = snapshot;
  const inputReady =
    foreground && !stopped && viewport.offset === 0 && !!runtime?.ownsConnectionAuthority("input");
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
  resizeGesture?.observe();
  splitGesture?.observe();
  const line =
    JSON.stringify({
      connection,
      sequence: ++sequence,
      snapshot: catalogOnly ? null : snapshot,
      ...(interactive || catalogOnly
        ? {
            inputReady,
            presentationEpoch,
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
            paneActionError: actionFailed
              ? "Pane action unavailable — reselect pane to retry"
              : null,
            resizeToken: currentResizeToken,
            scrollOffset: viewport.offset,
            presenceRevision,
            layouts,
            surfaces: catalogOnly
              ? []
              : [...surfaces].map(([paneId, snapshot]) => ({ paneId, snapshot })),
          }
        : {}),
    }) + "\n";
  if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error("Preview frame too large");
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
  selectedActionPane = config.semanticPaneId;
  const visiblePaneIds = config.visiblePaneIds ?? [config.semanticPaneId];
  if (
    !visiblePaneIds.includes(config.semanticPaneId) ||
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
  const client = createTmuxServerClient({ ...config, origin, hostClientId }, config.scope);
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
      encodings: ["semantic-v1" as const],
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
        const socket = new WebSocket(descriptor.webSocketUrl, [descriptor.subprotocol], {
          headers,
          maxPayload: 1024 * 1024,
        });
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
            ) =>
              listener({
                ...("data" in event ? { data: event.data } : {}),
                ...("code" in event ? { code: event.code, reason: event.reason } : {}),
              });
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
        semanticWindow =
          frame.layouts.find((layout) =>
            layout.panes.some((pane) => pane.pane === config.semanticPaneId),
          )?.semanticWindowId ?? null;
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
        semanticWindow = windowForLayout(semanticWindow, config.semanticPaneId, frame);
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
              if (!lifetimes.has(pane) || lifetimes.get(pane) !== lifetime) {
                // Saturation terminates the live stream; final retirement may still
                // clear all surfaces without emitting an unsafe/reused epoch.
                if (presentationEpoch === Number.MAX_SAFE_INTEGER) {
                  if (!stopped) throw new Error("Presentation lifetime limit exceeded");
                } else presentationEpoch++;
                lifetimes.set(pane, lifetime);
                if (pane === config.semanticPaneId) viewport.update(null);
              }
              if (snapshot)
                surfaces.set(
                  pane,
                  pane === config.semanticPaneId
                    ? viewport.update(snapshot)!
                    : { ...snapshot, history: [] },
                );
              else {
                surfaces.delete(pane);
                if (pane === config.semanticPaneId) viewport.update(null);
              }
              if (!stopped) output(surfaces.get(config.semanticPaneId) ?? null);
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
          replica.accept(message);
        } catch {
          process.stderr.write("Preview stream validation failed\n");
          stop();
        }
      },
      onAuthoritySnapshot: () => {
        if (interactive && latest.snapshot) output(latest.snapshot);
      },
      onFault: () => stop(),
    },
    issued.descriptor,
  );
  if (stopped) runtime.close();
  else for (const ack of queuedAcks) runtime.ack(ack);
  if (stopped) disposeClient();
  if (interactive && !stopped) {
    if (latest.snapshot) output(latest.snapshot);
    let buffer = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        if (end > MAX_INPUT_LINE || stopped) throw new Error("Input rejected");
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 1);
        const value: unknown = JSON.parse(line);
        const presence = presenceSchema.safeParse(value);
        if (presence.success) {
          actionFence.invalidate();
          foreground = presence.data.active;
          if (!foreground) splitGesture.retire();
          if (!foreground && latest.snapshot) output(latest.snapshot);
          await applyPresence(runtime, foreground);
          presenceRevision = presence.data.revision;
          if (foreground) resizeBlocked = false;
          if (latest.snapshot) output(latest.snapshot);
          continue;
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
          resizeGesture.retire();
          splitGesture.retire();
          const target = () => {
            const layout = layouts.find((l) => l.semanticWindowId === semanticWindow);
            const lifetime = lifetimes.get(config.semanticPaneId);
            if (
              stopped ||
              !foreground ||
              viewport.offset !== 0 ||
              !latest.snapshot ||
              actionFailed ||
              paneAction.data.id !== config.semanticPaneId ||
              !surfaces.has(config.semanticPaneId) ||
              !layout?.semanticWindowId ||
              !lifetime
            )
              return null;
            const capability = actionFence.current(layout, config.semanticPaneId, lifetime);
            return capability
              ? {
                  token: capability.token,
                  id: config.semanticPaneId,
                  generation: config.scope.generation,
                  workspace: config.workspaceName,
                  window: layout.semanticWindowId,
                  lifetime,
                }
              : null;
          };
          if (target()?.token !== paneAction.data.token) continue;
          actionBusy = true;
          output(latest.snapshot);
          try {
            actionFailed = !(await executePaneAction(runtime, target, paneAction.data));
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
        const scroll = scrollSchema.safeParse(value);
        if (scroll.success) {
          resizeGesture.retire();
          const view = viewport.scroll(scroll.data.data);
          if (view) surfaces.set(config.semanticPaneId, view);
          output(view);
          continue;
        }
        const resize = resizeSchema.safeParse(value);
        if (resize.success) {
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
        if (viewport.offset > 0) continue; // Never type into a historical view.
        if (!latest.snapshot) throw new Error("No verified input target");
        await deliverPreviewInput(
          runtime,
          config.workspaceName,
          config.semanticPaneId,
          value,
          latest.snapshot.modes.bracketedPaste,
        );
      }
      if (buffer.length > MAX_INPUT_LINE) throw new Error("Input command too large");
    }
    stop();
  }
} catch {
  process.stderr.write(
    "Live preview could not connect. Check the private connection file and daemon identity.\n",
  );
  process.exitCode = 1;
  stop();
}
