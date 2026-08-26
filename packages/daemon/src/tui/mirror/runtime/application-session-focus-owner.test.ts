import { describe, expect, it, vi } from "vitest";

import { createApplicationSessionFocusOwner } from "./application-session-focus-owner.ts";

describe("application session focus owner", () => {
  it("waits for a live generation and layout, then focuses the chooser-opened terminal", async () => {
    let status = "connecting";
    let panes: readonly { pane: string; active: boolean }[] = [];
    const focusTerminalPane = vi.fn(async () => true);
    const source = { kind: "keyboard" as const, surface: "application-bar" as const };
    const owner = createApplicationSessionFocusOwner({
      generation: () => ({ status }) as never,
      layout: () =>
        ({
          current: panes.length ? { panes } : null,
          windows: [],
        }) as never,
      focusTerminalPane,
    });

    owner.request(source);
    owner.adopt();
    expect(focusTerminalPane).not.toHaveBeenCalled();
    status = "live";
    panes = [
      { pane: "pane.first", active: false },
      { pane: "pane.active", active: true },
    ];
    owner.adopt();
    await vi.waitFor(() => expect(focusTerminalPane).toHaveBeenCalledOnce());
    expect(focusTerminalPane).toHaveBeenCalledWith("pane.active", source);
  });

  it("restores terminal focus after a replacement daemon generation becomes live", async () => {
    let snapshot = { status: "live", daemonGeneration: "daemon-a", rendererEpoch: 1 };
    const focusTerminalPane = vi.fn(async () => true);
    const source = { kind: "keyboard" as const, surface: "application-bar" as const };
    const owner = createApplicationSessionFocusOwner({
      generation: () => snapshot as never,
      layout: () =>
        ({ current: { panes: [{ pane: "pane.active", active: true }] }, windows: [] }) as never,
      focusTerminalPane,
    });

    owner.request(source);
    await vi.waitFor(() => expect(focusTerminalPane).toHaveBeenCalledOnce());
    owner.adopt();
    snapshot = { status: "rebinding", daemonGeneration: "daemon-a", rendererEpoch: 1 };
    owner.adopt();
    snapshot = { status: "live", daemonGeneration: "daemon-b", rendererEpoch: 2 };
    owner.adopt();

    await vi.waitFor(() => expect(focusTerminalPane).toHaveBeenCalledTimes(2));
    expect(focusTerminalPane).toHaveBeenLastCalledWith("pane.active", source);
  });
});
