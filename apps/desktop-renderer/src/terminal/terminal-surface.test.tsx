/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type {
  TerminalAttachmentSemanticTarget,
  TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

import { TerminalSurface } from "./terminal-surface.tsx";
import type {
  NativeTerminalAttachment,
  NativeTerminalConnectResult,
  NativeTerminalEvent,
  NativeTerminalTransport,
} from "./native-terminal-transport.ts";
import type { TerminalRenderer, TerminalRendererFactory } from "./xterm-renderer.ts";
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

const TARGET_A: TerminalAttachmentSemanticTarget = {
  workspaceName: "workspace-a",
  semanticPaneId: "agent-a",
};
const TARGET_B: TerminalAttachmentSemanticTarget = {
  workspaceName: "workspace-b",
  semanticPaneId: "agent-b",
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

function rendererHarness(initialViewport: TerminalAttachmentViewport = { cols: 80, rows: 24 }) {
  let viewport = initialViewport;
  let input: ((bytes: Uint8Array) => void) | null = null;
  const writes: Uint8Array[] = [];
  const disposeInput = vi.fn(() => (input = null));
  const renderer: TerminalRenderer = {
    open: vi.fn(),
    write: vi.fn(async (bytes) => {
      writes.push(bytes);
    }),
    focus: vi.fn(),
    fit: vi.fn(() => viewport),
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
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("TerminalSurface", () => {
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

  it("retires the old attachment and reconnects when the semantic target changes", async () => {
    const attachments = [attachmentHarness(), attachmentHarness()];
    const listeners: Array<(event: NativeTerminalEvent) => void | Promise<void>> = [];
    let connectionIndex = 0;
    const transport = transportHarness(async (_request, listener) => {
      listeners.push(listener);
      return { status: "connected", attachment: attachments[connectionIndex++]! };
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

  it("retires a typed connect failure before rejecting late output", async () => {
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
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
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

  it("retires a rejected connect before rejecting late output", async () => {
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
      expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("error"),
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

  it("requires an explicit retry after disconnect instead of reconnecting on resize", async () => {
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

    root.querySelector<HTMLButtonElement>(".terminal-surface__state button")!.click();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-phase")).toBe("measuring");
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rendererFleet.instances).toHaveLength(2));
    const newRenderer = rendererFleet.instances[1]!;
    expect(oldRenderer.renderer.dispose).toHaveBeenCalledOnce();
    expect(root.querySelector(".terminal-surface")?.getAttribute("data-preserves-frame")).toBe(
      "false",
    );
    await Promise.resolve(listeners[1]!({ type: "output", bytes: new Uint8Array([2]) }));
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
    blockedWrite.resolve();
    await Promise.resolve();
    expect(newRenderer.writes).toEqual([new Uint8Array([2])]);
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
