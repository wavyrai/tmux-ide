import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlReply } from "./control-channel.ts";
import { NativeGridCaptureReader } from "./native-grid-reader.ts";
const valid = {
  ok: true,
  lines: [
    JSON.stringify({
      version: 1,
      cols: 1,
      rows: 1,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [0, 0],
    }),
    JSON.stringify({ row: 0, flags: 0, used: 0, cells: [] }),
  ],
};
function rig() {
  const replies: Array<(reply: ControlReply) => void> = [];
  const command = vi.fn((_cmd, _limits, callback) => replies.push(callback));
  const reader = new NativeGridCaptureReader({ commandBoundedInline: command });
  return { reader, replies, command };
}
afterEach(() => vi.useRealTimers());
describe("native grid connection ownership", () => {
  it.each(["output", "ownership", "disposal"])(
    "keeps successful capture admission fenced after completion across %s",
    async (change) => {
      const { reader, replies } = rig();
      let owns = true;
      let current = true;
      const pending = reader.read(
        "%1",
        () => owns,
        () => current,
      );
      replies[0]!(valid);
      const result = await pending;
      expect(result.status).toBe("captured");
      if (result.status !== "captured") throw new Error("Missing capture");
      expect(result.isCurrent()).toBe(true);
      if (change === "output") current = false;
      else if (change === "ownership") owns = false;
      else reader.dispose();
      expect(result.isCurrent()).toBe(false);
      // The immutable capture remains usable as historical data; the guard
      // only forbids attaching it to a newer canonical state.
      expect(result.snapshot).toMatchObject({ cols: 1, rows: 1 });
      reader.dispose();
    },
  );

  it("rejects changed capture state without retiring the connection or caching failure", async () => {
    const { reader, replies, command } = rig();
    let current = false;
    expect(
      await reader.read(
        "%1",
        () => true,
        () => current,
      ),
    ).toEqual({ status: "changed" });
    expect(command).not.toHaveBeenCalled();
    current = true;
    const stale = reader.read(
      "%1",
      () => true,
      () => current,
    );
    current = false;
    replies[0]!(valid);
    expect(await stale).toEqual({ status: "changed" });
    current = true;
    const fresh = reader.read(
      "%1",
      () => true,
      () => current,
    );
    replies[1]!(valid);
    expect((await fresh).status).toBe("captured");
    reader.dispose();
  });

  it("captures through the bounded primitive and rejects unsafe runtime targets", async () => {
    const { reader, replies, command } = rig();
    expect(await reader.read("%1; kill-server", () => true)).toEqual({ status: "unavailable" });
    expect(command).not.toHaveBeenCalled();
    const result = reader.read("%1", () => true);
    replies[0]!(valid);
    expect((await result).status).toBe("captured");
    expect(command.mock.calls[0]![0]).toBe("capture-pane -p -R -S - -t %1");
    reader.dispose();
  });
  it("caches only explicit unsupported responses for this connection", async () => {
    const { reader, replies, command } = rig();
    const failed = reader.read("%1", () => true);
    replies[0]!({ ok: false, lines: ["can't find pane"] });
    expect(await failed).toEqual({ status: "unavailable" });
    const unsupported = reader.read("%2", () => true);
    replies[1]!({ ok: false, lines: ["parse error: command capture-pane: unknown flag -R"] });
    expect(await unsupported).toEqual({ status: "unsupported" });
    expect(await reader.read("%3", () => true)).toEqual({ status: "unsupported" });
    expect(command).toHaveBeenCalledTimes(2);
  });
  it("discards replacement-pane and retired-connection replies", async () => {
    const { reader, replies } = rig();
    let owns = true;
    const replaced = reader.read("%1", () => owns);
    owns = false;
    replies[0]!(valid);
    expect(await replaced).toEqual({ status: "retired" });
    const pending = reader.read("%2", () => true);
    reader.dispose();
    expect(await pending).toEqual({ status: "retired" });
    replies[1]!(valid);
    expect(await reader.read("%2", () => true)).toEqual({ status: "retired" });
  });
  it("keeps timed-out wire requests counted until their replies drain", async () => {
    vi.useFakeTimers();
    const { reader, replies, command } = rig();
    const pending = Array.from({ length: 64 }, () => reader.read("%1", () => true));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await Promise.all(pending)).every((result) => result.status === "timeout")).toBe(true);
    expect(await reader.read("%1", () => true)).toEqual({ status: "unavailable" });
    expect(command).toHaveBeenCalledTimes(64);
    replies[0]!(valid);
    const fresh = reader.read("%1", () => true);
    replies[64]!(valid);
    expect((await fresh).status).toBe("captured");
    reader.dispose();
  });
});
