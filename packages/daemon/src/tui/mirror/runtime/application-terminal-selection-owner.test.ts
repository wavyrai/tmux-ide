import { describe, expect, it, vi } from "vitest";

import {
  applicationClipboardReadiness,
  createApplicationTerminalSelectionOwner,
  routeApplicationTerminalPointerInput,
  settleApplicationClipboardReadiness,
} from "./application-terminal-selection-owner.ts";

describe("application terminal selection owner", () => {
  it("exposes menu input ownership to the root paste gate and clears it on unmount", () => {
    const owner = createApplicationTerminalSelectionOwner({
      copyText: () => true,
      diagnosticsEnabled: false,
      generation: () => null,
    });
    let open = true;
    const handler = vi.fn(() => open);
    owner.registerKey(handler, () => open);
    expect(owner.blocksInput()).toBe(true);
    owner.handleKey("x", { ctrl: true });
    expect(handler).toHaveBeenCalledWith("x", { ctrl: true });
    open = false;
    expect(owner.blocksInput()).toBe(false);
    open = true;
    owner.registerKey(null);
    expect(owner.blocksInput()).toBe(false);
    expect(owner.handleKey("x")).toBe(false);
  });
  it("keeps copy and navigation separate from preparation for terminal keys and paste", () => {
    const owner = createApplicationTerminalSelectionOwner({
      copyText: () => true,
      diagnosticsEnabled: false,
      generation: () => null,
    });
    const prepare = vi.fn();
    const copy = vi.fn(() => true);
    owner.registerKey(
      (name) => name === "up",
      () => false,
      prepare,
    );
    owner.registerCopy(copy);
    expect(owner.handleKey("up")).toBe(true);
    expect(owner.handleKey("c", { ctrl: true })).toBe(false);
    expect(owner.copyCurrent()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    owner.prepareInput();
    expect(prepare).toHaveBeenCalledOnce();
    owner.prepareInput();
    expect(prepare).toHaveBeenCalledTimes(2);
    owner.registerKey(null);
    owner.prepareInput();
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it("routes legacy mouse bytes without UTF-8 expansion", async () => {
    const sendInputToPane = vi.fn(async () => true);
    routeApplicationTerminalPointerInput({ sendInputToPane } as never, "pane-a", {
      kind: "application-mouse",
      data: "1b5b4d20ff80",
      dataEncoding: "hex",
      action: "down",
      column: 222,
      row: 95,
      button: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
      ingress: null,
    });
    await Promise.resolve();
    expect(sendInputToPane).toHaveBeenCalledWith(
      "pane-a",
      { kind: "bytes", data: "1b5b4d20ff80" },
      undefined,
    );
  });

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
