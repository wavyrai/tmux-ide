// @vitest-environment happy-dom

import {
  PANE_STREAM_MAX_INPUT_TEXT_CHARS,
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";

import { createScriptedPaneStream } from "../terminal/mirror-pane-fixture.ts";
import type {
  PaneStreamResizeResult,
  PaneStreamSessionListeners,
  PaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { TerminalRenderer } from "../terminal/xterm-renderer.ts";
import {
  createPaneStreamInputDecoder,
  createPaneStreamNativeTerminalTransport,
} from "./host-pane-stream-native-terminal-transport.ts";
import { createWebWorkspacePaneStreamBridge } from "./web-workspace-pane-stream-bridge.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  const evidenceHost = globalThis as typeof globalThis & {
    __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
    __TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__?: unknown;
  };
  delete evidenceHost.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
  delete evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__;
});

describe("pane-stream terminal input decoder", () => {
  it("publishes early and live geometry authority using the connection principal", async () => {
    let listeners!: PaneStreamSessionListeners;
    const events: unknown[] = [];
    const snapshot = (geometry: string | null) => ({
      generation: "11111111-1111-4111-8111-111111111111",
      session: "runtime-a",
      revision: 2,
      owners: { input: "other", focus: "other", geometry },
      nativeGeometryYieldUntilMs: 0,
      clients: [],
    });
    const transport = createPaneStreamNativeTerminalTransport(
      {
        connect: async (_request, next) => {
          listeners = next;
          next.onAuthoritySnapshot?.(snapshot("other"));
          return {
            status: "connected",
            session: { dispose: vi.fn(), connectionClientId: () => "self" },
          };
        },
      },
      "geometry-test",
    );
    const result = await transport.connect(
      {
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.a" },
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 80, rows: 24 },
      },
      (event) => {
        events.push(event);
      },
    );
    listeners.onAuthoritySnapshot?.(snapshot("self"));
    listeners.onAuthoritySnapshot?.(snapshot(null));
    expect(events).toEqual([
      { type: "geometry-authority", ownership: "passive" },
      { type: "geometry-authority", ownership: "owner" },
      { type: "geometry-authority", ownership: "available" },
    ]);
    if (result.status === "connected") result.attachment.dispose();
  });

  it("publishes the exact acknowledged viewport instead of replaying connect-time geometry", async () => {
    let listeners: PaneStreamSessionListeners | null = null;
    const resize = vi.fn(async (): Promise<PaneStreamResizeResult> => "ok");
    const transport: PaneStreamTransport = {
      connect: async (_request, nextListeners) => {
        listeners = nextListeners;
        return { status: "connected", session: { dispose: vi.fn(), resize } };
      },
    };
    const events: unknown[] = [];
    const connected = await createPaneStreamNativeTerminalTransport(transport, "daemon-a").connect(
      {
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.a" },
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 39, rows: 24 },
      },
      (event) => {
        events.push(event);
      },
    );
    if (connected.status !== "connected" || !listeners) throw new Error("terminal did not connect");
    await expect(connected.attachment.resize({ cols: 140, rows: 46 })).resolves.toEqual({
      status: "ok",
    });
    const observedListeners = listeners as PaneStreamSessionListeners;
    observedListeners.onLayout?.({
      semanticWindowId: "window-a",
      windowName: "main",
      currentWindow: true,
      cols: 140,
      rows: 46,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [
        {
          pane: "pane.workspace.a",
          left: 0,
          top: 0,
          width: 140,
          height: 46,
          active: true,
        },
      ],
    });
    expect(events).toContainEqual({
      type: "geometry",
      sourceGrid: { cols: 140, rows: 46 },
      clientViewport: { cols: 140, rows: 46 },
    });
    connected.attachment.dispose();
  });

  it.each(["top", "bottom", "off"] as const)(
    "retains canonical content dimensions across %s layout updates and reseeds",
    async (paneBorderStatus) => {
      let listeners!: PaneStreamSessionListeners;
      const events: Array<{ type: string; sourceGrid?: { cols: number; rows: number } }> = [];
      const connected = await createPaneStreamNativeTerminalTransport(
        {
          connect: async (_request, next) => {
            listeners = next;
            return { status: "connected", session: { dispose: vi.fn() } };
          },
        },
        "daemon-a",
      ).connect(
        {
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.a" },
          viewerMode: "interactive",
          geometryOwnership: "passive",
          viewport: { cols: 80, rows: 24 },
        },
        (event) => {
          events.push(event);
        },
      );
      if (connected.status !== "connected") throw new Error("terminal did not connect");
      const layout = {
        semanticWindowId: "window-a",
        windowName: "main",
        currentWindow: true,
        cols: 132,
        rows: 41,
        zoomed: false,
        paneBorderStatus,
        panes: [
          { pane: "pane.workspace.a", left: 0, top: 0, width: 132, height: 41, active: true },
        ],
      };
      const rows = paneBorderStatus === "off" ? 41 : 40;
      const canonical = {
        deliveryRequestId: "delivery-a",
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 1,
        stateHash: "0123456789abcdef",
        cols: 132,
        rows,
        sourceEpoch: 1,
        alternateScreen: false,
        cursor: { x: 0, y: 0, hidden: false, style: "block" as const, blink: false },
        gridRowsRead: rows,
        gridCellsRead: 132 * rows,
        fullGridWalks: 0,
      };
      listeners.onLayout?.(layout);
      await listeners.onPaneEvent("pane.workspace.a", {
        type: "seed-batch",
        batch: { reset: { cols: 132, rows }, seed: new Uint8Array([65]), held: [], cursor: null },
        canonical,
      });
      expect(events.find((event) => event.type === "state")?.sourceGrid).toEqual({
        cols: 132,
        rows,
      });
      events.length = 0;
      listeners.onLayout?.(layout);
      listeners.onLayoutSnapshot?.({ topologyEpoch: 2, layouts: [layout] });
      expect(events).toEqual([]);
      // A real content resize still reaches the renderer before its bytes.
      await listeners.onPaneEvent("pane.workspace.a", {
        type: "output",
        bytes: new Uint8Array([66]),
        canonical: { ...canonical, revision: 2, cols: 100, rows: 30 },
      });
      expect(events.map((event) => event.type)).toEqual(["geometry", "output"]);
      expect(events[0]?.sourceGrid).toEqual({ cols: 100, rows: 30 });
      events.length = 0;
      await listeners.onPaneEvent("pane.workspace.a", {
        type: "seed-batch",
        batch: {
          reset: { cols: 90, rows: 21 },
          seed: new Uint8Array([67]),
          held: [],
          cursor: null,
        },
        canonical: { ...canonical, revision: 3, sourceEpoch: 2, cols: 90, rows: 20 },
      });
      expect(events[0]?.sourceGrid).toEqual({ cols: 90, rows: 20 });
      listeners.onLayoutSnapshot?.({ topologyEpoch: 3, layouts: [layout] });
      expect(events.map((event) => event.type)).toEqual(["geometry", "output"]);
      connected.attachment.dispose();
    },
  );

  it.each([
    ["ok", { status: "ok" }],
    [
      "geometry-authority-conflict",
      {
        status: "error",
        error: {
          code: "geometry-authority-conflict",
          reason: "Another client controls terminal geometry.",
          retryable: true,
        },
      },
    ],
    [
      "failed",
      {
        status: "error",
        error: {
          code: "geometry-resize-failed",
          reason: "Terminal geometry was not accepted.",
          retryable: false,
        },
      },
    ],
    [
      "authority-timeout",
      {
        status: "error",
        error: {
          code: "geometry-authority-timeout",
          reason: "Geometry authority did not settle before its deadline.",
          retryable: false,
        },
      },
    ],
    [
      "viewport-timeout",
      {
        status: "error",
        error: {
          code: "geometry-viewport-timeout",
          reason: "Terminal geometry did not settle before its deadline.",
          retryable: false,
        },
      },
    ],
    [
      "stream-closed",
      {
        status: "error",
        error: {
          code: "pane-stream-closed",
          reason: "The terminal stream closed before geometry settled.",
          retryable: false,
        },
      },
    ],
    [
      "lifecycle-retired",
      {
        status: "error",
        error: {
          code: "geometry-lifecycle-retired",
          reason: "The terminal runtime retired before geometry settled.",
          retryable: false,
        },
      },
    ],
  ] as const)("projects pane-stream resize result %s exactly", async (resizeResult, expected) => {
    const transport: PaneStreamTransport = {
      connect: async () => ({
        status: "connected",
        session: {
          dispose: vi.fn(),
          resize: vi.fn(async (): Promise<PaneStreamResizeResult> => resizeResult),
        },
      }),
    };
    const connected = await createPaneStreamNativeTerminalTransport(transport, "daemon-a").connect(
      {
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.a" },
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 39, rows: 24 },
      },
      () => undefined,
    );
    if (connected.status !== "connected") throw new Error("terminal did not connect");
    await expect(connected.attachment.resize({ cols: 140, rows: 46 })).resolves.toEqual(expected);
    connected.attachment.dispose();
  });

  it.each([
    ["ok", 1, "owner", "none"],
    ["geometry-authority-conflict", 1, "passive", "geometry-authority-conflict"],
  ] as const)(
    "carries production pane-stream resize outcome %s through the bridge into TerminalSurface",
    async (resizeOutcome, expectedConnections, expectedGeometryOwnership, expectedFailureCode) => {
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      const connect = vi.spyOn(bridge, "connect");
      const resize = vi.fn(async (): Promise<PaneStreamResizeResult> => resizeOutcome);
      const write = vi.fn(async () => true);
      const disposeSession = vi.fn();
      bridge.bindSession({ dispose: disposeSession, resize, write });
      bridge.publishPane("pane.workspace.a", {
        type: "seed-batch",
        batch: {
          reset: { cols: 39, rows: 24 },
          seed: new TextEncoder().encode("authoritative frame"),
          held: [],
          cursor: { x: 0, y: 0 },
        },
      });
      let viewport = { cols: 39, rows: 24 };
      const callbacks: {
        input?: (bytes: Uint8Array) => void;
        resize?: ResizeObserverCallback;
      } = {};
      const renderer: TerminalRenderer = {
        open: vi.fn(),
        readCellRows: vi.fn(() => []),
        write: vi.fn(async () => undefined),
        focus: vi.fn(),
        fit: vi.fn(() => viewport),
        resizeGrid: vi.fn(),
        refreshTheme: vi.fn(),
        setReducedMotion: vi.fn(),
        onInput: vi.fn((listener) => {
          callbacks.input = listener;
          return { dispose: vi.fn(() => delete callbacks.input) };
        }),
        dispose: vi.fn(),
      };
      class ResizeObserverStub {
        constructor(callback: ResizeObserverCallback) {
          callbacks.resize = callback;
        }
        observe(): void {}
        disconnect(): void {}
        unobserve(): void {}
      }
      vi.stubGlobal("ResizeObserver", ResizeObserverStub);
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(1));
        return 1;
      });
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const root = document.body.appendChild(document.createElement("div"));
      const dispose = render(
        () =>
          createComponent(TerminalSurface, {
            target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.a" },
            title: "Electron",
            geometryOwnership: "owner",
            transport: createPaneStreamNativeTerminalTransport(bridge, "daemon-a"),
            rendererFactory: () => renderer,
          }),
        root,
      );

      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
      viewport = { cols: 140, rows: 46 };
      callbacks.resize?.([], {} as ResizeObserver);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(expectedConnections));
      await vi.waitFor(() =>
        expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe(
          "connected",
        ),
      );
      expect(connect.mock.calls.map(([request]) => request.viewerMode)).toEqual(
        Array.from({ length: expectedConnections }, () => "interactive"),
      );
      expect(resize).toHaveBeenCalledOnce();
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
        "interactive",
      );
      await vi.waitFor(() =>
        expect(
          root.querySelector(".terminal-surface")?.getAttribute("data-geometry-ownership"),
        ).toBe(expectedGeometryOwnership),
      );
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
        "true",
      );
      expect(
        root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code"),
      ).toBe(expectedFailureCode);
      callbacks.input?.(new TextEncoder().encode("marker"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      expect(write).toHaveBeenCalledWith("pane.workspace.a", "marker");
      expect(resize).toHaveBeenCalledOnce();
      dispose();
    },
  );

  it("reassembles a UTF-8 code point split across terminal write callbacks", () => {
    const decoder = createPaneStreamInputDecoder();
    const bytes = new TextEncoder().encode("€");
    expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(1))).toEqual(["€"]);
  });

  it("keeps decoder state private to each terminal attachment", () => {
    const first = createPaneStreamInputDecoder();
    const second = createPaneStreamInputDecoder();
    const euro = new TextEncoder().encode("€");
    expect(first.push(euro.subarray(0, 1))).toEqual([]);
    expect(second.push(new TextEncoder().encode("x"))).toEqual(["x"]);
    expect(first.push(euro.subarray(1))).toEqual(["€"]);
  });

  it("bounds pane-stream text frames without splitting surrogate pairs", () => {
    const decoder = createPaneStreamInputDecoder();
    const source = "🙂".repeat(PANE_STREAM_MAX_INPUT_TEXT_CHARS + 1);
    const chunks = decoder.push(new TextEncoder().encode(source));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= PANE_STREAM_MAX_INPUT_TEXT_CHARS)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });

  it("claims shared focus once per foreground epoch without claiming input or geometry", async () => {
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const requests: string[] = [];
    const presence: string[] = [];
    const listeners: PaneStreamSessionListeners[] = [];
    const transport = createPaneStreamNativeTerminalTransport(
      {
        connect: async (_request, next) => {
          listeners.push(next);
          return {
            status: "connected",
            session: {
              dispose: vi.fn(),
              updatePresence: (state) => {
                presence.push(state);
              },
              requestAuthority: async (authority) => {
                requests.push(authority);
                return null;
              },
            },
          };
        },
      },
      "daemon-a",
    );
    const connect = (pane: string) =>
      transport.connect(
        {
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          target: { workspaceName: "workspace-a", semanticPaneId: pane },
          viewerMode: "interactive",
          geometryOwnership: "passive",
          viewport: { cols: 80, rows: 24 },
        },
        () => undefined,
      );
    const first = await connect("pane.workspace.a");
    const second = await connect("pane.workspace.b");
    await Promise.resolve();
    expect(requests).toEqual(["focus"]);
    expect(presence).toEqual(["foreground"]);
    listeners[0]!.onAuthoritySnapshot?.({
      generation: "11111111-1111-4111-8111-111111111111",
      session: "runtime-a",
      revision: 2,
      owners: { input: "other", focus: "other", geometry: "other" },
      nativeGeometryYieldUntilMs: 0,
      clients: [],
    });
    for (let index = 0; index < 100; index += 1) globalThis.dispatchEvent(new Event("focus"));
    expect(requests).toEqual(["focus"]);
    focused = false;
    globalThis.dispatchEvent(new Event("blur"));
    focused = true;
    globalThis.dispatchEvent(new Event("focus"));
    expect(requests).toEqual(["focus", "focus"]);
    expect(presence).toEqual(["foreground", "background", "foreground"]);
    if (first.status !== "connected" || second.status !== "connected")
      throw new Error("not connected");
    first.attachment.dispose();
    await Promise.resolve();
    expect(requests).toEqual(["focus", "focus", "focus"]);
    second.attachment.dispose();
    focused = false;
    globalThis.dispatchEvent(new Event("blur"));
    focused = true;
    globalThis.dispatchEvent(new Event("focus"));
    expect(requests).toHaveLength(3);
  });

  it("publishes one focus activity per foreground leader epoch and rearms on loss", async () => {
    const evidenceHost = globalThis as typeof globalThis & {
      __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
      __TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__?: () => {
        count: number;
        events: readonly { kind: string; surface: string }[];
      };
    };
    evidenceHost.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const stream = createScriptedPaneStream();
    const transport = createPaneStreamNativeTerminalTransport(stream.transport, "daemon-a");
    const connect = (semanticPaneId: string) =>
      transport.connect(
        {
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          target: { workspaceName: "workspace-a", semanticPaneId },
          viewerMode: "interactive",
          geometryOwnership: "passive",
          viewport: { cols: 80, rows: 24 },
        },
        () => undefined,
      );
    const first = await connect("pane.workspace.a");
    const second = await connect("pane.workspace.b");
    expect(first.status).toBe("connected");
    expect(second.status).toBe("connected");
    await Promise.resolve();
    for (const session of stream.sessions) {
      session.presence.length = 0;
      session.activity.length = 0;
    }

    for (let index = 0; index < 10_000; index += 1) {
      globalThis.dispatchEvent(new Event("focus"));
    }
    expect(stream.sessions.flatMap(({ presence }) => presence)).toEqual([]);
    expect(stream.sessions.flatMap(({ activity }) => activity)).toEqual([]);

    focused = false;
    globalThis.dispatchEvent(new Event("blur"));
    focused = true;
    globalThis.dispatchEvent(new Event("focus"));
    expect(stream.sessions.flatMap(({ presence }) => presence)).toEqual([
      "background",
      "foreground",
    ]);
    expect(stream.sessions.flatMap(({ activity }) => activity)).toEqual(["focus"]);

    for (const session of stream.sessions) {
      session.presence.length = 0;
      session.activity.length = 0;
    }
    const authority = (focusOwner: string | null, revision: number) => ({
      generation: "11111111-1111-4111-8111-111111111111",
      session: "runtime-a",
      revision,
      owners: { input: "opentui-a", focus: focusOwner, geometry: "web-a" },
      nativeGeometryYieldUntilMs: 0,
      clients: [
        {
          clientId: "opentui-a",
          surface: "opentui" as const,
          state: "foreground" as const,
          connectedRevision: 1,
          activityRevision: revision,
        },
      ],
    });
    stream.sessions[0]!.authority(authority("opentui-a", 20));
    for (let index = 0; index < 10_000; index += 1) {
      stream.sessions[0]!.authority(authority(index % 2 === 0 ? "web-a" : "opentui-a", 21 + index));
      globalThis.dispatchEvent(new Event("focus"));
    }
    await Promise.resolve();
    expect(stream.sessions.flatMap(({ activity }) => activity)).toEqual([]);
    focused = false;
    globalThis.dispatchEvent(new Event("blur"));
    focused = true;
    globalThis.dispatchEvent(new Event("focus"));
    expect(stream.sessions.flatMap(({ activity }) => activity)).toEqual(["focus"]);

    if (first.status === "connected") first.attachment.dispose();
    await Promise.resolve();
    for (const session of stream.sessions) {
      session.presence.length = 0;
      session.activity.length = 0;
    }
    globalThis.dispatchEvent(new Event("focus"));
    expect(stream.sessions.flatMap(({ presence }) => presence)).toEqual([]);
    expect(stream.sessions.flatMap(({ activity }) => activity)).toEqual([]);
    const mutationEvidence = evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__?.();
    expect(mutationEvidence?.count).toBe(4);
    expect(mutationEvidence?.events).toEqual(
      Array.from({ length: 4 }, () => ({
        ordinal: expect.any(Number),
        surface: "web",
        kind: "focus",
        outcome: "ok",
        operationOrdinal: null,
        cols: null,
        rows: null,
      })),
    );
    if (second.status === "connected") second.attachment.dispose();
    delete evidenceHost.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
    delete evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__;
  });
});
