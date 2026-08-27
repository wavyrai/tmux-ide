import { describe, expect, it, vi } from "vitest";

import { createApplicationPaletteCommandOwner } from "./application-palette-command-owner.ts";

describe("application palette command owner", () => {
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
