import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createApplicationPaneMenuOwner } from "./application-pane-menu-owner.ts";

function fixture() {
  return createRoot((dispose) => {
    const [epoch, setEpoch] = createSignal(1);
    const [visible, setVisible] = createSignal(true);
    const onAction = vi.fn();
    const owner = createApplicationPaneMenuOwner({
      rendererEpoch: epoch,
      paneVisible: () => visible(),
      onAction,
    });
    const open = () => owner.open({ paneId: "pane.a", displayName: "Agent", left: 2, top: 3 });
    open();
    return { owner, open, onAction, setEpoch, setVisible, dispose };
  });
}

describe("pane menu interaction owner", () => {
  it("owns unknown keys without executing them and releases ownership on Escape", () => {
    const f = fixture();
    try {
      expect(f.owner.ownsInput()).toBe(true);
      expect(f.owner.handleKey("z")).toBe(true);
      expect(f.owner.handleKey("x", { ctrl: true })).toBe(true);
      expect(f.owner.handleKey("r", { meta: true })).toBe(true);
      expect(f.owner.handleKey("x", { eventType: "release" })).toBe(true);
      expect(f.owner.state()?.closeArmed).toBe(false);
      expect(f.onAction).not.toHaveBeenCalled();
      f.owner.handleKey("escape");
      expect(f.owner.ownsInput()).toBe(false);
      expect(f.owner.handleKey("r")).toBe(false);
    } finally {
      f.dispose();
    }
  });

  it("shares exact actions between pointer highlighting and keyboard navigation", () => {
    const f = fixture();
    try {
      f.owner.highlight("split-down");
      f.owner.handleKey("up");
      expect(f.owner.state()?.selectedId).toBe("split-right");
      f.owner.handleKey("enter");
      expect(f.onAction).toHaveBeenCalledWith("pane.a", "split-right", "Agent");
      f.open();
      f.owner.handleKey("up");
      expect(f.owner.state()?.selectedId).toBe("close-pane");
      f.owner.handleKey("down");
      expect(f.owner.state()?.selectedId).toBe("select-text");
    } finally {
      f.dispose();
    }
  });

  it("requires deliberate close confirmation and disarms when selection leaves the row", () => {
    const f = fixture();
    try {
      f.owner.handleKey("x");
      f.owner.handleKey("x", { repeated: true });
      expect(f.onAction).not.toHaveBeenCalled();
      f.owner.highlight("rename-pane");
      expect(f.owner.state()?.closeArmed).toBe(false);
      f.owner.highlight("close-pane");
      f.owner.activate("close-pane");
      expect(f.onAction).not.toHaveBeenCalled();
      f.owner.handleKey("enter");
      expect(f.onAction).toHaveBeenCalledExactlyOnceWith("pane.a", "close-pane", "Agent");
    } finally {
      f.dispose();
    }
  });

  it("retires stale menus when the pane disappears or the renderer generation changes", () => {
    const f = fixture();
    try {
      f.owner.handleKey("x");
      f.setVisible(false);
      expect(f.owner.ownsInput()).toBe(false);
      f.owner.activate("close-pane");
      f.setVisible(true);
      expect(f.owner.state()).toBeNull();
      f.open();
      f.setEpoch(2);
      expect(f.owner.state()).toBeNull();
      f.owner.activate("rename-pane");
      expect(f.onAction).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});
