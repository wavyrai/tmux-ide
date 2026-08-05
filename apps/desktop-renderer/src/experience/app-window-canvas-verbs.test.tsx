/* @vitest-environment happy-dom */
/**
 * The canvas as a mouse surface for multiplexer verbs.
 *
 * Everything here is about what a pointer can reach: right-click opens the verb
 * menu for whatever is under it, the Close button destroys a real tmux window
 * after asking twice, a header double-click zooms tmux rather than the card,
 * and a title double-click renames. The verb table's own rules are tested next
 * to it; these tests only prove the surface reaches them.
 */
import {
  AppWindowDocumentV1SchemaZ,
  resolvePaneAppearance,
  type ApplicationShellTerminalInventory,
  type AppWindowDocumentV1,
  type WorkspaceMultiplexerHostResult,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import {
  APP_WINDOW_CANVAS_ACTION_IDS,
  AppWindowCanvas,
  type AppWindowCanvasVerbSurface,
} from "./app-window-canvas.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

const OK: WorkspaceMultiplexerHostResult = {
  status: "ok",
  result: {
    verb: "workspace.pane.select",
    operationId: "00000000-0000-4000-8000-000000000001",
    daemonInstanceId: "00000000-0000-4000-8000-000000000002",
    outcome: "applied",
    workspaceName: "workspace.product",
    semanticPaneId: "terminal.lead",
  },
};

function documentFixture(): AppWindowDocumentV1 {
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 4,
    updatedAt: "2026-08-04T10:00:00.000Z",
    windows: {
      "window.lead": {
        id: "window.lead",
        source: { kind: "terminal", terminalSourceId: "terminal.lead" },
        title: "Lead terminal",
        placement: {
          mode: "floating",
          docked: null,
          floating: { x: 40, y: 30, width: 420, height: 260 },
        },
      },
      "window.second": {
        id: "window.second",
        source: { kind: "terminal", terminalSourceId: "terminal.second" },
        title: "Second terminal",
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
      windowIds: ["window.second"],
      activeWindowId: "window.second",
    },
    dockState: { mode: "open", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: ["window.lead"],
    focusedWindowId: "window.lead",
    activeLayoutId: null,
    layouts: {},
  });
}

function frame(sourceId: string, title: string): PaneFrameModel {
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
    pane: { id: sourceId, kind: "terminal" },
    appearance,
    title,
    subtitle: null,
    status: null,
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
    {
      id: "terminal.second",
      title: "Second terminal",
      kind: "terminal",
      active: false,
      attachability: { status: "available", semanticPaneId: "terminal.second" },
    },
  ],
};

function mountCanvas(
  overrides: Partial<AppWindowCanvasVerbSurface> = {},
  onCommand = vi.fn(),
): {
  readonly root: HTMLElement;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly onCommand: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => OK);
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(
    render(
      () => (
        <AppWindowCanvas
          document={documentFixture()}
          paneFrames={[frame("terminal.lead", "Lead terminal"), frame("terminal.second", "Second")]}
          terminalInventory={inventory}
          workspaceName="workspace.product"
          viewport={{ width: 900, height: 540 }}
          onCommand={onCommand}
          verbs={{
            workspaceConnected: true,
            sessionWindowCount: 2,
            invoke,
            onCreateWindow: vi.fn(),
            onCreateSession: vi.fn(),
            ...overrides,
          }}
        />
      ),
      root,
    ),
  );
  return { root, invoke, onCommand };
}

function rightClick(target: Element): void {
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 90 }));
  // The release that ends the opening gesture; the menu refuses activations
  // until it lands, exactly as the tmux menus do.
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

function menuItem(id: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-context-menu-item="${id}"]`);
  if (!element) throw new Error(`no menu item ${id}`);
  return element;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

function card(root: HTMLElement, windowId: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
  if (!element) throw new Error(`no card ${windowId}`);
  return element;
}

describe("canvas context menus", () => {
  it("opens the window menu on a card, with tmux and app-layout sections apart", () => {
    const { root } = mountCanvas();
    rightClick(card(root, "window.lead").querySelector(".web-pane-frame__header")!);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute("aria-label")).toBe("Window actions");
    expect(
      Array.from(document.querySelectorAll("[data-section-id]")).map((section) =>
        section.getAttribute("data-section-id"),
      ),
    ).toEqual(["pane", "window", "session", "arrange"]);
    expect(menuItem("pane.split.right").dataset.disabled).toBe("false");
    expect(menuItem("pane.kill").dataset.destructive).toBe("true");
    expect(document.querySelector(".tmi-context-menu__section-note")?.textContent).toContain(
      "tmux layout is unchanged",
    );
  });

  it("opens the canvas menu on bare ground, where creation starts", () => {
    const { root } = mountCanvas();
    rightClick(root.querySelector(".app-window-canvas")!);
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe(
      "Canvas actions",
    );
    expect(menuItem("window.new").dataset.disabled).toBe("false");
    expect(menuItem("session.new").dataset.disabled).toBe("false");
  });

  it("dispatches a pane verb against the card's semantic pane id", () => {
    const { root, invoke } = mountCanvas();
    rightClick(card(root, "window.lead").querySelector(".web-pane-frame__header")!);
    click(menuItem("pane.split.right"));
    expect(invoke).toHaveBeenCalledWith(
      "pane.split.right",
      { workspaceName: "workspace.product", semanticPaneId: "terminal.lead" },
      undefined,
    );
  });

  it("asks twice before killing a pane from the menu", () => {
    const { root, invoke } = mountCanvas();
    rightClick(card(root, "window.lead").querySelector(".web-pane-frame__header")!);
    click(menuItem("pane.kill"));
    expect(invoke).not.toHaveBeenCalled();
    expect(menuItem("pane.kill").dataset.confirmPending).toBe("true");
    click(menuItem("pane.kill"));
    expect(invoke).toHaveBeenCalledWith(
      "pane.kill",
      { workspaceName: "workspace.product", semanticPaneId: "terminal.lead" },
      undefined,
    );
  });

  it("docks a window into another window's stack", () => {
    const { root, onCommand } = mountCanvas();
    rightClick(card(root, "window.lead").querySelector(".web-pane-frame__header")!);
    const dockInto = document.querySelector<HTMLButtonElement>(
      '[data-context-menu-item^="app-layout:dock-into:"]',
    )!;
    expect(dockInto.textContent).toContain("Dock into Second terminal");
    click(dockInto);
    expect(onCommand).toHaveBeenCalledWith({
      command: { type: "window.dock", windowId: "window.lead", stackId: "stack.canvas" },
      source: "mouse",
    });
  });

  it("refuses a verb the host has no flow for, and says which", () => {
    const { root } = mountCanvas({ onCreateWindow: undefined, onCreateSession: undefined });
    rightClick(root.querySelector(".app-window-canvas")!);
    expect(menuItem("window.new").dataset.disabled).toBe("true");
    expect(menuItem("window.new").textContent).toContain("unavailable in this host");
    expect(menuItem("session.detach").dataset.disabled).toBe("true");
  });
});

describe("pane chrome as the handle", () => {
  it("closes a window from the header, after arming the button", () => {
    const { root, invoke } = mountCanvas();
    const close = card(root, "window.lead").querySelector<HTMLButtonElement>(
      `[data-action-id="${APP_WINDOW_CANVAS_ACTION_IDS.close}"]`,
    )!;
    expect(close.disabled).toBe(false);
    click(close);
    expect(invoke).not.toHaveBeenCalled();
    const armed = card(root, "window.lead").querySelector<HTMLButtonElement>(
      `[data-action-id="${APP_WINDOW_CANVAS_ACTION_IDS.close}"]`,
    )!;
    expect(armed.textContent).toContain("Confirm close");
    click(armed);
    expect(invoke).toHaveBeenCalledWith(
      "window.kill",
      { workspaceName: "workspace.product", semanticPaneId: "terminal.lead" },
      undefined,
    );
  });

  it("leaves a tombstone where a killed window was", async () => {
    const { root, invoke } = mountCanvas();
    const close = () =>
      card(root, "window.lead").querySelector<HTMLButtonElement>(
        `[data-action-id="${APP_WINDOW_CANVAS_ACTION_IDS.close}"]`,
      )!;
    click(close());
    click(close());
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(card(root, "window.lead").getAttribute("data-ending")).toBe("true"),
    );
  });

  it("runs tmux's own zoom on a header double-click, not the card's maximize", () => {
    const { root, invoke, onCommand } = mountCanvas();
    card(root, "window.lead")
      .querySelector(".web-pane-frame__header")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(invoke).toHaveBeenCalledWith(
      "window.zoom.toggle",
      { workspaceName: "workspace.product", semanticPaneId: "terminal.lead" },
      undefined,
    );
    expect(onCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.objectContaining({ type: "window.float" }) }),
    );
  });

  it("renames a window from a double-click on its title", () => {
    const { root, invoke } = mountCanvas();
    card(root, "window.lead")
      .querySelector(".web-pane-frame__title")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const field = card(root, "window.lead").querySelector<HTMLInputElement>(
      ".app-window-card__rename-field",
    )!;
    expect(field.value).toBe("Lead terminal");
    field.value = "build";
    field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(invoke).toHaveBeenCalledWith(
      "window.rename",
      { workspaceName: "workspace.product", semanticPaneId: "terminal.lead" },
      { name: "build" },
    );
  });

  it("abandons a rename that changes nothing", () => {
    const { root, invoke } = mountCanvas();
    card(root, "window.lead")
      .querySelector(".web-pane-frame__title")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const field = card(root, "window.lead").querySelector<HTMLInputElement>(
      ".app-window-card__rename-field",
    )!;
    field.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
