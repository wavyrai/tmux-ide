import { PaneStreamInputFrameSchemaZ } from "@tmux-ide/contracts";
import { describe, it, expect, vi } from "vitest";
import { createTerminalInputQueue } from "./terminal-input";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("workspace terminal input queue", () => {
  it("preserves bytes and order across panes and UTF-8 frame boundaries", async () => {
    const calls: Array<{ pane: string; data: string }> = [];
    const send = vi.fn(async (pane, input) => {
      expect(
        PaneStreamInputFrameSchemaZ.safeParse({
          type: "input",
          pane: "pane.test",
          seq: calls.length + 1,
          ...input,
        }).success,
      ).toBe(true);
      calls.push({ pane, data: input.data });
      return "ok" as const;
    });
    const q = createTerminalInputQueue({ authority: () => "lease-a", send }, () => {});
    const data = new TextEncoder().encode("a".repeat(1023) + "🐈\x1b[A\r");
    q.enqueue("pane-a", data);
    q.enqueue("pane-b", new TextEncoder().encode("next"));
    await tick();
    expect(calls.map((c) => c.pane)).toEqual(["pane-a", "pane-a", "pane-b"]);
    expect(
      Buffer.from(
        calls
          .slice(0, 2)
          .map((c) => c.data)
          .join(""),
      ),
    ).toEqual(Buffer.from(data));
    expect(calls[2]?.data).toBe("next");
    q.dispose();
  });
  it("rejects unsupported binary input before it reaches the pane-stream protocol", () => {
    const send = vi.fn();
    const error = vi.fn();
    const q = createTerminalInputQueue({ authority: () => "lease-a", send }, error);
    expect(q.enqueue("pane-a", new Uint8Array([255]))).toBe(false);
    expect(q.enqueue("pane-a", new Uint8Array([0]))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });
  it("does not send without authority", () => {
    const send = vi.fn();
    const error = vi.fn();
    const q = createTerminalInputQueue({ authority: () => null, send }, error);
    expect(q.enqueue("a", new Uint8Array([1]))).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
  it("drops queued input if ownership changes during an acknowledgement", async () => {
    let authority = "a";
    let finish!: (result: "ok") => void;
    const send = vi.fn(
      () =>
        new Promise<"ok">((resolve) => {
          finish = resolve;
        }),
    );
    const error = vi.fn();
    const q = createTerminalInputQueue({ authority: () => authority, send }, error);
    q.enqueue("a", new Uint8Array(2048).fill(65));
    authority = "b";
    finish("ok");
    await tick();
    expect(send).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    q.dispose();
  });
  it("drops input after transport failure without retrying", async () => {
    const send = vi.fn(async () => {
      throw Error("closed");
    });
    const error = vi.fn();
    const q = createTerminalInputQueue({ authority: () => "a", send }, error);
    q.enqueue("a", new Uint8Array(2048).fill(65));
    await tick();
    expect(send).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
  it("bounds queued bytes and retires pending input on disposal", async () => {
    let finish!: (result: "ok") => void;
    const send = vi.fn(
      () =>
        new Promise<"ok">((resolve) => {
          finish = resolve;
        }),
    );
    const error = vi.fn();
    const q = createTerminalInputQueue({ authority: () => "a", send }, error);
    q.enqueue("a", new Uint8Array(64 * 1024).fill(65));
    expect(q.enqueue("b", new Uint8Array([1]))).toBe(false);
    q.dispose();
    finish("ok");
    await tick();
    expect(send).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
