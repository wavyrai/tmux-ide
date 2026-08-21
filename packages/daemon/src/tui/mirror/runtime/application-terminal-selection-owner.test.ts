import { describe, expect, it, vi } from "vitest";

import {
  applicationClipboardReadiness,
  createApplicationTerminalSelectionOwner,
  routeApplicationTerminalPointerInput,
  settleApplicationClipboardReadiness,
} from "./application-terminal-selection-owner.ts";

describe("application terminal selection owner", () => {
  it("routes one exact typed application-mouse input and preserves its ingress", async () => {
    const sendInputToPane = vi.fn(async () => true);
    routeApplicationTerminalPointerInput({ sendInputToPane } as never, "pane-a", {
      kind: "application-mouse",
      data: "\u001b[<0;2;1M",
      action: "down",
      column: 1,
      row: 0,
      button: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
      ingress: {
        gestureId: "00000000-0000-4000-8000-000000000001",
        action: "down",
        x: 29,
        y: 3,
        atMicros: 10,
      },
    });
    await Promise.resolve();
    expect(sendInputToPane).toHaveBeenCalledOnce();
    expect(sendInputToPane).toHaveBeenCalledWith(
      "pane-a",
      { kind: "text", data: "\u001b[<0;2;1M" },
      expect.objectContaining({
        origin: "application-mouse",
        gestureId: "00000000-0000-4000-8000-000000000001",
        pointerAction: "down",
        pointerColumn: 1,
        pointerRow: 0,
        pointerButton: 0,
      }),
    );
  });

  it("fails closed with a typed clipboard-ready boundary when tmux policy setup returns false", async () => {
    const resolve = vi.fn();
    let failure: (Error & { code?: string; boundary?: string }) | null = null;
    settleApplicationClipboardReadiness(Promise.resolve(false), true, resolve, (error) => {
      failure = error;
    });
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
    expect(failure).toMatchObject({ code: "clipboard_not_ready", boundary: "clipboard-ready" });
  });

  it("does not require tmux clipboard setup outside tmux", async () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    settleApplicationClipboardReadiness(Promise.resolve(false), false, resolve, reject);
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it("maps synchronous clipboard setup failure to the typed readiness boundary", async () => {
    await expect(
      applicationClipboardReadiness(() => {
        throw new Error("policy runner unavailable");
      }, true),
    ).rejects.toMatchObject({ code: "clipboard_not_ready", boundary: "clipboard-ready" });
  });

  it("does no pointer clock or generation work when diagnostics are disabled", () => {
    const generation = vi.fn(() => null);
    const owner = createApplicationTerminalSelectionOwner({
      copyText: () => true,
      diagnosticsEnabled: false,
      generation,
    });
    expect(owner.beginPointerIngress({ action: "down", x: 1, y: 2, atMicros: 3 })).toBeNull();
    expect(generation).not.toHaveBeenCalled();
  });
});
