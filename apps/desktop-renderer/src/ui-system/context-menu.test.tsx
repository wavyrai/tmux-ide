/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";

import { ContextMenu, type ContextMenuSection } from "./context-menu.tsx";
import {
  initialContextMenuIndex,
  nextContextMenuIndex,
  resolveContextMenuPlacement,
} from "./context-menu-geometry.ts";

const disposers: Array<() => void> = [];

function mount(view: () => JSX.Element): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(view, root));
  return root;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const SECTIONS: readonly ContextMenuSection[] = [
  {
    id: "pane",
    label: "This pane",
    items: [
      { id: "split", label: "Split right", disabledReason: null, keyHint: "prefix %" },
      { id: "focus", label: "Focus pane", disabledReason: "this pane is already active" },
      { id: "kill", label: "Close pane", disabledReason: null, destructive: true },
    ],
  },
  {
    id: "arrange",
    label: "Arrange",
    note: "Arranges cards on this canvas only.",
    items: [{ id: "float", label: "Float", disabledReason: null, qualifier: "app layout" }],
  },
];

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-context-menu-item]"));
}

function itemNamed(id: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-context-menu-item="${id}"]`);
  if (!element) throw new Error(`no menu item ${id}`);
  return element;
}

function openMenu(
  overrides: {
    readonly onActivate?: (id: string, source: "mouse" | "keyboard") => void;
    readonly onClose?: () => void;
    readonly openSource?: "contextmenu" | "click" | "keyboard";
  } = {},
) {
  const [open, setOpen] = createSignal(true);
  const onClose = overrides.onClose ?? (() => setOpen(false));
  const root = mount(() => (
    <ContextMenu
      open={open()}
      pointer={{ x: 40, y: 40 }}
      label="Window actions"
      sections={SECTIONS}
      openSource={overrides.openSource ?? "contextmenu"}
      onClose={onClose}
      onActivate={overrides.onActivate ?? (() => {})}
    />
  ));
  return { root, open, setOpen };
}

/** A real mouse click: `.click()` reports `detail: 0`, which the app reads as keyboard. */
function clickWithMouse(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

/** The release that ends the opening right-click gesture. */
function armOpeningGesture(): void {
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

describe("resolveContextMenuPlacement", () => {
  const menu = { width: 220, height: 300 };
  const viewport = { width: 1_000, height: 700 };

  it("opens down and right of the pointer when it fits", () => {
    expect(resolveContextMenuPlacement({ x: 100, y: 120 }, menu, viewport)).toEqual({
      left: 100,
      top: 120,
      originX: "left",
      originY: "top",
    });
  });

  it("flips to the other side of the pointer at the far edge", () => {
    const placement = resolveContextMenuPlacement({ x: 960, y: 660 }, menu, viewport);
    expect(placement).toMatchObject({ originX: "right", originY: "bottom" });
    expect(placement.left).toBe(960 - menu.width);
    expect(placement.top).toBe(660 - menu.height);
  });

  it("clamps into the viewport when neither side fits", () => {
    const placement = resolveContextMenuPlacement({ x: 4, y: 4 }, menu, {
      width: 240,
      height: 260,
    });
    expect(placement.left).toBe(8);
    expect(placement.top).toBe(8);
  });
});

describe("nextContextMenuIndex", () => {
  it("wraps in both directions and includes disabled stops", () => {
    expect(nextContextMenuIndex(3, null, "ArrowDown")).toBe(0);
    expect(nextContextMenuIndex(3, 2, "ArrowDown")).toBe(0);
    expect(nextContextMenuIndex(3, 0, "ArrowUp")).toBe(2);
    expect(nextContextMenuIndex(3, null, "ArrowUp")).toBe(2);
    expect(nextContextMenuIndex(3, 1, "Home")).toBe(0);
    expect(nextContextMenuIndex(3, 1, "End")).toBe(2);
    expect(nextContextMenuIndex(0, null, "ArrowDown")).toBeNull();
  });

  it("opens the keyboard menu on the first activatable item", () => {
    expect(initialContextMenuIndex([false, true, true])).toBe(1);
    expect(initialContextMenuIndex([false, false])).toBe(0);
    expect(initialContextMenuIndex([])).toBeNull();
  });
});

describe("ContextMenu", () => {
  it("renders every item, disabled ones with their reason", () => {
    openMenu();
    expect(items().map((item) => item.dataset.contextMenuItem)).toEqual([
      "split",
      "focus",
      "kill",
      "float",
    ]);
    const focus = itemNamed("focus");
    expect(focus.getAttribute("aria-disabled")).toBe("true");
    expect(focus.textContent).toContain("this pane is already active");
    expect(itemNamed("split").querySelector("kbd")?.textContent).toBe("prefix %");
    expect(itemNamed("float").textContent).toContain("app layout");
    expect(
      document.querySelector('[data-section-id="arrange"] .tmi-context-menu__section-note')
        ?.textContent,
    ).toContain("this canvas only");
  });

  it("ignores the release that opened it, then accepts the next click", () => {
    const onActivate = vi.fn();
    openMenu({ onActivate });
    clickWithMouse(itemNamed("split"));
    expect(onActivate).not.toHaveBeenCalled();
    armOpeningGesture();
    clickWithMouse(itemNamed("split"));
    expect(onActivate).toHaveBeenCalledWith("split", "mouse");
  });

  it("refuses a disabled item even once armed", () => {
    const onActivate = vi.fn();
    openMenu({ onActivate });
    armOpeningGesture();
    clickWithMouse(itemNamed("focus"));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("confirms a destructive item in place, on a second click", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    openMenu({ onActivate, onClose });
    armOpeningGesture();
    const kill = itemNamed("kill");
    clickWithMouse(kill);
    expect(onActivate).not.toHaveBeenCalled();
    expect(kill.dataset.confirmPending).toBe("true");
    expect(kill.textContent).toContain("Confirm close pane");
    clickWithMouse(kill);
    expect(onActivate).toHaveBeenCalledWith("kill", "mouse");
    expect(onClose).toHaveBeenCalled();
  });

  it("cancels a pending confirm when the menu closes", () => {
    const { setOpen } = openMenu();
    armOpeningGesture();
    clickWithMouse(itemNamed("kill"));
    expect(itemNamed("kill").dataset.confirmPending).toBe("true");
    setOpen(false);
    setOpen(true);
    expect(itemNamed("kill").dataset.confirmPending).toBe("false");
  });

  it("closes on Escape and on an outside press", () => {
    const onClose = vi.fn();
    openMenu({ onClose });
    armOpeningGesture();
    const menu = document.querySelector<HTMLElement>(".tmi-context-menu")!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus with the arrow keys, landing on disabled items too", () => {
    openMenu({ openSource: "keyboard" });
    const menu = document.querySelector<HTMLElement>(".tmi-context-menu")!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-context-menu-item")).toBe("focus");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement?.getAttribute("data-context-menu-item")).toBe("float");
  });
});
