import { describe, expect, it, vi } from "vitest";
import { ControlChannelCore } from "./control-channel.ts";

describe("ControlChannelCore reply ownership", () => {
  it("does not let a server-side hook reply spend a client-command FIFO slot", async () => {
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });

    const greeting = new Promise<string[]>((resolve, reject) => {
      core.push({ kind: "promise", resolve, reject, lines: [] });
    });
    core.feed("%begin 100 1 0\n%end 100 1 0\n");
    await expect(greeting).resolves.toEqual([]);

    const first = new Promise<string[]>((resolve, reject) => {
      core.push({ kind: "promise", resolve, reject, lines: [] });
    });
    const second = new Promise<string[]>((resolve, reject) => {
      core.push({ kind: "promise", resolve, reject, lines: [] });
    });

    core.feed(
      [
        "%begin 100 2 1",
        "first command",
        "%end 100 2 1",
        "%begin 100 3 0",
        "after-capture-pane hook",
        "%end 100 3 0",
        "%begin 100 4 1",
        "second command",
        "%end 100 4 1",
        "",
      ].join("\n"),
    );

    await expect(first).resolves.toEqual(["first command"]);
    await expect(second).resolves.toEqual(["second command"]);
    expect(core.pendingCount).toBe(0);
    expect(core.inputErrorCount).toBe(0);
  });
});
