/* @vitest-environment happy-dom */
import {
  AppWindowDocumentV1SchemaZ,
  resolvePaneAppearance,
  type ApplicationShellTerminalInventory,
  type AppWindowDocumentV1,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import type {
  NativeTerminalAttachment,
  NativeTerminalTransport,
} from "../terminal/native-terminal-transport.ts";
import type { TerminalRenderer, TerminalRendererFactory } from "../terminal/xterm-renderer.ts";
import runtimeStyles from "../runtime-styles.css?raw";
import { AppWindowCanvas } from "./app-window-canvas.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

function installTerminalLifecycleHarness() {
  class Observer {
    readonly disconnect = vi.fn();
    constructor(readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback([], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(1));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const renderer: TerminalRenderer = {
    open: vi.fn(),
    write: vi.fn(async () => undefined),
    focus: vi.fn(),
    fit: vi.fn(() => ({ cols: 80, rows: 24 })),
    refreshTheme: vi.fn(),
    setReducedMotion: vi.fn(),
    onInput: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  };
  const rendererFactory: TerminalRendererFactory = vi.fn(() => renderer);
  const attachment: NativeTerminalAttachment = {
    write: vi.fn(async () => ({ status: "ok" as const })),
    resize: vi.fn(async () => ({ status: "ok" as const })),
    dispose: vi.fn(),
  };
  const transport: NativeTerminalTransport = {
    connect: vi.fn(async () => ({ status: "connected" as const, attachment })),
  };
  return { renderer, rendererFactory, attachment, transport };
}

function documentFixture(): AppWindowDocumentV1 {
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 3,
    updatedAt: "2026-07-22T10:00:00.000Z",
    windows: {
      "window.lead": {
        id: "window.lead",
        source: { kind: "terminal", terminalSourceId: "terminal.lead" },
        title: "Lead terminal",
        placement: {
          mode: "docked",
          docked: { stackId: "stack.canvas", index: 0 },
          floating: null,
        },
      },
    },
    dockRoot: {
      type: "stack",
      id: "stack.canvas",
      windowIds: ["window.lead"],
      activeWindowId: "window.lead",
    },
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: [],
    focusedWindowId: "window.lead",
    activeLayoutId: null,
    layouts: {},
  });
}

function floatingDocumentFixture(): AppWindowDocumentV1 {
  const value = documentFixture();
  return AppWindowDocumentV1SchemaZ.parse({
    ...value,
    windows: {
      "window.lead": {
        ...value.windows["window.lead"],
        placement: {
          mode: "floating",
          docked: null,
          floating: { x: 42, y: 36, width: 360, height: 220 },
        },
      },
    },
    dockRoot: null,
    floatingOrder: ["window.lead"],
  });
}

function frame(): PaneFrameModel {
  const appearance = resolvePaneAppearance({
    structure: "docked",
    applicationFocus: { pane: false, terminalInput: false, windowActive: true },
    agentActivity: "running",
    domainStatus: "running",
    attention: "none",
    layoutInteraction: {
      editable: true,
      selected: false,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: false,
      focusVisible: false,
      pressed: false,
      disabled: false,
      loading: false,
    },
  });
  return {
    pane: { id: "terminal.lead", kind: "terminal" },
    appearance,
    title: "Live terminal title",
    subtitle: "Codex",
    status: {
      id: "terminal.lead.status",
      label: "Running",
      description: "Terminal is running",
      tone: appearance.status.tone,
      busy: true,
    },
    chips: [],
    actions: [],
  };
}

const inventory: ApplicationShellTerminalInventory = {
  activeResourceId: "terminal.lead",
  resources: [
    {
      id: "terminal.lead",
      title: "Lead terminal",
      kind: "agent",
      active: true,
      attachability: { status: "available", semanticPaneId: "terminal.lead" },
    },
  ],
};

describe("AppWindowCanvas", () => {
  it("renders terminal content under canonical window identity and durable geometry", () => {
    const runtimeSheet = document.createElement("style");
    runtimeSheet.textContent = runtimeStyles;
    document.head.append(runtimeSheet);
    disposers.push(() => runtimeSheet.remove());
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={documentFixture()}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );

    const card = root.querySelector<HTMLElement>('.app-window-card[data-window-id="window.lead"]');
    expect(card?.dataset.terminalSourceId).toBe("terminal.lead");
    expect(card?.getAttribute("style")).toBeNull();
    const key = card?.dataset.tmiRuntimeStyle;
    const rule = [...runtimeSheet.sheet!.cssRules].find(
      (candidate) =>
        candidate instanceof CSSStyleRule && candidate.selectorText.includes(key ?? "__missing__"),
    );
    expect(rule).toBeInstanceOf(CSSStyleRule);
    expect((rule as CSSStyleRule).style.width).toBe("900px");
    expect((rule as CSSStyleRule).style.height).toBe("540px");
    expect(card?.querySelector(".web-pane-frame")?.getAttribute("data-pane-id")).toBe(
      "window.lead",
    );
    expect(card?.querySelector(".terminal-surface")).not.toBeNull();
    expect(root.querySelector(".agent-grid")).toBeNull();
    expect(root.innerHTML).toMatchSnapshot();
  });

  it("emits canonical focus commands from window chrome interaction", () => {
    const value = documentFixture();
    const unfocused = AppWindowDocumentV1SchemaZ.parse({ ...value, focusedWindowId: null });
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={unfocused}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );
    root
      .querySelector<HTMLElement>(".app-window-card")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onCommand).toHaveBeenCalledWith({
      command: { type: "window.focus", windowId: "window.lead" },
      source: "mouse",
    });
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  it("lets the terminal emit the only focus command for an unfocused terminal click", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    const unfocused = AppWindowDocumentV1SchemaZ.parse({
      ...floatingDocumentFixture(),
      focusedWindowId: null,
    });
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={unfocused}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );
    root
      .querySelector<HTMLElement>(".terminal-surface")!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, button: 0 }));
    expect(onCommand.mock.calls).toEqual([
      [
        {
          command: { type: "window.focus", windowId: "window.lead" },
          source: "mouse",
        },
      ],
    ]);
  });

  it("routes canvas pinch and floating drag without stealing terminal wheel or pointer input", async () => {
    const lifecycle = installTerminalLifecycleHarness();
    const root = document.createElement("div");
    document.body.append(root);
    const onCommand = vi.fn();
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={floatingDocumentFixture()}
            paneFrames={[frame()]}
            terminalInventory={inventory}
            workspaceName="workspace.product"
            viewport={{ width: 900, height: 540 }}
            transport={lifecycle.transport}
            rendererFactory={lifecycle.rendererFactory}
            onCommand={onCommand}
          />
        ),
        root,
      ),
    );
    await vi.waitFor(() => expect(lifecycle.transport.connect).toHaveBeenCalledOnce());
    const canvas = root.querySelector<HTMLElement>(".app-window-canvas")!;
    const terminalMount = root.querySelector(".terminal-surface__viewport");
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(canvas, {
      setPointerCapture: capture,
      hasPointerCapture: () => true,
      releasePointerCapture: release,
    });

    const zoomIn = root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
    zoomIn.click();
    zoomIn.click();
    expect(Number(canvas.dataset.viewportScale)).toBeCloseTo(1.44);

    const terminal = root.querySelector<HTMLElement>(".terminal-surface")!;
    terminal.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80, ctrlKey: true }),
    );
    terminal.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, button: 0 }),
    );
    expect(Number(canvas.dataset.viewportScale)).toBeCloseTo(1.44);
    expect(capture).not.toHaveBeenCalled();
    expect(onCommand.mock.calls).toEqual([
      [
        {
          command: { type: "window.focus", windowId: "window.lead" },
          source: "mouse",
        },
      ],
    ]);
    onCommand.mockClear();

    const header = root.querySelector<HTMLElement>(".web-pane-frame__title")!;
    header.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        button: 0,
        clientX: 120,
        clientY: 100,
      }),
    );
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        clientX: 264,
        clientY: 172,
      }),
    );
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 7,
        button: 0,
        clientX: 264,
        clientY: 172,
      }),
    );

    expect(capture).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(7);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      command: {
        type: "window.float",
        windowId: "window.lead",
        rect: { x: 142, y: 86, width: 360, height: 220 },
      },
      source: "mouse",
    });

    onCommand.mockClear();
    root.querySelector<HTMLElement>('[data-canvas-resize-edge="south-east"]')!.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 8,
        button: 0,
        clientX: 500,
        clientY: 300,
      }),
    );
    canvas.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 8,
        clientX: 644,
        clientY: 372,
      }),
    );
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 8,
        button: 0,
        clientX: 644,
        clientY: 372,
      }),
    );
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith({
      command: {
        type: "window.float",
        windowId: "window.lead",
        rect: { x: 142, y: 86, width: 460, height: 270 },
      },
      source: "mouse",
    });
    expect(root.querySelector(".terminal-surface__viewport")).toBe(terminalMount);
    expect(lifecycle.rendererFactory).toHaveBeenCalledOnce();
    expect(lifecycle.transport.connect).toHaveBeenCalledOnce();
    expect(lifecycle.renderer.dispose).not.toHaveBeenCalled();
    expect(lifecycle.attachment.dispose).not.toHaveBeenCalled();
  });

  it.each(["lost capture", "window blur", "Escape"] as const)(
    "cancels captured window movement on %s without a durable command",
    (cancellation) => {
      const root = document.createElement("div");
      document.body.append(root);
      const onCommand = vi.fn();
      disposers.push(
        render(
          () => (
            <AppWindowCanvas
              document={floatingDocumentFixture()}
              paneFrames={[frame()]}
              terminalInventory={inventory}
              workspaceName="workspace.product"
              viewport={{ width: 900, height: 540 }}
              onCommand={onCommand}
            />
          ),
          root,
        ),
      );
      const canvas = root.querySelector<HTMLElement>(".app-window-canvas")!;
      Object.assign(canvas, {
        setPointerCapture: vi.fn(),
        hasPointerCapture: () => false,
        releasePointerCapture: vi.fn(),
      });
      root.querySelector<HTMLElement>(".web-pane-frame__title")!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 11,
          button: 0,
          clientX: 100,
          clientY: 100,
        }),
      );
      canvas.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 11,
          clientX: 180,
          clientY: 140,
        }),
      );
      if (cancellation === "lost capture") {
        canvas.dispatchEvent(
          new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 11 }),
        );
      } else if (cancellation === "window blur") {
        window.dispatchEvent(new Event("blur"));
      } else {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }),
        );
      }

      expect(onCommand).not.toHaveBeenCalled();
      expect(canvas.dataset.gesture).toBeUndefined();
      expect(root.querySelector(".app-window-card")?.getAttribute("data-transient-geometry")).toBe(
        "false",
      );
    },
  );

  it("keeps one terminal renderer and attachment across scene and viewport refreshes", async () => {
    const lifecycle = installTerminalLifecycleHarness();
    const [documentValue, setDocumentValue] = createSignal(documentFixture());
    const [viewport, setViewport] = createSignal({ width: 900, height: 540 });
    const [inventoryValue, setInventoryValue] = createSignal(inventory);
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <AppWindowCanvas
            document={documentValue()}
            paneFrames={[frame()]}
            terminalInventory={inventoryValue()}
            workspaceName="workspace.product"
            viewport={viewport()}
            transport={lifecycle.transport}
            rendererFactory={lifecycle.rendererFactory}
          />
        ),
        root,
      ),
    );

    await vi.waitFor(() => expect(lifecycle.transport.connect).toHaveBeenCalledOnce());
    const terminalMount = root.querySelector(".terminal-surface__viewport");
    setViewport({ width: 1_200, height: 720 });
    setInventoryValue({
      ...inventory,
      resources: inventory.resources.map((item) => ({ ...item })),
    });
    setDocumentValue(
      AppWindowDocumentV1SchemaZ.parse({
        ...documentValue(),
        revision: 4,
        updatedAt: "2026-07-22T10:01:00.000Z",
        windows: {
          ...documentValue().windows,
          "window.lead": { ...documentValue().windows["window.lead"]!, title: "Updated title" },
        },
      }),
    );

    await vi.waitFor(() =>
      expect(root.querySelector(".app-window-canvas")?.getAttribute("data-window-revision")).toBe(
        "4",
      ),
    );
    expect(root.querySelector(".terminal-surface__viewport")).toBe(terminalMount);
    expect(lifecycle.rendererFactory).toHaveBeenCalledOnce();
    expect(lifecycle.transport.connect).toHaveBeenCalledOnce();
    expect(lifecycle.renderer.dispose).not.toHaveBeenCalled();
    expect(lifecycle.attachment.dispose).not.toHaveBeenCalled();
  });
});
