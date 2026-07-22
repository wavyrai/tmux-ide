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
    expect(card?.getAttribute("style")).toContain("width: 900px");
    expect(card?.getAttribute("style")).toContain("height: 540px");
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
  });

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
