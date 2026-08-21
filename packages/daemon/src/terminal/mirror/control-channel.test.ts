import { describe, expect, it, vi } from "vitest";
import { ControlChannelCore, mirrorControlAttachArgs } from "./control-channel.ts";

describe("retained control client attach policy", () => {
  it("starts passive, flow-controlled, and active-pane aware", () => {
    expect(
      mirrorControlAttachArgs({
        session: "alpha",
        socketName: "isolated",
        socketPath: undefined,
        configFile: undefined,
      }),
    ).toEqual([
      "-L",
      "isolated",
      "-C",
      "attach",
      "-t",
      "alpha",
      "-f",
      "ignore-size,pause-after=2,active-pane",
    ]);
  });
});

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

  it("attributes a split output line to child stdout arrival and parser completion", () => {
    const onOutput = vi.fn();
    const clocks = [1_025];
    const core = new ControlChannelCore(
      { onOutput, onNotify: vi.fn(), onExit: vi.fn() },
      () => clocks.shift()!,
    );

    core.feed("%extended-output %5 80 : mar", 1_000);
    core.feed("ker\r\n", 1_020);

    expect(onOutput).toHaveBeenCalledOnce();
    expect(onOutput.mock.calls[0]?.[0]).toBe("%5");
    expect(onOutput.mock.calls[0]?.[2]).toBe(80);
    expect(onOutput.mock.calls[0]?.[3]).toEqual({
      receivedAtMicros: 1_000,
      parsedAtMicros: 1_025,
    });
  });

  it("observes fire-and-forget acceptance at its own tmux reply boundary", () => {
    const accepted = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    core.push({ kind: "promise", resolve: vi.fn(), reject: vi.fn(), lines: [] });
    core.feed("%begin 1 0 0\n%end 1 0 0\n");
    core.push({ kind: "discard", onReply: accepted });

    core.feed("%begin 1 1 0\n%end 1 1 0\n");
    expect(accepted).not.toHaveBeenCalled();
    core.feed("%begin 1 2 1\n%end 1 2 1\n");

    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledWith({ ok: true, lines: [] });
  });
});
