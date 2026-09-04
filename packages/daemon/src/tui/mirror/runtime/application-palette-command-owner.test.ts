import { describe, expect, it, vi } from "vitest";

import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";
import { createRoot } from "solid-js";

const testOwner = (
  overrides: Partial<Parameters<typeof createApplicationPaletteCommandOwner>[0]> = {},
) =>
  createApplicationPaletteCommandOwner({
    activeSurface: () => "terminals",
    isOpen: () => true,
    binding: {
      openSurface: vi.fn(async () => true),
      setPaletteOpen: vi.fn(async () => true),
      activatePaletteSurface: vi.fn(async () => true),
    },
    commandSource: (kind, surface) => ({ kind, surface }),
    setSurface: vi.fn(),
    setNote: vi.fn(),
    newWindow: vi.fn(async () => "created"),
    splitPane: vi.fn(async () => "split"),
    closePane: vi.fn(async () => "closed"),
    openAgent: vi.fn(async () => true),
    ...overrides,
  });

describe("application palette command owner", () => {
  it("requires fresh confirmation after a query, selection or target change and ignores repeated Enter", async () => {
    let target = "pane-a";
    const closePane = vi.fn(async () => "closed");
    const dispose = createRoot((dispose) => {
      const owner = testOwner({ closePane, targetKey: () => target });
      owner.select(5);
      owner.activate("close-pane", "keyboard");
      expect(owner.closeArmed()).toBe(true);
      owner.handleKey({ name: "enter", ctrl: false, meta: false, shift: false, repeated: true });
      expect(closePane).not.toHaveBeenCalled();
      owner.handlePaste(Buffer.from("close"));
      expect(owner.closeArmed()).toBe(false);
      owner.activate("close-pane", "mouse");
      target = "pane-b";
      expect(owner.closeArmed()).toBe(false);
      owner.activate("close-pane", "mouse");
      expect(closePane).not.toHaveBeenCalled();
      owner.select(0);
      owner.activate("close-pane", "mouse");
      owner.activate("close-pane", "mouse");
      expect(closePane).toHaveBeenCalledTimes(1);
      return dispose;
    });
    await Promise.resolve();
    dispose();
  });
  it("blocks unavailable actions, catches rejection and allows retry without double dispatch", async () => {
    const setNote = vi.fn();
    let disabled = true;
    const splitPane = vi.fn(async () => {
      throw new Error("offline");
    });
    const owner = testOwner({
      setNote,
      splitPane,
      disabledReason: () => (disabled ? "Open a live session first" : null),
    });
    owner.activate("split-right", "mouse");
    expect(splitPane).not.toHaveBeenCalled();
    expect(setNote).toHaveBeenCalledWith("Open a live session first");
    disabled = false;
    owner.activate("split-right", "keyboard");
    owner.activate("split-right", "mouse");
    await vi.waitFor(() => expect(owner.busy()).toBe(false));
    expect(splitPane).toHaveBeenCalledTimes(1);
    expect(setNote).toHaveBeenCalledWith("Command failed. Check the live session and try again.");
    owner.activate("split-right", "keyboard");
    await vi.waitFor(() => expect(owner.busy()).toBe(false));
    expect(splitPane).toHaveBeenCalledTimes(2);
  });
  it("does not close a newly opened palette when an older action settles", async () => {
    let finish!: (value: string) => void;
    const setPaletteOpen = vi.fn(async () => true);
    const owner = testOwner({
      newWindow: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      binding: {
        setPaletteOpen,
        openSurface: vi.fn(async () => true),
        activatePaletteSurface: vi.fn(async () => true),
      },
    });
    owner.activate("new-window", "keyboard");
    owner.setOpen(false, "keyboard");
    owner.setOpen(true, "mouse");
    finish("created");
    await vi.waitFor(() => expect(owner.busy()).toBe(false));
    expect(setPaletteOpen.mock.calls.map((args) => args[0])).toEqual([false, true]);
  });
  it("routes pointer and keyboard catalog sessions through the same starter without falling through to pane actions", async () => {
    const openSession = vi.fn(async () => undefined);
    const cancelNavigation = vi.fn();
    const paneAction = vi.fn(async () => "unexpected pane mutation");
    const setPaletteOpen = vi.fn(async () => true);
    const owner = createApplicationPaletteCommandOwner({
      activeSurface: () => "terminals",
      binding: {
        openSurface: vi.fn(async () => true),
        setPaletteOpen,
        activatePaletteSurface: vi.fn(async () => true),
      },
      commandSource: (kind, surface) => ({ kind, surface }),
      setSurface: vi.fn(),
      setNote: vi.fn(),
      newWindow: paneAction,
      splitPane: paneAction,
      closePane: paneAction,
      openAgent: vi.fn(async () => true),
      openSession,
      onNavigationIntent: cancelNavigation,
    });
    for (const source of ["keyboard", "mouse"] as const) {
      owner.activate(
        { kind: "open-session", sessionName: "beta workspace", label: "beta workspace" },
        source,
      );
      await Promise.resolve();
      expect(openSession).toHaveBeenLastCalledWith("beta workspace", source);
      expect(setPaletteOpen).toHaveBeenLastCalledWith(false, {
        kind: source,
        surface: "command-palette",
      });
    }
    expect(cancelNavigation).toHaveBeenCalledTimes(2);
    expect(paneAction).not.toHaveBeenCalled();
  });

  it("routes keyboard agent jumps through the shared semantic navigator", async () => {
    const openAgent = vi.fn(async () => true);
    const setPaletteOpen = vi.fn(async () => true);
    const owner = createApplicationPaletteCommandOwner({
      activeSurface: () => "terminals",
      binding: {
        openSurface: vi.fn(async () => true),
        setPaletteOpen,
        activatePaletteSurface: vi.fn(async () => true),
      },
      commandSource: (kind, surface) => ({ kind, surface }),
      setSurface: vi.fn(),
      setNote: vi.fn(),
      newWindow: async () => "created window",
      splitPane: async () => "split pane",
      closePane: async () => "closed pane",
      openAgent,
    });

    owner.activate(
      {
        kind: "jump-agent",
        sessionName: "session-agents",
        paneId: "pane.agent",
        label: "Codex",
      },
      "keyboard",
    );
    await Promise.resolve();

    expect(setPaletteOpen).toHaveBeenCalledWith(false, {
      kind: "keyboard",
      surface: "command-palette",
    });
    expect(openAgent).toHaveBeenCalledWith("session-agents", "pane.agent", "keyboard");
  });
});
