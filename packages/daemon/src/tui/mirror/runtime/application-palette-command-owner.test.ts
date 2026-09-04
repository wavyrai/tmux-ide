import { describe, expect, it, vi } from "vitest";

import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";

describe("application palette command owner", () => {
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
