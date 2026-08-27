/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type {
  TerminalAttachRequest,
  TerminalAttachmentSemanticTarget,
  TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

import { TerminalSurface, readOnlyTerminalFitScale } from "./terminal-surface.tsx";
import type {
  NativeTerminalAttachment,
  NativeTerminalConnectResult,
  NativeTerminalEvent,
  NativeTerminalTransport,
} from "./native-terminal-transport.ts";
import type { TerminalRenderer, TerminalRendererFactory } from "./xterm-renderer.ts";
import {
  WIDGET_MARKER_CONCEAL_PREFIX,
  WIDGET_MARKER_CONCEAL_SUFFIX,
  widgetMarkerAnnouncement,
  type WidgetCellRow,
} from "@tmux-ide/contracts";
import surfaceSource from "./terminal-surface.tsx?raw";
import transportSource from "./native-terminal-transport.ts?raw";
import xtermSource from "./xterm-renderer.ts?raw";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

describe("readOnlyTerminalFitScale", () => {
  it("fits the whole shared grid without enlarging it", () => {
    expect(
      readOnlyTerminalFitScale({
        availableWidth: 1_000,
        availableHeight: 500,
        gridWidth: 2_000,
        gridHeight: 1_000,
      }),
    ).toBe(0.5);
    expect(
      readOnlyTerminalFitScale({
        availableWidth: 1_000,
        availableHeight: 500,
        gridWidth: 500,
        gridHeight: 250,
      }),
    ).toBe(1);
  });
});

const TARGET_A: TerminalAttachmentSemanticTarget = {
  workspaceName: "workspace-a",
  semanticPaneId: "agent-a",
};
const TARGET_B: TerminalAttachmentSemanticTarget = {
  workspaceName: "workspace-b",
  semanticPaneId: "agent-b",
};
const TARGET_C: TerminalAttachmentSemanticTarget = {
  workspaceName: "workspace-c",
  semanticPaneId: "agent-c",
};

function connectedState(
  clientViewport: TerminalAttachmentViewport = { cols: 80, rows: 24 },
  sourceGrid: TerminalAttachmentViewport = clientViewport,
): NativeTerminalEvent {
  return { type: "state", state: "connected", error: null, sourceGrid, clientViewport };
}

class ResizeObserverHarness {
  static readonly active: ResizeObserverHarness[] = [];
  readonly callback: ResizeObserverCallback;
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverHarness.active.push(this);
  }

  observe(): void {}
  unobserve(): void {}
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function rendererHarness(
  initialViewport: TerminalAttachmentViewport = { cols: 80, rows: 24 },
  presentation: ReturnType<NonNullable<TerminalRenderer["readPresentation"]>> | null = null,
) {
  let viewport = initialViewport;
  let input: ((bytes: Uint8Array) => void) | null = null;
  const writes: Uint8Array[] = [];
  const disposeInput = vi.fn(() => (input = null));
  const cellRows: WidgetCellRow[] = [];
  const renderer: TerminalRenderer = {
    open: vi.fn(),
    readCellRows: vi.fn(() => cellRows),
    write: vi.fn(async (bytes) => {
      writes.push(bytes);
    }),
    ...(presentation ? { readPresentation: vi.fn(() => presentation) } : {}),
    probeRendition: vi.fn(async () => ({
      renditionHmac: "a".repeat(64),
      positionWrappedHmac: "b".repeat(64),
      graphemeWidthHmac: "c".repeat(64),
      colorHmac: "d".repeat(64),
      attributesHmac: "e".repeat(64),
      cellHmacs: Object.freeze(["f".repeat(64)]),
      defaultForeground: "#e6e8f2",
      defaultBackground: "#12131a",
      rendererCols: viewport.cols,
      rendererRows: viewport.rows,
      renditionCellCount: 1,
      wideContinuationCount: 0,
      combiningCount: 0,
      styledCellCount: 1,
    })),
    focus: vi.fn(),
    fit: vi.fn(() => viewport),
    resizeGrid: vi.fn((next) => {
      viewport = next;
    }),
    refreshTheme: vi.fn(),
    setReducedMotion: vi.fn(),
    onInput: vi.fn((listener) => {
      input = listener;
      return { dispose: disposeInput };
    }),
    dispose: vi.fn(),
  };
  const factory: TerminalRendererFactory = vi.fn(() => renderer);
  return {
    renderer,
    factory,
    writes,
    disposeInput,
    emitInput(bytes: Uint8Array) {
      input?.(bytes);
    },
    setViewport(next: TerminalAttachmentViewport) {
      viewport = next;
    },
    /** Replace what the emulator would report as its grid, for widget detection. */
    setCellRows(rows: readonly WidgetCellRow[]) {
      cellRows.length = 0;
      cellRows.push(...rows);
    },
  };
}

function rendererFleetHarness(
  initialViewport: TerminalAttachmentViewport = { cols: 80, rows: 24 },
) {
  const instances: Array<ReturnType<typeof rendererHarness>> = [];
  const factory: TerminalRendererFactory = vi.fn(() => {
    const instance = rendererHarness(initialViewport);
    instances.push(instance);
    return instance.renderer;
  });
  return { factory, instances };
}

/**
 * The grid an emulator would hold after printing `announcement`: the conceal
 * codes are consumed by the parser and never reach a cell, so what the rows
 * carry is the marker text alone.
 */
function markerCellRows(announcement: string): WidgetCellRow[] {
  const line = announcement
    .replaceAll(WIDGET_MARKER_CONCEAL_PREFIX, "")
    .replaceAll(WIDGET_MARKER_CONCEAL_SUFFIX, "")
    .trimEnd();
  return [{ cells: [...line], wrapped: false }];
}

function attachmentHarness(overrides: Partial<NativeTerminalAttachment> = {}) {
  return {
    write: vi.fn(async () => ({ status: "ok" as const })),
    resize: vi.fn(async () => ({ status: "ok" as const })),
    dispose: vi.fn(),
    ...overrides,
  } satisfies NativeTerminalAttachment;
}

function transportHarness(connect: NativeTerminalTransport["connect"]): NativeTerminalTransport {
  return { connect: vi.fn(connect) };
}

beforeEach(() => {
  ResizeObserverHarness.active.length = 0;
  let nextFrame = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverHarness);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    queueMicrotask(() => callback(id));
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__;
  delete (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__;
  delete (globalThis as Record<string, unknown>).__TMUX_IDE_ANSI_RENDITION_RENDERERS__;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("TerminalSurface", () => {
  it("does zero rendition probe work and publishes no rendition DOM state when disabled", async () => {
    const root = document.body.appendChild(document.createElement("div"));
    const renderer = rendererHarness();
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          focused
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await Promise.resolve();
    expect(renderer.renderer.probeRendition).not.toHaveBeenCalled();
    expect(root.querySelector("[data-terminal-rendition-projection]")).toBeNull();
    expect(
      (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__,
    ).toBeUndefined();
    dispose();
  });

  it("registers one selected-pane detailed probe and cleans it up without raw state", async () => {
    (globalThis as Record<string, unknown>).__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
    const root = document.body.appendChild(document.createElement("div"));
    const renderer = rendererHarness();
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          focused
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await Promise.resolve();
    const probe = (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__ as (
      paneId: string,
      keyHex: string,
    ) => Promise<unknown>;
    await expect(probe(TARGET_A.semanticPaneId, "07".repeat(32))).resolves.toBeNull();
    await expect(probe(TARGET_B.semanticPaneId, "07".repeat(32))).resolves.toBeNull();
    expect(renderer.renderer.probeRendition).not.toHaveBeenCalled();
    expect(root.querySelector("[data-terminal-rendition-projection]")).toBeNull();
    dispose();
    expect(
      (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__,
    ).toBeUndefined();
  });

  it("renders an explicit unavailable surface without a production transport", () => {
    const root = document.body.appendChild(document.createElement("div"));
    const renderer = rendererHarness();
    const dispose = render(
      () => <TerminalSurface target={TARGET_A} title="Codex" rendererFactory={renderer.factory} />,
      root,
    );

    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("unavailable");
    expect(root.textContent).toContain("Native terminal unavailable");
    expect(root.innerHTML).toMatchSnapshot();
    dispose();
    expect(renderer.renderer.dispose).toHaveBeenCalledOnce();
  });

  it("probes actual xterm and canonical state only in detailed mode without DOM proof attrs", async () => {
    (globalThis as Record<string, unknown>).__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness(
      { cols: 80, rows: 24 },
      {
        activeBuffer: "alternate",
        cursorX: 11,
        cursorY: 7,
        cursorHidden: true,
        cursorStyle: "underline",
        cursorBlink: false,
      },
    );
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          focused
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const emit = listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null;
    if (!emit) throw new Error("terminal listener was unavailable");
    await emit({
      type: "output",
      bytes: new TextEncoder().encode("alt"),
      canonical: {
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 9,
        stateHash: "state-a",
        cols: 80,
        rows: 24,
        sourceEpoch: 2,
        alternateScreen: true,
        cursor: { x: 11, y: 7, hidden: true, style: "underline", blink: false },
        gridRowsRead: 0,
        gridCellsRead: 0,
        fullGridWalks: 0,
      },
    });
    const probe = (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__ as (
      paneId: string,
      keyHex: string,
    ) => Promise<unknown>;
    const surface = root.querySelector(".terminal-surface");
    await expect(probe(TARGET_A.semanticPaneId, "07".repeat(32))).resolves.toEqual({
      surface,
      presentation: {
        activeBuffer: "alternate",
        cursorX: 11,
        cursorY: 7,
        cursorHidden: true,
        cursorStyle: "underline",
        cursorBlink: false,
      },
      canonical: {
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 9,
        stateHash: "state-a",
        cols: 80,
        rows: 24,
        sourceEpoch: 2,
        rendererEpoch: 1,
        alternateScreen: true,
        cursor: { x: 11, y: 7, hidden: true, style: "underline", blink: false },
        gridRowsRead: 0,
        gridCellsRead: 0,
        fullGridWalks: 0,
      },
      rendition: {
        renditionHmac: "a".repeat(64),
        positionWrappedHmac: "b".repeat(64),
        graphemeWidthHmac: "c".repeat(64),
        colorHmac: "d".repeat(64),
        attributesHmac: "e".repeat(64),
        cellHmacs: ["f".repeat(64)],
        defaultForeground: "#e6e8f2",
        defaultBackground: "#12131a",
        rendererCols: 80,
        rendererRows: 24,
        renditionCellCount: 1,
        wideContinuationCount: 0,
        combiningCount: 0,
        styledCellCount: 1,
      },
    });
    expect(
      surface?.getAttributeNames().filter((name) => name.startsWith("data-terminal-")),
    ).toEqual([]);
    dispose();
  });

  it("does no ProductRig presentation work on a real output when diagnostics are disabled", async () => {
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness(
      { cols: 80, rows: 24 },
      {
        activeBuffer: "normal",
        cursorX: 1,
        cursorY: 2,
        cursorHidden: false,
        cursorStyle: "block",
        cursorBlink: false,
      },
    );
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          focused
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const emit = listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null;
    if (!emit) throw new Error("terminal listener was unavailable");
    await emit({
      type: "output",
      bytes: new Uint8Array([65]),
      canonical: {
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 1,
        stateHash: "0123456789abcdef",
        cols: 80,
        rows: 24,
        sourceEpoch: 1,
        alternateScreen: false,
        cursor: { x: 1, y: 2, hidden: false, style: "block", blink: false },
        gridRowsRead: 0,
        gridCellsRead: 0,
        fullGridWalks: 0,
      },
    });
    expect(renderer.renderer.readPresentation).not.toHaveBeenCalled();
    expect(renderer.renderer.probeRendition).not.toHaveBeenCalled();
    expect(
      root
        .querySelector(".terminal-surface")
        ?.getAttributeNames()
        .filter((name) => name.startsWith("data-terminal-")),
    ).toEqual([]);
    expect(
      (globalThis as Record<string, unknown>).__TMUX_IDE_PROBE_TERMINAL_RENDITION__,
    ).toBeUndefined();
    dispose();
  });

  it("mirrors the origin window grid and never reflows tmux when size-passive", async () => {
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
          geometryOwnership="passive"
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    // Size-passive attaches with a provisional viewport tmux ignores, not a DOM fit.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { cols: 80, rows: 24 } }),
      expect.any(Function),
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );

    (listener as ((event: NativeTerminalEvent) => void) | null)?.({
      type: "geometry",
      sourceGrid: { cols: 200, rows: 50 },
      clientViewport: { cols: 200, rows: 50 },
    });
    expect(renderer.renderer.resizeGrid).toHaveBeenCalledWith({ cols: 200, rows: 50 });

    // A DOM resize must re-assert the window grid, never resize the origin window.
    for (const observer of ResizeObserverHarness.active) observer.trigger();
    await Promise.resolve();
    await Promise.resolve();
    expect(attachment.resize).not.toHaveBeenCalled();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-size-passive")).toBe("true");
    dispose();
  });

  it("applies retained and per-delivery canonical grids before passive early output", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness({ cols: 162, rows: 51 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
          geometryOwnership="passive"
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const emit = listener as unknown as (event: NativeTerminalEvent) => void | Promise<void>;
    if (!emit) throw new Error("terminal listener was unavailable");
    emit({
      type: "state",
      state: "connected",
      error: null,
      sourceGrid: { cols: 132, rows: 41 },
      clientViewport: { cols: 132, rows: 41 },
    });
    const canonical = {
      generation: "generation-a",
      incarnation: "incarnation-a",
      revision: 1,
      stateHash: "0123456789abcdef",
      cols: 132,
      rows: 41,
      sourceEpoch: 1,
      alternateScreen: false,
      cursor: { x: 6, y: 3, hidden: false, style: "bar" as const, blink: true },
      gridRowsRead: 3,
      gridCellsRead: 396,
      fullGridWalks: 0,
    };
    await emit({ type: "output", bytes: new Uint8Array([65]), canonical });
    expect(renderer.renderer.resizeGrid).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    expect(vi.mocked(renderer.renderer.resizeGrid).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(renderer.renderer.write).mock.invocationCallOrder.at(-1)!,
    );
    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );
    expect(renderer.renderer.resizeGrid).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    expect(attachment.resize).not.toHaveBeenCalled();
    await emit({
      type: "output",
      bytes: new Uint8Array([66]),
      canonical: { ...canonical, revision: 2, cols: 162, rows: 51 },
    });
    expect(renderer.renderer.resizeGrid).toHaveBeenLastCalledWith({ cols: 162, rows: 51 });
    expect(vi.mocked(renderer.renderer.resizeGrid).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(renderer.renderer.write).mock.invocationCallOrder.at(-1)!,
    );
    expect(attachment.resize).not.toHaveBeenCalled();
    dispose();
  });

  it("asks the daemon to own geometry and fits tmux to the card", async () => {
    /*
     * The renderer half of m50.2 gap 1.
     *
     * Two claims, and both matter. The request must SAY `owner` — the daemon
     * decides whether to drop `-f ignore-size` from that word alone, so a
     * surface that behaves like an owner without asking to be one gets a client
     * whose size tmux discards. And the measured fit must reach the attachment
     * rather than the window's reported grid being mirrored back, which is what
     * the passive path does one test above.
     */
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    renderer.setViewport({ cols: 118, rows: 38 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
          geometryOwnership="owner"
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        geometryOwnership: "owner",
        // The DOM measurement, not the provisional 80x24 a passive attach opens
        // with: an owner knows its size before it asks for a client.
        viewport: { cols: 118, rows: 38 },
      }),
      expect.any(Function),
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-size-passive")).toBe(
      "false",
    );

    /*
     * The origin window reporting a DIFFERENT grid does not win.
     *
     * Bug this catches: the surface keeps the passive reflex of mirroring
     * whatever tmux reports, so the card silently follows the window instead of
     * the window following the card — the letterbox returns with the ownership
     * flag still set, which is the confusing half-broken state.
     */
    (listener as ((event: NativeTerminalEvent) => void) | null)?.({
      type: "geometry",
      sourceGrid: { cols: 80, rows: 24 },
      clientViewport: { cols: 80, rows: 24 },
    });
    await vi.waitFor(() => expect(attachment.resize).toHaveBeenCalledWith({ cols: 118, rows: 38 }));
    expect(renderer.renderer.resizeGrid).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    dispose();
  });

  it("forwards early binary output and serializes terminal input writes", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    const firstWrite = deferred<void>();
    const writeOrder: number[] = [];
    const attachment = attachmentHarness({
      write: vi.fn(async (bytes: Uint8Array) => {
        writeOrder.push(bytes[0]!);
        if (writeOrder.length === 1) await firstWrite.promise;
        return { status: "ok" as const };
      }),
    });
    let listener: ((event: NativeTerminalEvent) => void) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(transport.connect).toHaveBeenCalledWith(
      {
        protocolVersion: 1,
        target: TARGET_A,
        viewerMode: "interactive",
        geometryOwnership: "passive",
        viewport: { cols: 80, rows: 24 },
      },
      expect.any(Function),
    );
    await Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new Uint8Array([27, 91, 65]),
      }),
    );
    expect(renderer.writes).toEqual([new Uint8Array([27, 91, 65])]);

    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
      "true",
    );
    renderer.emitInput(new Uint8Array([1]));
    renderer.emitInput(new Uint8Array([2]));
    await vi.waitFor(() => expect(writeOrder).toEqual([1]));
    firstWrite.resolve();
    await vi.waitFor(() => expect(writeOrder).toEqual([1, 2]));

    dispose();
    expect(attachment.dispose).toHaveBeenCalledOnce();
  });

  it("names every renderer-visible first-attach boundary through first paint", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    const surface = (): HTMLElement => root.querySelector<HTMLElement>(".terminal-surface")!;
    const trace = (): Array<{ phase: string; atMs: number }> =>
      JSON.parse(surface().getAttribute("data-attach-trace") ?? "[]") as Array<{
        phase: string;
        atMs: number;
      }>;

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(surface().getAttribute("data-phase")).toBe("connecting");
    expect(surface().getAttribute("data-attach-phase")).toBe("attach-requested");
    expect(trace().map((entry) => entry.phase)).toEqual([
      "renderer-loading",
      "renderer-ready",
      "attach-requested",
    ]);

    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() => expect(surface().getAttribute("data-phase")).toBe("connected"));
    expect(surface().getAttribute("data-attach-phase")).toBe("awaiting-first-output");
    expect(root.textContent).toContain("Loading terminal contents");
    expect(root.textContent).toContain("waiting for xterm to paint its first frame");

    await Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new Uint8Array([27, 91, 65]),
      }),
    );
    expect(surface().getAttribute("data-attach-phase")).toBe("live");
    expect(root.querySelector(".terminal-surface__state")).toBeNull();
    expect(trace().map((entry) => entry.phase)).toEqual([
      "renderer-loading",
      "renderer-ready",
      "attach-requested",
      "attachment-ready",
      "awaiting-first-output",
      "first-output-received",
      "painting-first-frame",
      "live",
    ]);
    expect(
      trace().every(
        (entry, index, entries) => index === 0 || entry.atMs >= entries[index - 1]!.atMs,
      ),
    ).toBe(true);
    expect(surface().getAttribute("data-attach-trace")).not.toMatch(
      /(?:ticket|daemon|tmuxPaneId|runtimePaneId|workspace-a|agent-a)/u,
    );
    dispose();
  });

  it("names an owner attach that is waiting for a usable viewport", async () => {
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness({ cols: 0, rows: 0 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-phase")).toBe(
        "waiting-for-viewport",
      ),
    );
    expect(transport.connect).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Waiting for enough pane space");
    dispose();
  });

  it("acknowledges ordered output only after the renderer write callback settles", async () => {
    const firstWrite = deferred<void>();
    const writeOrder: number[] = [];
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    vi.mocked(renderer.renderer.write).mockImplementation(async (bytes) => {
      writeOrder.push(bytes[0]!);
      if (writeOrder.length === 1) await firstWrite.promise;
    });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    let firstAcknowledged = false;
    let secondAcknowledged = false;
    const firstAck = Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new Uint8Array([1]),
      }),
    ).then(() => {
      firstAcknowledged = true;
    });
    const secondAck = Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new Uint8Array([2]),
      }),
    ).then(() => {
      secondAcknowledged = true;
    });
    await vi.waitFor(() => expect(writeOrder).toEqual([1]));
    expect(firstAcknowledged).toBe(false);
    expect(secondAcknowledged).toBe(false);

    firstWrite.resolve();
    await firstAck;
    await vi.waitFor(() => expect(writeOrder).toEqual([1, 2]));
    await secondAck;
    expect(firstAcknowledged).toBe(true);
    expect(secondAcknowledged).toBe(true);
    dispose();
  });

  it("focuses the renderer when semantic focus changes", async () => {
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness();
    const [focused, setFocused] = createSignal(false);
    const [focusRequest, setFocusRequest] = createSignal(0);
    const [reducedMotion, setReducedMotion] = createSignal(false);
    const [themeKey, setThemeKey] = createSignal("dark:false");
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          focused={focused()}
          focusRequest={focusRequest()}
          reducedMotion={reducedMotion()}
          themeKey={themeKey()}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(renderer.renderer.focus).not.toHaveBeenCalled();
    setFocused(true);
    await vi.waitFor(() => expect(renderer.renderer.focus).toHaveBeenCalledOnce());
    setFocusRequest(1);
    await vi.waitFor(() => expect(renderer.renderer.focus).toHaveBeenCalledTimes(2));
    const themeRefreshesBeforeChange = vi.mocked(renderer.renderer.refreshTheme).mock.calls.length;
    setReducedMotion(true);
    setThemeKey("light:true");
    await vi.waitFor(() =>
      expect(renderer.renderer.setReducedMotion).toHaveBeenLastCalledWith(true),
    );
    expect(renderer.renderer.refreshTheme).toHaveBeenCalledTimes(themeRefreshesBeforeChange + 1);
    dispose();
  });

  it("coalesces viewport changes behind one ordered resize flight", async () => {
    const firstResize = deferred<void>();
    const resizeOrder: TerminalAttachmentViewport[] = [];
    const attachment = attachmentHarness({
      resize: vi.fn(async (viewport: TerminalAttachmentViewport) => {
        resizeOrder.push(viewport);
        if (resizeOrder.length === 1) await firstResize.promise;
        return { status: "ok" as const };
      }),
    });
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState());
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    renderer.setViewport({ cols: 100, rows: 30 });
    ResizeObserverHarness.active[0]!.trigger();
    await vi.waitFor(() => expect(resizeOrder).toEqual([{ cols: 100, rows: 30 }]));
    renderer.setViewport({ cols: 120, rows: 40 });
    ResizeObserverHarness.active[0]!.trigger();
    expect(resizeOrder).toEqual([{ cols: 100, rows: 30 }]);
    firstResize.resolve();
    await vi.waitFor(() =>
      expect(resizeOrder).toEqual([
        { cols: 100, rows: 30 },
        { cols: 120, rows: 40 },
      ]),
    );
    dispose();
  });

  it("coalesces viewport measurements while connect is delayed", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const attachment = attachmentHarness({
      resize: vi.fn(async (viewport: TerminalAttachmentViewport) => {
        await (listener as (event: NativeTerminalEvent) => void | Promise<void>)({
          type: "geometry",
          sourceGrid: viewport,
          clientViewport: viewport,
        });
        return { status: "ok" as const };
      }),
    });
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ viewport: { cols: 80, rows: 24 } }),
      expect.any(Function),
    );

    let fitCalls = vi.mocked(renderer.renderer.fit).mock.calls.length;
    renderer.setViewport({ cols: 100, rows: 30 });
    ResizeObserverHarness.active[0]!.trigger();
    await vi.waitFor(() => expect(renderer.renderer.fit).toHaveBeenCalledTimes(fitCalls + 1));
    fitCalls += 1;
    renderer.setViewport({ cols: 120, rows: 40 });
    ResizeObserverHarness.active[0]!.trigger();
    await vi.waitFor(() => expect(renderer.renderer.fit).toHaveBeenCalledTimes(fitCalls + 1));
    expect(attachment.resize).not.toHaveBeenCalled();

    await (listener as unknown as (event: NativeTerminalEvent) => void | Promise<void>)(
      connectedState(),
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-source-grid")).toBe("80x24");
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-client-viewport")).toBe(
      "80x24",
    );
    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() => expect(attachment.resize).toHaveBeenCalledWith({ cols: 120, rows: 40 }));
    expect(attachment.resize).toHaveBeenCalledOnce();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-client-viewport")).toBe(
      "120x40",
    );

    ResizeObserverHarness.active[0]!.trigger();
    await Promise.resolve();
    expect(attachment.resize).toHaveBeenCalledOnce();
    dispose();
  });

  it("keeps a validated 39x24 frame and input while making conflicting 140x46 geometry passive", async () => {
    const requests: TerminalAttachRequest[] = [];
    const ownerAttachment = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: {
          code: "geometry-authority-conflict",
          reason: "Another client controls terminal geometry.",
          retryable: true,
        },
      })),
    });
    const passiveAttachment = attachmentHarness();
    const transport = transportHarness(async (request, listener) => {
      requests.push(request);
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      await listener({ type: "output", bytes: new TextEncoder().encode("authoritative frame") });
      return {
        status: "connected" as const,
        attachment: request.geometryOwnership === "owner" ? ownerAttachment : passiveAttachment,
      };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );
    expect(requests).toEqual([
      expect.objectContaining({
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 140, rows: 46 },
      }),
      expect.objectContaining({
        viewerMode: "interactive",
        geometryOwnership: "passive",
      }),
    ]);
    expect(ownerAttachment.resize).toHaveBeenCalledOnce();
    expect(passiveAttachment.resize).not.toHaveBeenCalled();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
      "interactive",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
      "true",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "geometry-authority-conflict",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      "geometry-authority-conflict",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-ordinal")).toBe("1");
    renderer.emitInput(new TextEncoder().encode("marker"));
    await vi.waitFor(() => expect(passiveAttachment.write).toHaveBeenCalledOnce());
    expect(passiveAttachment.resize).not.toHaveBeenCalled();
    dispose();
  });

  it("does not let a stale resize conflict downgrade a replacement target", async () => {
    const lateResize = deferred<Awaited<ReturnType<NativeTerminalAttachment["resize"]>>>();
    const oldAttachment = attachmentHarness({ resize: vi.fn(() => lateResize.promise) });
    const replacementAttachment = attachmentHarness();
    let attempts = 0;
    const transport = transportHarness(async (_request, listener) => {
      attempts += 1;
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return {
        status: "connected" as const,
        attachment: attempts === 1 ? oldAttachment : replacementAttachment,
      };
    });
    const [target, setTarget] = createSignal(TARGET_A);
    const renderer = rendererFleetHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={target()}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(oldAttachment.resize).toHaveBeenCalledOnce());
    setTarget(TARGET_B);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    lateResize.resolve({
      status: "error",
      error: {
        code: "geometry-authority-conflict",
        reason: "stale conflict",
        retryable: true,
      },
    });
    await Promise.resolve();
    expect(transport.connect).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
      "interactive",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "none",
    );
    dispose();
  });

  it("does not let a resize conflict reconnect after disposal", async () => {
    const lateResize = deferred<Awaited<ReturnType<NativeTerminalAttachment["resize"]>>>();
    const attachment = attachmentHarness({ resize: vi.fn(() => lateResize.promise) });
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(attachment.resize).toHaveBeenCalledOnce());
    dispose();
    lateResize.resolve({
      status: "error",
      error: {
        code: "geometry-authority-conflict",
        reason: "late conflict",
        retryable: true,
      },
    });
    await Promise.resolve();
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(attachment.dispose).toHaveBeenCalledOnce();
  });

  it("keeps generic resize failures fatal", async () => {
    const attachment = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: { code: "workspace-client-unavailable", reason: "resize failed", retryable: true },
      })),
    });
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
      "interactive",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "resize-rejected",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      "failed",
    );
    dispose();
  });

  it("reconnects once when a viewport resize crosses a retired physical lifecycle", async () => {
    const retired = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: {
          code: "geometry-lifecycle-retired",
          reason: "the physical runtime was replaced",
          retryable: false,
        },
      })),
    });
    const replacement = attachmentHarness();
    let attempt = 0;
    const transport = transportHarness(async (_request, listener) => {
      attempt += 1;
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return { status: "connected", attachment: attempt === 1 ? retired : replacement };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(replacement.resize).toHaveBeenCalledOnce());
    expect(retired.dispose).toHaveBeenCalledOnce();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected");
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "none",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      "none",
    );
    dispose();
  });

  it("completes lifecycle recovery on the replacement first frame when no resize is needed", async () => {
    const retired = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: {
          code: "geometry-lifecycle-retired",
          reason: "runtime A retired",
          retryable: false,
        },
      })),
    });
    const replacement = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: {
          code: "geometry-lifecycle-retired",
          reason: "a later independent runtime retired",
          retryable: false,
        },
      })),
    });
    const finalAttachment = attachmentHarness();
    const attachments = [retired, replacement, finalAttachment];
    let attempt = 0;
    const transport = transportHarness(async (_request, listener) => {
      const index = attempt++;
      const replacementFrame = index > 0;
      await listener(
        connectedState(
          replacementFrame ? { cols: 140, rows: 46 } : { cols: 39, rows: 24 },
          replacementFrame ? { cols: 140, rows: 46 } : { cols: 39, rows: 24 },
        ),
      );
      if (replacementFrame) await listener({ type: "output", bytes: new Uint8Array([65]) });
      return { status: "connected", attachment: attachments[index]! };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    expect(replacement.resize).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code"),
      ).toBe("none"),
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      "none",
    );

    renderer.setViewport({ cols: 150, rows: 50 });
    ResizeObserverHarness.active.at(-1)?.trigger();
    await vi.waitFor(() => expect(replacement.resize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(3));
    expect(finalAttachment.dispose).not.toHaveBeenCalled();
    dispose();
  });

  it("gives a replacement target its own lifecycle retry and ignores late A", async () => {
    const lateA = deferred<Awaited<ReturnType<NativeTerminalAttachment["resize"]>>>();
    const attachmentA = attachmentHarness({ resize: vi.fn(() => lateA.promise) });
    const attachmentB = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: {
          code: "geometry-lifecycle-retired",
          reason: "runtime B retired",
          retryable: false,
        },
      })),
    });
    const replacementB = attachmentHarness();
    const attachments = [attachmentA, attachmentB, replacementB];
    let attempt = 0;
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      await listener({ type: "output", bytes: new Uint8Array([65]) });
      return { status: "connected", attachment: attachments[attempt++]! };
    });
    const [target, setTarget] = createSignal(TARGET_A);
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={target()}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(attachmentA.resize).toHaveBeenCalledOnce());
    setTarget(TARGET_B);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    renderer.setViewport({ cols: 150, rows: 50 });
    ResizeObserverHarness.active.at(-1)?.trigger();
    await vi.waitFor(() => expect(attachmentB.resize).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(3));
    lateA.resolve({
      status: "error",
      error: {
        code: "geometry-lifecycle-retired",
        reason: "late retired A",
        retryable: false,
      },
    });
    await Promise.resolve();
    expect(transport.connect).toHaveBeenCalledTimes(3);
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected");
    dispose();
  });

  it("keeps a second lifecycle retirement fatal instead of looping across A-to-B-to-A churn", async () => {
    const attachments = [
      attachmentHarness({
        resize: vi.fn(async () => ({
          status: "error" as const,
          error: {
            code: "geometry-lifecycle-retired",
            reason: "runtime A retired",
            retryable: false,
          },
        })),
      }),
      attachmentHarness({
        resize: vi.fn(async () => ({
          status: "error" as const,
          error: {
            code: "geometry-lifecycle-retired",
            reason: "replacement B retired",
            retryable: false,
          },
        })),
      }),
    ];
    let attempt = 0;
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      await listener({ type: "output", bytes: new Uint8Array([65]) });
      return { status: "connected", attachment: attachments[attempt++]! };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );
    expect(transport.connect).toHaveBeenCalledTimes(2);
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      "lifecycle-retired",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "resize-rejected",
    );
    dispose();
  });

  it.each([
    ["geometry-authority-timeout", "authority-timeout"],
    ["geometry-viewport-timeout", "viewport-timeout"],
    ["pane-stream-closed", "stream-closed"],
  ] as const)("keeps %s fatal and exposes only its bounded outcome", async (code, outcome) => {
    const attachment = attachmentHarness({
      resize: vi.fn(async () => ({
        status: "error" as const,
        error: { code, reason: "bounded resize failure", retryable: false },
      })),
    });
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-resize-outcome")).toBe(
      outcome,
    );
    dispose();
  });

  it("keeps a thrown resize failure fatal", async () => {
    const attachment = attachmentHarness({
      resize: vi.fn(async () => {
        throw new Error("private transport failure");
      }),
    });
    const transport = transportHarness(async (_request, listener) => {
      await listener(connectedState({ cols: 39, rows: 24 }, { cols: 39, rows: 24 }));
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness({ cols: 140, rows: 46 });
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Electron"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-attach-failure-code")).toBe(
      "resize-exception",
    );
    expect(root.textContent).not.toContain("private transport failure");
    dispose();
  });

  it("fails closed on a typed host input rejection without starting a second writer", async () => {
    const attachment = attachmentHarness({
      write: vi.fn(async () => ({
        status: "error" as const,
        error: { code: "read-only", reason: "This terminal is read-only.", retryable: false },
      })),
    });
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    renderer.emitInput(new Uint8Array([3]));
    await vi.waitFor(() => expect(root.textContent).toContain("This terminal is read-only."));
    renderer.emitInput(new Uint8Array([4]));
    expect(attachment.write).toHaveBeenCalledOnce();
    expect(attachment.dispose).toHaveBeenCalledOnce();
    dispose();
  });

  it("ignores zero-byte input without calling the host", async () => {
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    renderer.emitInput(new Uint8Array());
    await Promise.resolve();

    expect(attachment.write).not.toHaveBeenCalled();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected");
    dispose();
  });

  it("fails closed at a bounded input entry count behind a stalled host write", async () => {
    const firstWrite = deferred<void>();
    const attachment = attachmentHarness({
      write: vi.fn(async () => {
        await firstWrite.promise;
        return { status: "ok" as const };
      }),
    });
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    renderer.emitInput(new Uint8Array([0]));
    await vi.waitFor(() => expect(attachment.write).toHaveBeenCalledOnce());
    for (let index = 1; index <= 64; index += 1) {
      renderer.emitInput(new Uint8Array([index]));
    }
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );

    expect(root.textContent).toContain("Terminal input exceeded the native forwarding buffer.");
    expect(attachment.dispose).toHaveBeenCalledOnce();
    expect(attachment.write).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(attachment.write).toHaveBeenCalledOnce();
    dispose();
  });

  it("fails closed before copying an input payload beyond the byte budget", async () => {
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => ({ status: "connected", attachment }));
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    renderer.emitInput(new Uint8Array(256 * 1024 + 1));
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
    );

    expect(attachment.write).not.toHaveBeenCalled();
    expect(attachment.dispose).toHaveBeenCalledOnce();
    dispose();
  });

  it("retires late connect, output, input, and resize work after unmount", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    dispose();

    await expect(
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    renderer.emitInput(new Uint8Array([2]));
    ResizeObserverHarness.active[0]!.trigger();
    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() => expect(attachment.dispose).toHaveBeenCalledOnce());
    expect(renderer.writes).toEqual([]);
    expect(attachment.write).not.toHaveBeenCalled();
    expect(attachment.resize).not.toHaveBeenCalled();
  });

  it("rejects a pending renderer acknowledgement during unmount", async () => {
    const blockedWrite = deferred<void>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    vi.mocked(renderer.renderer.write).mockImplementation(async () => blockedWrite.promise);
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const acknowledgment = expect(
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    await vi.waitFor(() => expect(renderer.renderer.write).toHaveBeenCalledOnce());
    dispose();
    await acknowledgment;
    blockedWrite.resolve();
  });

  it("retires pane-scoped authority immediately when the semantic target changes", async () => {
    const attachments = [attachmentHarness(), attachmentHarness()];
    const replacement = deferred<NativeTerminalConnectResult>();
    const listeners: Array<(event: NativeTerminalEvent) => void | Promise<void>> = [];
    let connectionIndex = 0;
    const transport = transportHarness(async (_request, listener) => {
      listeners.push(listener);
      const index = connectionIndex++;
      return index === 0
        ? { status: "connected", attachment: attachments[0]! }
        : replacement.promise;
    });
    const rendererFleet = rendererFleetHarness();
    const blockedWrite = deferred<void>();
    const [target, setTarget] = createSignal(TARGET_A);
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={target()}
          title="Codex"
          transport={transport}
          rendererFactory={rendererFleet.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const oldRenderer = rendererFleet.instances[0]!;
    vi.mocked(oldRenderer.renderer.write).mockImplementation(async () => blockedWrite.promise);
    const oldAcknowledgment = expect(
      Promise.resolve(listeners[0]!({ type: "output", bytes: new Uint8Array([1]) })),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    await vi.waitFor(() => expect(oldRenderer.renderer.write).toHaveBeenCalledOnce());
    setTarget(TARGET_B);
    await oldAcknowledgment;
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rendererFleet.instances).toHaveLength(2));
    const newRenderer = rendererFleet.instances[1]!;
    // Pane-scoped input authority is not a continuity token. The daemon binder
    // retains the host/session principal through the passive pane stream while
    // this old interactive grant is retired immediately.
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    replacement.resolve({ status: "connected", attachment: attachments[1]! });
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    expect(oldRenderer.renderer.dispose).toHaveBeenCalledOnce();
    expect(oldRenderer.disposeInput).toHaveBeenCalledOnce();
    expect(ResizeObserverHarness.active[0]!.disconnect).toHaveBeenCalledOnce();
    expect(transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: TARGET_B }),
      expect.any(Function),
    );
    await Promise.resolve(listeners[1]!({ type: "output", bytes: new Uint8Array([2]) }));
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
    blockedWrite.resolve();
    await Promise.resolve();
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
    dispose();
  });

  it("fences rapid A to pending B to C retargets without retaining A's pane grant", async () => {
    const attachments = [attachmentHarness(), attachmentHarness(), attachmentHarness()];
    const b = deferred<NativeTerminalConnectResult>();
    const c = deferred<NativeTerminalConnectResult>();
    let connectionIndex = 0;
    const transport = transportHarness(async () => {
      const index = connectionIndex++;
      if (index === 0) return { status: "connected", attachment: attachments[0]! };
      return index === 1 ? b.promise : c.promise;
    });
    const [target, setTarget] = createSignal(TARGET_A);
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={target()}
          title="Codex"
          transport={transport}
          rendererFactory={rendererFleetHarness().factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    setTarget(TARGET_B);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    setTarget(TARGET_C);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(3));
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    b.resolve({ status: "connected", attachment: attachments[1]! });
    await vi.waitFor(() => expect(attachments[1]!.dispose).toHaveBeenCalledOnce());
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    c.resolve({ status: "connected", attachment: attachments[2]! });
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    expect(attachments[2]!.dispose).not.toHaveBeenCalled();
    dispose();
  });

  it("replaces the renderer when terminal transport authority changes", async () => {
    const attachments = [attachmentHarness(), attachmentHarness()];
    let oldListener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    let newListener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const oldTransport = transportHarness(async (_request, listener) => {
      oldListener = listener;
      return { status: "connected", attachment: attachments[0]! };
    });
    const newTransport = transportHarness(async (_request, listener) => {
      newListener = listener;
      return { status: "connected", attachment: attachments[1]! };
    });
    const [transport, setTransport] = createSignal<NativeTerminalTransport>(oldTransport);
    const rendererFleet = rendererFleetHarness();
    const blockedWrite = deferred<void>();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport()}
          rendererFactory={rendererFleet.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(oldTransport.connect).toHaveBeenCalledOnce());
    const oldRenderer = rendererFleet.instances[0]!;
    vi.mocked(oldRenderer.renderer.write).mockImplementation(async () => blockedWrite.promise);
    const oldAcknowledgment = expect(
      Promise.resolve(
        (oldListener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    await vi.waitFor(() => expect(oldRenderer.renderer.write).toHaveBeenCalledOnce());

    setTransport(newTransport);
    await oldAcknowledgment;
    await vi.waitFor(() => expect(newTransport.connect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(rendererFleet.instances).toHaveLength(2));
    const newRenderer = rendererFleet.instances[1]!;
    expect(attachments[0]!.dispose).toHaveBeenCalledOnce();
    expect(oldRenderer.renderer.dispose).toHaveBeenCalledOnce();
    await Promise.resolve(
      (newListener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new Uint8Array([2]),
      }),
    );
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
    blockedWrite.resolve();
    await Promise.resolve();
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
    dispose();
  });

  it("rejects failed renderer output without validating a frame", async () => {
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    vi.mocked(renderer.renderer.write).mockRejectedValue(new Error("renderer failed"));
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );

    await expect(
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");

    expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
      "false",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error");
    expect(attachment.dispose).toHaveBeenCalledOnce();
    dispose();
  });

  it("rejects every unconsumed output acknowledgement when the queue overloads", async () => {
    const blockedWrite = deferred<void>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    vi.mocked(renderer.renderer.write).mockImplementation(async () => blockedWrite.promise);
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());

    const acknowledgements = Array.from({ length: 65 }, (_, index) =>
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([index]),
        }),
      ).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    const outcomes = await Promise.all(acknowledgements);

    expect(outcomes).toHaveLength(65);
    for (const outcome of outcomes) {
      expect(outcome).toEqual(
        expect.objectContaining({
          message: "Terminal output was not consumed by the renderer.",
        }),
      );
    }
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
      "false",
    );
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error");
    expect(attachment.dispose).toHaveBeenCalledOnce();
    blockedWrite.resolve();
    dispose();
  });

  it("rejects a late success after a pre-resolution disconnect", async () => {
    const connection = deferred<NativeTerminalConnectResult>();
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return connection.promise;
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    (listener as ((event: NativeTerminalEvent) => void) | null)?.({
      type: "state",
      state: "disconnected",
      error: null,
    });
    connection.resolve({ status: "connected", attachment });
    await vi.waitFor(() => expect(attachment.dispose).toHaveBeenCalledOnce());
    expect(root.textContent).toContain("Terminal disconnected");
    dispose();
  });

  it("retires a retryable typed connect failure before rejecting late output", async () => {
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return {
        status: "error",
        error: { code: "attach-failed", reason: "tmux attach failed", retryable: true },
      };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe(
        "disconnected",
      ),
    );

    await expect(
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    expect(renderer.renderer.write).not.toHaveBeenCalled();
    dispose();
  });

  it("recovers a transient held-lease conflict without a manual retry", async () => {
    let attempts = 0;
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => {
      attempts += 1;
      return attempts < 3
        ? {
            status: "error" as const,
            error: {
              code: "interactive-viewer-conflict" as const,
              reason: "The requested pane already has an interactive viewer.",
              retryable: true,
            },
          }
        : { status: "connected" as const, attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected"),
    );
    expect(attempts).toBe(3);
    expect(root.textContent).not.toContain("Terminal could not attach");
    dispose();
  });

  it("retries a transient replacement-lease failure without leaving a stale connected frame", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const attachment = attachmentHarness();
    const transport = transportHarness(async () => {
      attempts += 1;
      return attempts === 1
        ? {
            status: "error" as const,
            error: {
              code: "attachment-unavailable" as const,
              reason: "The terminal attachment issue failed.",
              retryable: true,
            },
          }
        : { status: "connected" as const, attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe(
      "disconnected",
    );
    expect(root.textContent).not.toContain("Terminal could not attach");

    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("connected");
    expect(attempts).toBe(2);
    dispose();
    vi.useRealTimers();
  });

  it("keeps session continuity without retaining a failed replacement's old pane grant", async () => {
    vi.useFakeTimers();
    const oldAttachment = attachmentHarness();
    const replacement = attachmentHarness();
    let attempts = 0;
    const transport = transportHarness(async () => {
      attempts += 1;
      if (attempts === 1) return { status: "connected", attachment: oldAttachment };
      if (attempts === 2) {
        return {
          status: "error" as const,
          error: {
            code: "attachment-unavailable" as const,
            reason: "replacement issue raced discovery",
            retryable: true,
          },
        };
      }
      return { status: "connected" as const, attachment: replacement };
    });
    const [target, setTarget] = createSignal(TARGET_A);
    const renderer = rendererFleetHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={target()}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    setTarget(TARGET_B);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    expect(oldAttachment.dispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(3));
    expect(oldAttachment.dispose).toHaveBeenCalledOnce();
    expect(replacement.dispose).not.toHaveBeenCalled();
    dispose();
    vi.useRealTimers();
  });

  it("falls back to a passive read-only viewer when another client keeps control", async () => {
    const requests: TerminalAttachRequest[] = [];
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (request, nextListener) => {
      requests.push(request);
      listener = nextListener;
      if (request.viewerMode === "interactive") {
        return {
          status: "error" as const,
          error: {
            code: "interactive-viewer-conflict" as const,
            reason: "Another client controls this window.",
            retryable: true,
          },
        };
      }
      return { status: "connected" as const, attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          geometryOwnership="owner"
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );

    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
        "read-only",
      ),
    );
    expect(requests.at(-1)).toMatchObject({
      viewerMode: "read-only",
      geometryOwnership: "passive",
    });
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-geometry-ownership")).toBe(
      "passive",
    );
    await Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new TextEncoder().encode("shared output"),
      }),
    );
    await vi.waitFor(() => expect(root.textContent).toContain("Viewing read-only"));
    expect(root.textContent).toContain("Take control");
    renderer.emitInput(new Uint8Array([3]));
    expect(attachment.write).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps a second surface passive and recovers control after a release race", async () => {
    type ClientId = "owner" | "viewer";
    const listeners = new Map<ClientId, (event: NativeTerminalEvent) => void | Promise<void>>();
    const requests = new Map<ClientId, TerminalAttachRequest[]>([
      ["owner", []],
      ["viewer", []],
    ]);
    const ownerWrite = vi.fn(async (_bytes: Uint8Array) => ({ status: "ok" as const }));
    const viewerWrite = vi.fn(async (_bytes: Uint8Array) => ({ status: "ok" as const }));
    const writes = new Map<ClientId, typeof ownerWrite>([
      ["owner", ownerWrite],
      ["viewer", viewerWrite],
    ]);
    let interactiveOwner: ClientId | null = null;
    let deferOwnerRelease = false;
    let ownerReleaseScheduled = false;
    let viewerConflicts = 0;

    const clientTransport = (clientId: ClientId): NativeTerminalTransport =>
      transportHarness(async (request, listener) => {
        requests.get(clientId)!.push(request);
        listeners.set(clientId, listener);
        if (request.viewerMode === "interactive") {
          if (interactiveOwner !== null && interactiveOwner !== clientId) {
            if (clientId === "viewer") viewerConflicts += 1;
            return {
              status: "error" as const,
              error: {
                code: "interactive-viewer-conflict" as const,
                reason: "Another client controls this window.",
                retryable: true,
              },
            };
          }
          interactiveOwner = clientId;
        }
        let disposed = false;
        return {
          status: "connected" as const,
          attachment: attachmentHarness({
            write: writes.get(clientId)!,
            dispose: vi.fn(() => {
              if (disposed) return;
              disposed = true;
              if (request.viewerMode !== "interactive" || interactiveOwner !== clientId) return;
              if (clientId === "owner" && deferOwnerRelease) {
                ownerReleaseScheduled = true;
                setTimeout(() => {
                  if (interactiveOwner === clientId) interactiveOwner = null;
                }, 120);
              } else {
                interactiveOwner = null;
              }
            }),
          }),
        };
      });

    const ownerRenderer = rendererHarness();
    const viewerRenderer = rendererHarness();
    const ownerTransport = clientTransport("owner");
    const viewerTransport = clientTransport("viewer");
    const ownerRoot = document.body.appendChild(document.createElement("div"));
    const viewerRoot = document.body.appendChild(document.createElement("div"));
    const [showOwner, setShowOwner] = createSignal(true);
    const disposeOwnerRoot = render(
      () => (
        <Show when={showOwner()}>
          <TerminalSurface
            target={TARGET_A}
            title="Owner"
            transport={ownerTransport}
            geometryOwnership="owner"
            rendererFactory={ownerRenderer.factory}
          />
        </Show>
      ),
      ownerRoot,
    );
    await vi.waitFor(() => expect(interactiveOwner).toBe("owner"));

    const disposeViewerRoot = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Viewer"
          transport={viewerTransport}
          geometryOwnership="owner"
          rendererFactory={viewerRenderer.factory}
        />
      ),
      viewerRoot,
    );
    await vi.waitFor(() =>
      expect(viewerRoot.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode")).toBe(
        "read-only",
      ),
    );

    await Promise.all([
      Promise.resolve(
        listeners.get("owner")?.({
          type: "output",
          bytes: new TextEncoder().encode("owner frame"),
        }),
      ),
      Promise.resolve(
        listeners.get("viewer")?.({
          type: "output",
          bytes: new TextEncoder().encode("viewer frame"),
        }),
      ),
    ]);
    await vi.waitFor(() => {
      expect(ownerRenderer.writes).toHaveLength(1);
      expect(viewerRenderer.writes).toHaveLength(1);
      expect(viewerRoot.textContent).toContain("Take control");
    });
    expect(requests.get("viewer")!.at(-1)).toMatchObject({
      viewerMode: "read-only",
      geometryOwnership: "passive",
    });
    expect(
      viewerRoot.querySelector(".terminal-surface")?.getAttribute("data-geometry-ownership"),
    ).toBe("passive");

    ownerRenderer.emitInput(new Uint8Array([1]));
    viewerRenderer.emitInput(new Uint8Array([2]));
    await vi.waitFor(() => expect(writes.get("owner")).toHaveBeenCalledOnce());
    expect(writes.get("viewer")).not.toHaveBeenCalled();

    // The original client's disconnect is not visible to the authority
    // immediately. Take control must survive two honest conflicts, then win
    // once the short release race settles instead of falling back again.
    deferOwnerRelease = true;
    setShowOwner(false);
    await vi.waitFor(() => expect(ownerReleaseScheduled).toBe(true));
    viewerRoot.querySelector<HTMLButtonElement>(".terminal-surface__viewer-status button")!.click();
    await vi.waitFor(
      () => {
        expect(interactiveOwner).toBe("viewer");
        expect(
          viewerRoot.querySelector(".terminal-surface")?.getAttribute("data-viewer-mode"),
        ).toBe("interactive");
        expect(viewerRoot.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe(
          "connected",
        );
      },
      { timeout: 1_500 },
    );
    expect(viewerConflicts).toBeGreaterThanOrEqual(5);
    expect(requests.get("viewer")!.at(-1)).toMatchObject({
      viewerMode: "interactive",
      geometryOwnership: "owner",
    });
    viewerRenderer.emitInput(new Uint8Array([3]));
    await vi.waitFor(() => expect(writes.get("viewer")).toHaveBeenCalledOnce());

    disposeViewerRoot();
    disposeOwnerRoot();
  });

  it("retires a rejected connect while retrying and rejects late output", async () => {
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness((_request, nextListener) => {
      listener = nextListener;
      return Promise.reject(new Error("transport rejected"));
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe(
        "disconnected",
      ),
    );

    await expect(
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes: new Uint8Array([1]),
        }),
      ),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    expect(renderer.renderer.write).not.toHaveBeenCalled();
    dispose();
  });

  it("reconnects a closed attachment without remounting the terminal renderer", async () => {
    const attachments = [attachmentHarness(), attachmentHarness()];
    const listeners: Array<(event: NativeTerminalEvent) => void | Promise<void>> = [];
    let connectionIndex = 0;
    const transport = transportHarness(async (_request, listener) => {
      listeners.push(listener);
      return { status: "connected", attachment: attachments[connectionIndex++]! };
    });
    const rendererFleet = rendererFleetHarness();
    const blockedWrite = deferred<void>();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={rendererFleet.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const oldRenderer = rendererFleet.instances[0]!;
    vi.mocked(oldRenderer.renderer.write).mockImplementation(async () => blockedWrite.promise);
    const oldAcknowledgment = expect(
      Promise.resolve(listeners[0]!({ type: "output", bytes: new Uint8Array([1]) })),
    ).rejects.toThrow("Terminal output was not consumed by the renderer.");
    await vi.waitFor(() => expect(oldRenderer.renderer.write).toHaveBeenCalledOnce());
    listeners[0]!({ type: "state", state: "disconnected", error: null });
    await oldAcknowledgment;
    oldRenderer.setViewport({ cols: 120, rows: 40 });
    ResizeObserverHarness.active[0]!.trigger();
    await Promise.resolve();
    expect(transport.connect).toHaveBeenCalledOnce();

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    expect(rendererFleet.instances).toHaveLength(1);
    expect(oldRenderer.renderer.dispose).not.toHaveBeenCalled();
    vi.mocked(oldRenderer.renderer.write).mockImplementation(async (bytes) => {
      oldRenderer.writes.push(bytes);
    });
    await Promise.resolve(listeners[1]!({ type: "output", bytes: new Uint8Array([2]) }));
    expect(oldRenderer.writes).toEqual([new Uint8Array([2])]);
    blockedWrite.resolve();
    await Promise.resolve();
    expect(oldRenderer.writes).toEqual([new Uint8Array([2])]);
    dispose();
  });

  /*
   * The whole widget contract, in one chain (m49.7).
   *
   * A pane that prints a marker renders a document; it does NOT stop being a
   * pane. The emulator stays mounted, keys still reach the process, and the
   * Ctrl-C the user presses is what takes the widget away — because the trap on
   * the other end clears the screen, and the marker stops existing.
   */
  it("swaps a marked pane to a widget, keeps its keyboard path, and restores on Ctrl-C", async () => {
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const emit = (bytes: Uint8Array): Promise<unknown> =>
      Promise.resolve(
        (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
          type: "output",
          bytes,
        }),
      ).catch(() => undefined);

    const surface = (): Element => root.querySelector(".terminal-surface")!;
    await vi.waitFor(() => expect(surface().getAttribute("data-phase")).toBe("connected"));

    // The pane prints the marker. The emulator parses it; the grid is what
    // detection reads, so the harness reports the row the emulator would hold.
    const announcement = widgetMarkerAnnouncement("markdown", {
      text: "# Plan\n\nRun `pnpm test`, then ship.",
    });
    renderer.setCellRows(markerCellRows(announcement));
    await emit(new TextEncoder().encode(announcement));

    await vi.waitFor(() => expect(surface().getAttribute("data-widget")).toBe("markdown"));
    const widget = root.querySelector(".widget-surface")!;
    expect(widget).not.toBeNull();

    // Bug this catches: the widget renders the document as escaped text, or
    // renders nothing, and the pane shows a blank panel where a plan should be.
    expect(widget.querySelector("h1")?.textContent).toBe("Plan");
    expect(widget.querySelector("code")?.textContent).toBe("pnpm test");

    /*
     * Bug this catches: the swap REPLACES the grid instead of covering it. The
     * emulator unmounts, its textarea leaves the focus order, and the user is
     * trapped inside a widget with no way to signal the process behind it.
     */
    expect(root.querySelector(".terminal-surface__viewport")).not.toBeNull();
    expect(renderer.renderer.dispose).not.toHaveBeenCalled();

    /*
     * Clicking the document focuses the PANE, not the overlay — and the focus
     * is handed back on mouse-UP, because a mousedown on ordinary content is
     * what blurs the emulator in the first place. A live run proved that a
     * pointerdown-only handler leaves the pane unable to be interrupted.
     */
    widget.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    widget.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    await vi.waitFor(() => expect(renderer.renderer.focus).toHaveBeenCalledTimes(2));

    // Ctrl-C, from the keyboard, while the widget is on screen.
    renderer.emitInput(new Uint8Array([3]));
    await vi.waitFor(() => expect(attachment.write).toHaveBeenCalledWith(new Uint8Array([3])));

    // What the helper's trap does on SIGINT: clear the screen and exec a shell.
    renderer.setCellRows([{ cells: [..."$ "], wrapped: false }]);
    await emit(new TextEncoder().encode("\u001b[2J\u001b[H$ "));

    await vi.waitFor(() => expect(surface().getAttribute("data-widget")).toBe(null));
    expect(root.querySelector(".widget-surface")).toBeNull();
    expect(root.querySelector(".terminal-surface__viewport")).not.toBeNull();
    dispose();
  });

  it("names a widget it cannot render instead of silently staying a terminal", async () => {
    const attachment = attachmentHarness();
    let listener: ((event: NativeTerminalEvent) => void | Promise<void>) | null = null;
    const transport = transportHarness(async (_request, nextListener) => {
      listener = nextListener;
      return { status: "connected", attachment };
    });
    const renderer = rendererHarness();
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(
      () => (
        <TerminalSurface
          target={TARGET_A}
          title="Codex"
          transport={transport}
          rendererFactory={renderer.factory}
        />
      ),
      root,
    );
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce());
    const announcement = widgetMarkerAnnouncement("flowchart", { nodes: 3 });
    renderer.setCellRows(markerCellRows(announcement));
    await Promise.resolve(
      (listener as ((event: NativeTerminalEvent) => void | Promise<void>) | null)?.({
        type: "output",
        bytes: new TextEncoder().encode(announcement),
      }),
    ).catch(() => undefined);

    await vi.waitFor(() =>
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-widget")).toBe("invalid"),
    );
    expect(root.querySelector(".widget-surface__refusal")?.textContent).toContain("flowchart");
    dispose();
  });

  it("keeps process, tmux, daemon, and network authority out of the Solid renderer", () => {
    const rendererSources = `${surfaceSource}\n${transportSource}\n${xtermSource}`;
    expect(rendererSources).not.toMatch(
      /(?:from\s+["']node:|node-pty|ipcRenderer|child_process|\bfetch\s*\(|new\s+WebSocket|\.spawn\s*\()/u,
    );
    expect(transportSource).not.toMatch(
      /(?:apiBaseUrl|redemptionTicket|connectionId|tmuxPaneId|runtimePaneId)/u,
    );
    expect(xtermSource).toContain("terminal.write(bytes, resolve)");
  });
});
