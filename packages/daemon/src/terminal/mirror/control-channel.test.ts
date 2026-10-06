import { describe, expect, it, vi } from "vitest";
import {
  ControlChannelCore,
  MirrorControlChannel,
  mirrorControlAttachArgs,
} from "./control-channel.ts";

describe("retained control client attach policy", () => {
  it("refuses to spawn when the owning daemon rejects its socket authority", async () => {
    const resolveSocketPath = vi.fn(() => {
      throw new Error("retired daemon socket authority");
    });
    const channel = new MirrorControlChannel({
      session: "owned",
      executable: "/nonexistent/test-only-tmux",
      resolveSocketPath,
      handlers: { onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() },
    });
    await expect(channel.start()).rejects.toThrow("retired daemon socket authority");
    expect(resolveSocketPath).toHaveBeenCalledOnce();
    await expect(channel.request("list-panes")).rejects.toThrow("not running");
    await channel.dispose();
  });

  it("does not fall back to an ambient socket when the resolver returns no authority", async () => {
    const channel = new MirrorControlChannel({
      session: "owned",
      executable: "/nonexistent/test-only-tmux",
      resolveSocketPath: () => "",
      handlers: { onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() },
    });
    await expect(channel.start()).rejects.toThrow("Tmux socket authority is unavailable");
    await channel.dispose();
  });
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
  it.each([{ branchLines: [] }, { branchLines: [""] }])(
    "keeps capture and cursor replies after marker cleanup branch %j",
    ({ branchLines }) => {
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      const cleanup = vi.fn();
      const capture = vi.fn();
      const cursor = vi.fn();
      core.pushCommandList(2, 1, cleanup);
      core.pushCommandList(1, 0, capture);
      core.pushCommandList(1, 0, cursor);
      const block = (id: number, lines: string[]) =>
        [`%begin 100 ${id} 1`, ...lines, `%end 100 ${id} 1`, ""].join("\n");
      core.feed(block(1, []));
      expect(cleanup).not.toHaveBeenCalled();
      core.feed(block(2, branchLines));
      expect(cleanup).toHaveBeenCalledWith({ ok: true, lines: branchLines });
      expect(capture).not.toHaveBeenCalled();
      core.feed(block(3, ['{"version":2,"cols":8}']));
      core.feed(block(4, ["0 0 8 8"]));
      expect(capture).toHaveBeenCalledWith({ ok: true, lines: ['{"version":2,"cols":8}'] });
      expect(cursor).toHaveBeenCalledWith({ ok: true, lines: ["0 0 8 8"] });
      expect(core.pendingCount).toBe(0);
    },
  );

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

describe("ControlChannelCore atomic pane snapshot collector", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const block = (ordinal: number, ...lines: string[]): string[] => [
    `%begin 1 ${100 + ordinal} 0`,
    ...lines,
    `%end 1 ${100 + ordinal} 0`,
  ];
  const guardedSnapshot = (
    captureLines: readonly string[],
    cursorLine: string,
    options: {
      continueNotify?: boolean;
      markerRejected?: boolean;
      statusLines?: readonly string[];
    } = {},
  ): string[] => [
    ...block(0, `%tmux-ide-atomic-v1 ${nonce} start`),
    ...block(1, ...captureLines),
    ...block(2, `%tmux-ide-atomic-v1 ${nonce} capture-end`),
    ...block(3, cursorLine),
    ...block(4, `%tmux-ide-atomic-v1 ${nonce} cursor-end`),
    ...block(5, ...(options.continueNotify === false ? [] : ["%continue %7"])),
    ...block(6),
    ...block(7),
    ...block(8),
    ...block(
      9,
      ...(options.markerRejected ? [`%tmux-ide-atomic-v1 ${nonce} marker-rejected`] : []),
    ),
    ...block(10, ...(options.statusLines ?? [`%tmux-ide-atomic-v1 ${nonce} status-ok`])),
    ...block(11),
    ...block(12, `%tmux-ide-atomic-v1 ${nonce} complete`),
  ];

  const dualSnapshot = (native: string[], ansi: string[]): string[] => {
    const wire = guardedSnapshot(native, "0 0 80 24");
    const cursor = wire.indexOf("%begin 1 103 0");
    return [
      ...wire.slice(0, cursor),
      ...block(3, ...ansi),
      ...block(4, `%tmux-ide-atomic-v1 ${nonce} ansi-capture-end`),
      ...wire
        .slice(cursor)
        .map((line) =>
          line.replace(
            /^(%begin|%end) 1 (\d+) 0$/u,
            (_, guard: string, num: string) => `${guard} 1 ${Number(num) + 2} 0`,
          ),
        ),
    ];
  };

  it("separates dual representations and preserves notification-shaped ANSI rows", () => {
    const settled = vi.fn(),
      onNotify = vi.fn(),
      drained = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify, onExit: vi.fn() });
    expect(
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        dualCapture: true,
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
        onDrained: drained,
      }),
    ).toBe(true);
    const wire = dualSnapshot(["native-grid"], ["%pause %7", "%continue %7", "ansi"]);
    // Split input across every byte to exercise framing independently of chunks.
    for (const byte of wire.join("\n") + "\n") core.feed(byte);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0][0]).toMatchObject({
      ok: true,
      captureLines: ["native-grid"],
      ansiCaptureLines: ["%pause %7", "%continue %7", "ansi"],
      cursorLine: "0 0 80 24",
      continueObserved: true,
      observerEmissionObserved: true,
      captureLineCount: 4,
    });
    expect(onNotify).not.toHaveBeenCalled();
    expect(drained).toHaveBeenCalledWith("complete");
  });

  it.each(["byte", "line", "sentinel"])(
    "rejects dual %s violations without retaining either capture",
    (kind) => {
      const settled = vi.fn();
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      const spec = {
        nonce,
        runtimePaneId: "%7",
        dualCapture: true,
        maxCaptureBytes: kind === "byte" ? 7 : 4096,
        maxCaptureLines: kind === "line" ? 1 : 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      };
      core.armAtomicPaneSnapshotCollector(spec);
      const wire = dualSnapshot(["native"], ["ansi"]).map((line) =>
        kind === "sentinel" ? line.replace("ansi-capture-end", "capture-end") : line,
      );
      core.feed(wire.join("\n") + "\n");
      expect(settled).toHaveBeenCalledOnce();
      expect(settled.mock.calls[0][0]).toMatchObject({
        ok: false,
        captureLines: [],
        ansiCaptureLines: [],
        failureReason:
          kind === "byte"
            ? "capture-byte-cap"
            : kind === "line"
              ? "capture-line-cap"
              : "sentinel-order",
      });
      expect(core.armAtomicPaneSnapshotCollector(spec)).toBe(false);
      expect(core.releaseRetiredCollector(nonce)).toBe(true);
      expect(core.armAtomicPaneSnapshotCollector(spec)).toBe(true);
    },
  );

  it("retires dual capture between representations without publishing partial payload", () => {
    const settled = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      dualCapture: true,
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    const wire = dualSnapshot(["native"], ["ansi"]);
    const split = wire.indexOf("%begin 1 103 0");
    core.feed(wire.slice(0, split).join("\n") + "\n");
    core.retireAtomicPaneSnapshotCollector(nonce);
    core.feed(wire.slice(split).join("\n") + "\n");
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0][0]).toMatchObject({
      ok: false,
      captureLines: [],
      ansiCaptureLines: [],
    });
    expect(core.releaseRetiredCollector(nonce)).toBe(true);
  });

  it("keeps pause-shaped capture text as snapshot data", () => {
    const onNotify = vi.fn(),
      settled = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify, onExit: vi.fn() });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    core.feed([...guardedSnapshot(["%pause %7"], "0 0 80 24"), ""].join("\n"));
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: true, captureLines: ["%pause %7"] });
    expect(settled.mock.calls[0]?.[0].pauseObserved).toBeUndefined();
    expect(onNotify).not.toHaveBeenCalled();
  });

  it.each([
    {
      maxCaptureBytes: 4096,
      maxCaptureLines: 1,
      lines: ["one", "two"],
      reason: "capture-line-cap",
    },
    { maxCaptureBytes: 3, maxCaptureLines: 16, lines: ["oversized"], reason: "capture-byte-cap" },
  ])("rejects $reason without publishing a partial recovery snapshot", (fixture) => {
    const settled = vi.fn();
    const output = vi.fn();
    const core = new ControlChannelCore({ onOutput: output, onNotify: vi.fn(), onExit: vi.fn() });
    expect(
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: fixture.maxCaptureBytes,
        maxCaptureLines: fixture.maxCaptureLines,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      }),
    ).toBe(true);
    core.feed(
      [...guardedSnapshot(fixture.lines, "0 0 80 24"), "%output %7 subsequent", ""].join("\n"),
    );
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: false, failureReason: fixture.reason });
    expect(settled.mock.calls[0]?.[0].captureLines).toEqual([]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(output.mock.calls[0]?.[1])).toBe("subsequent");
  });

  it("consumes raw capture rows before notification parsing and returns one framed snapshot", () => {
    const onOutput = vi.fn();
    const onNotify = vi.fn();
    const settled = vi.fn();
    const core = new ControlChannelCore({ onOutput, onNotify, onExit: vi.fn() });
    expect(
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      }),
    ).toBe(true);
    const wire = [
      ...guardedSnapshot(
        [
          "%output %99 raw-pane-looking-data",
          "%begin 9 777 0",
          "%tmux-ide-atomic-v0 forged capture-end",
          "%exit terminal-content",
          "ordinary capture row",
        ],
        "3 4 132 41 0 1 0 0 0 0 0 0 0 1",
      ),
      "",
    ].join("\n");
    for (let offset = 0; offset < wire.length; offset += 7)
      core.feed(wire.slice(offset, offset + 7));
    expect(onOutput).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith({
      ok: true,
      captureLines: [
        "%output %99 raw-pane-looking-data",
        "%begin 9 777 0",
        "%tmux-ide-atomic-v0 forged capture-end",
        "%exit terminal-content",
        "ordinary capture row",
      ],
      cursorLine: "3 4 132 41 0 1 0 0 0 0 0 0 0 1",
      continueObserved: true,
      statusObserved: true,
      observerEmissionObserved: true,
      started: true,
      lastCompletedOrdinal: 12,
      captureLineCount: 5,
      captureByteCount: 132,
      failureReason: null,
    });
  });

  it("fails sticky on foreign/duplicate/malformed framing and never exposes captured bytes", () => {
    const settled = vi.fn();
    const progress = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 8,
      maxCaptureLines: 1,
      maxCursorBytes: 8,
      observerCommandCount: 2,
      onProgress: progress,
      onSettled: settled,
    });
    core.feed(
      [
        ...guardedSnapshot(
          [
            `%tmux-ide-atomic-v1 ffffffffffffffffffffffffffffffff capture-end`,
            "too-long-row",
            "duplicate-row",
          ],
          "too-long-cursor",
          {
            statusLines: [
              `%tmux-ide-atomic-v1 ${nonce} status-ok`,
              `%tmux-ide-atomic-v1 ${nonce} status-ok`,
            ],
          },
        ),
        "",
      ].join("\n"),
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      captureLines: [],
      cursorLine: null,
      failureReason: "foreign-sentinel",
    });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ lastCompletedOrdinal: 0 });
  });

  it("keeps cancelled hook ownership until a separate ordinary fence drains", () => {
    const first = vi.fn();
    const second = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    const spec = {
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: first,
    };
    const nextNonce = "a".repeat(32);
    expect(core.armAtomicPaneSnapshotCollector(spec)).toBe(true);
    core.retireAtomicPaneSnapshotCollector(nonce);
    expect(first).toHaveBeenCalledOnce();
    expect(
      core.armAtomicPaneSnapshotCollector({ ...spec, nonce: nextNonce, onSettled: second }),
    ).toBe(false);
    // Cancellation occurred before the hook start reached the reader. Its
    // complete real framing still belongs to the first protocol owner.
    core.feed([...guardedSnapshot(["cancelled"], "0 0 80 24"), ""].join("\n"));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(
      core.armAtomicPaneSnapshotCollector({ ...spec, nonce: nextNonce, onSettled: second }),
    ).toBe(false);
    expect(core.releaseRetiredCollector("f".repeat(32))).toBe(false);
    core.push({
      kind: "inline",
      lines: [],
      onReply: (reply) => {
        expect(reply).toEqual({ ok: true, lines: ["unique-fence"] });
        expect(core.releaseRetiredCollector(nonce)).toBe(true);
      },
    });
    core.feed("%begin 1 200 1\nunique-fence\n%end 1 200 1\n");
    expect(
      core.armAtomicPaneSnapshotCollector({ ...spec, nonce: nextNonce, onSettled: second }),
    ).toBe(true);
    core.feed(
      [...guardedSnapshot(["current"], "1 0 80 24"), ""].join("\n").replaceAll(nonce, nextNonce),
    );
    expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0]?.[0]).toMatchObject({ ok: true, captureLines: ["current"] });
  });

  it("does not let fence-shaped raw capture rows consume ordinary slots", () => {
    const settled = vi.fn(),
      drained = vi.fn(),
      ordinary = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
      onDrained: drained,
    });
    core.retireAtomicPaneSnapshotCollector(nonce);
    core.push({ kind: "inline", onReply: ordinary, lines: [] });
    core.feed(
      "%begin 1 100 0\n%begin 1 999 1\nunique-fence\n%tmux-ide-atomic-v1 " +
        nonce +
        " complete\n%end 1 100 0\n",
    );
    expect(ordinary).not.toHaveBeenCalled();
    expect(drained).not.toHaveBeenCalled();
    core.feed("%begin 1 200 1\nordinary-result\n%end 1 200 1\n");
    expect(ordinary).toHaveBeenCalledWith({ ok: true, lines: ["ordinary-result"] });
    expect(core.releaseRetiredCollector(nonce)).toBe(true);
    expect(core.releaseRetiredCollector(nonce)).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("fence");
  });

  it("retains an in-flight raw block when cancellation occurs mid-capture", () => {
    const settled = vi.fn(),
      drained = vi.fn(),
      reply = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
      onDrained: drained,
    });
    core.feed(
      [...block(0, `%tmux-ide-atomic-v1 ${nonce} start`), "%begin 1 101 0", "partial", ""].join(
        "\n",
      ),
    );
    core.retireAtomicPaneSnapshotCollector(nonce);
    core.push({ kind: "inline", onReply: reply, lines: [] });
    core.feed("more-raw\n%end 1 101 0\n%begin 1 200 1\nfence\n%end 1 200 1\n");
    expect(reply).toHaveBeenCalledWith({ ok: true, lines: ["fence"] });
    expect(drained).not.toHaveBeenCalled();
    core.fail("connection closed");
    core.fail("duplicate");
    expect(settled).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("channel-exit");
  });

  it("fails the connection on malformed retired raw framing", () => {
    const drained = vi.fn(),
      exit = vi.fn(),
      pending = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: exit });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: vi.fn(),
      onDrained: drained,
    });
    core.retireAtomicPaneSnapshotCollector(nonce);
    core.push({ kind: "inline", onReply: pending, lines: [] });
    core.feed("%begin 1 100 0\nraw\n%end 1 999 0\n");
    expect(exit).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("channel-exit");
    expect(pending).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: vi.fn(),
      }),
    ).toBe(false);
  });

  it("keeps tombstone ownership when settlement reenters or throws", () => {
    const drained = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    const spec = {
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onDrained: drained,
      onSettled: vi.fn(() => {
        expect(core.retireAtomicPaneSnapshotCollector(nonce)).toBe(false);
        expect(core.armAtomicPaneSnapshotCollector({ ...spec, nonce: "a".repeat(32) })).toBe(false);
        throw new Error("consumer failed");
      }),
    };
    core.armAtomicPaneSnapshotCollector(spec);
    expect(() => core.retireAtomicPaneSnapshotCollector(nonce)).toThrow("consumer failed");
    expect(core.releaseRetiredCollector(nonce)).toBe(true);
    expect(spec.onSettled).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("fence");
  });

  it("does not arm a collector without a live control process", async () => {
    const channel = new MirrorControlChannel({
      session: "unused",
      handlers: {
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      },
    });
    expect(
      channel.armAtomicPaneSnapshotCollector(
        {
          nonce,
          runtimePaneId: "%7",
          maxCaptureBytes: 4096,
          maxCaptureLines: 16,
          maxCursorBytes: 256,
          observerCommandCount: 2,
          onSettled: vi.fn(),
        },
        100,
      ),
    ).toBe(false);
    await channel.dispose();
  });

  it("retains failed completion until a fence rather than trusting the final ordinal", () => {
    const drained = vi.fn(),
      settled = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    const spec = {
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
      onDrained: drained,
    };
    core.armAtomicPaneSnapshotCollector(spec);
    core.feed(
      [
        ...guardedSnapshot(["row"], "0 0 80 24", {
          statusLines: ["invalid-status"],
        }),
        "",
      ].join("\n"),
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: false });
    expect(drained).not.toHaveBeenCalled();
    expect(core.armAtomicPaneSnapshotCollector({ ...spec, nonce: "a".repeat(32) })).toBe(false);
    expect(core.releaseRetiredCollector(nonce)).toBe(true);
    expect(drained).toHaveBeenCalledExactlyOnceWith("fence");
  });

  it("closes instead of releasing healthy admission when successful settlement throws", () => {
    const drained = vi.fn(),
      exit = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: exit });
    const spec = {
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: vi.fn(() => {
        throw new Error("owner cleanup failed");
      }),
      onDrained: drained,
    };
    core.armAtomicPaneSnapshotCollector(spec);
    core.feed([...guardedSnapshot(["row"], "0 0 80 24"), ""].join("\n"));
    expect(spec.onSettled).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("channel-exit");
    expect(exit).toHaveBeenCalledOnce();
    expect(core.armAtomicPaneSnapshotCollector({ ...spec, nonce: "a".repeat(32) })).toBe(false);
  });

  it.each(["timeout", "invalid-fence", "settlement-throw"] as const)(
    "closes the wrapper on failed retired drain: %s",
    async (scenario) => {
      vi.useFakeTimers();
      const onExit = vi.fn(),
        drained = vi.fn(),
        write = vi.fn();
      const channel = new MirrorControlChannel({
        session: "unused",
        handlers: {
          onOutput: vi.fn(),
          onNotify: vi.fn(),
          onExit,
        },
      });
      const dispose = vi.spyOn(channel, "dispose").mockResolvedValue();
      const core = Reflect.get(channel, "core") as ControlChannelCore;
      Reflect.set(channel, "proc", { stdin: { writable: true, write } });
      core.feed("%begin 1 1 0\n%end 1 1 0\n");
      const settled = vi.fn(() => {
        if (scenario === "settlement-throw") throw new Error("owner failed");
      });
      const spec = {
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
        onDrained: drained,
      };
      try {
        expect(channel.armAtomicPaneSnapshotCollector(spec, 100)).toBe(true);
        channel.retireAtomicPaneSnapshotCollector(nonce);
        expect(settled).toHaveBeenCalledOnce();
        if (scenario === "timeout") await vi.advanceTimersByTimeAsync(5000);
        if (scenario === "invalid-fence") core.feed("%begin 1 2 1\nwrong-fence\n%end 1 2 1\n");
        expect(drained).toHaveBeenCalledExactlyOnceWith("channel-exit");
        expect(onExit).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalled();
        expect(
          channel.armAtomicPaneSnapshotCollector({ ...spec, nonce: "a".repeat(32) }, 100),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(5000);
        expect(drained).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        dispose.mockRestore();
      }
    },
  );

  it("does not clear a new collector timer from an old drain callback", async () => {
    vi.useFakeTimers();
    const write = vi.fn(),
      nextSettled = vi.fn(),
      drained = vi.fn();
    const channel = new MirrorControlChannel({
      session: "unused",
      handlers: {
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      },
    });
    const dispose = vi.spyOn(channel, "dispose").mockResolvedValue();
    const core = Reflect.get(channel, "core") as ControlChannelCore;
    Reflect.set(channel, "proc", { stdin: { writable: true, write } });
    core.feed("%begin 1 1 0\n%end 1 1 0\n");
    const spec = {
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: vi.fn(),
    };
    try {
      channel.armAtomicPaneSnapshotCollector(
        {
          ...spec,
          onDrained: (reason) => {
            drained(reason);
            if (reason === "fence")
              expect(
                channel.armAtomicPaneSnapshotCollector(
                  {
                    ...spec,
                    nonce: "a".repeat(32),
                    onSettled: nextSettled,
                  },
                  100,
                ),
              ).toBe(true);
          },
        },
        1000,
      );
      channel.retireAtomicPaneSnapshotCollector(nonce);
      const fence = String(write.mock.calls[0]?.[0]).trim().split(" ").at(-1)!;
      core.feed(`%begin 1 2 1\n${fence}\n%end 1 2 1\n`);
      expect(drained).toHaveBeenCalledExactlyOnceWith("fence");
      await vi.advanceTimersByTimeAsync(99);
      expect(nextSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(nextSettled).toHaveBeenCalledOnce();
      expect(nextSettled.mock.calls[0]?.[0]).toMatchObject({ failureReason: "timeout" });
      core.fail("test cleanup");
    } finally {
      vi.useRealTimers();
      dispose.mockRestore();
    }
  });

  it("fails closed if the drained callback throws before the next same-chunk reply", () => {
    const next = vi.fn(),
      exit = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: exit });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: vi.fn(),
      onDrained: () => {
        throw new Error("admission failed");
      },
    });
    core.retireAtomicPaneSnapshotCollector(nonce);
    core.push({
      kind: "inline",
      lines: [],
      onReply: () => {
        core.releaseRetiredCollector(nonce);
      },
    });
    core.push({ kind: "inline", lines: [], onReply: next });
    core.feed("%begin 1 200 1\nfence\n%end 1 200 1\n%begin 1 201 1\nnot-delivered\n%end 1 201 1\n");
    expect(exit).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toMatchObject({ ok: false });
  });

  it("settles all pending requests even when collector exit callbacks throw", () => {
    const settled = vi.fn(() => {
      throw new Error("settled failed");
    });
    const drained = vi.fn(() => {
      throw new Error("drained failed");
    });
    const pending = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: () => {
        throw new Error("exit failed");
      },
    });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
      onDrained: drained,
    });
    core.push({
      kind: "inline",
      lines: [],
      onReply: () => {
        throw new Error("first request failed");
      },
    });
    core.push({ kind: "inline", lines: [], onReply: pending });
    expect(() => core.fail("connection exited")).not.toThrow();
    expect(settled).toHaveBeenCalledOnce();
    expect(drained).toHaveBeenCalledExactlyOnceWith("channel-exit");
    expect(pending).toHaveBeenCalledWith({ ok: false, lines: ["connection exited"] });
    expect(core.pendingCount).toBe(0);
  });

  it("retires a missing completion once and ignores a stale nonce", () => {
    const settled = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    core.retireAtomicPaneSnapshotCollector("f".repeat(32), "timeout");
    expect(settled).not.toHaveBeenCalled();
    core.retireAtomicPaneSnapshotCollector(nonce, "timeout");
    core.retireAtomicPaneSnapshotCollector(nonce, "retired");
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: false, failureReason: "timeout" });
  });

  it("retires before dispatching pane death and cannot redeem a partial snapshot", () => {
    const settled = vi.fn();
    const onExit = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    core.feed(
      [
        ...block(0, `%tmux-ide-atomic-v1 ${nonce} start`),
        ...block(1, "partial"),
        "%exit pane-died",
        "",
      ].join("\n"),
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      captureLines: [],
      failureReason: "channel-exit",
    });
    expect(onExit).toHaveBeenCalledWith("pane-died");
  });

  it("fails closed on output inside the post-capture seam and resumes parsing only after retire", () => {
    const settled = vi.fn();
    const onOutput = vi.fn();
    const core = new ControlChannelCore({ onOutput, onNotify: vi.fn(), onExit: vi.fn() });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    const framed = guardedSnapshot(["snapshot"], "0 0 80 24", { continueNotify: false });
    framed.splice(framed.indexOf("%begin 1 105 0") + 1, 0, "%output %7 interleaved");
    core.feed([...framed, "%output %7 after-complete", ""].join("\n"));
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      failureReason: "sentinel-order",
    });
    expect(onOutput).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onOutput.mock.calls[0]?.[1])).toBe("after-complete");
  });

  it("rejects a body error at every guarded command ordinal and mismatched guard ownership", () => {
    for (let ordinal = 0; ordinal <= 12; ordinal += 1) {
      const settled = vi.fn();
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      });
      const lines = guardedSnapshot(["snapshot"], "0 0 80 24");
      const end = `%end 1 ${100 + ordinal} 0`;
      const errorIndex = lines.indexOf(end);
      lines[errorIndex] = `%error 1 ${100 + ordinal} 0`;
      core.feed([...lines.slice(0, errorIndex + 1), ""].join("\n"));
      core.retireAtomicPaneSnapshotCollector(nonce, "timeout");
      expect(settled.mock.calls[0]?.[0]).toMatchObject({
        ok: false,
        failureReason: "sentinel-order",
        observerEmissionObserved: ordinal >= 8,
      });
    }

    const settled = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    const lines = guardedSnapshot(["snapshot"], "0 0 80 24");
    lines[lines.indexOf("%end 1 101 0")] = "%end 1 999 0";
    core.feed([...lines, ""].join("\n"));
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      failureReason: "sentinel-order",
    });
  });

  it("accepts at most one matching continue line in the refresh block only", () => {
    for (const mutate of [
      (lines: string[]) =>
        lines.splice(lines.indexOf("%begin 1 105 0") + 1, 0, "%continue %7", "%continue %7"),
      (lines: string[]) => lines.splice(lines.indexOf("%begin 1 106 0") + 1, 0, "%continue %7"),
      (lines: string[]) => lines.splice(lines.indexOf("%begin 1 105 0") + 1, 0, "%continue %8"),
    ]) {
      const settled = vi.fn();
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      });
      const lines = guardedSnapshot(["snapshot"], "0 0 80 24", { continueNotify: false });
      mutate(lines);
      core.feed([...lines, ""].join("\n"));
      expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: false });
    }
  });

  it("keeps the outer+branch reply pair ahead of a concurrently queued callback", () => {
    for (const authorized of [true, false]) {
      const invocation = vi.fn();
      const later = vi.fn();
      const settled = vi.fn();
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      core.push({ kind: "discard" });
      core.push({ kind: "inline", onReply: invocation, lines: [] });
      core.push({ kind: "inline", onReply: later, lines: [] });
      core.armAtomicPaneSnapshotCollector({
        nonce,
        runtimePaneId: "%7",
        maxCaptureBytes: 4096,
        maxCaptureLines: 16,
        maxCursorBytes: 256,
        observerCommandCount: 2,
        onSettled: settled,
      });
      core.feed(
        [
          "%begin 1 1 1",
          "%end 1 1 1",
          "%begin 1 2 1",
          ...(authorized ? [] : [`tmux-ide-atomic-invoke-rejected-v1:${nonce}`]),
          "%end 1 2 1",
          ...(authorized ? guardedSnapshot(["snapshot"], "0 0 80 24") : []),
          "%begin 1 3 1",
          "later-result",
          "%end 1 3 1",
          "",
        ].join("\n"),
      );
      expect(invocation).toHaveBeenCalledWith({
        ok: true,
        lines: authorized ? [] : [`tmux-ide-atomic-invoke-rejected-v1:${nonce}`],
      });
      expect(later).toHaveBeenCalledWith({ ok: true, lines: ["later-result"] });
      if (authorized) expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: true });
      else {
        core.retireAtomicPaneSnapshotCollector(nonce, "retired");
        expect(settled.mock.calls[0]?.[0]).toMatchObject({ ok: false });
      }
      expect(core.pendingCount).toBe(0);
    }
  });

  it("consumes marker rejection and both cleanup branch plans without shifting later replies", () => {
    const settled = vi.fn();
    const core = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    core.armAtomicPaneSnapshotCollector({
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 2,
      onSettled: settled,
    });
    core.feed(
      [...guardedSnapshot(["snapshot"], "0 0 80 24", { markerRejected: true }), ""].join("\n"),
    );
    expect(settled.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      failureReason: "marker-rejected",
    });

    for (const owned of [true, false]) {
      const cleanupHook = vi.fn();
      const cleanupExpected = vi.fn();
      const cleanupOwner = vi.fn();
      const later = vi.fn();
      core.push({ kind: "discard" });
      core.push({ kind: "inline", onReply: cleanupHook, lines: [] });
      core.push({ kind: "discard" });
      core.push({ kind: "inline", onReply: cleanupExpected, lines: [] });
      core.push({ kind: "discard" });
      core.push({ kind: "inline", onReply: cleanupOwner, lines: [] });
      core.push({ kind: "inline", onReply: later, lines: [] });
      const first = owned ? [] : [`tmux-ide-atomic-cleanup-hook-skip-v1:${nonce}`];
      const second = owned ? [] : [`tmux-ide-atomic-cleanup-expected-skip-v1:${nonce}`];
      const third = owned ? [] : [`tmux-ide-atomic-cleanup-owner-skip-v1:${nonce}`];
      core.feed(
        [
          "%begin 1 201 1",
          "%end 1 201 1",
          "%begin 1 202 1",
          ...first,
          "%end 1 202 1",
          "%begin 1 203 1",
          "%end 1 203 1",
          "%begin 1 204 1",
          ...second,
          "%end 1 204 1",
          "%begin 1 205 1",
          "%end 1 205 1",
          "%begin 1 206 1",
          ...third,
          "%end 1 206 1",
          "%begin 1 207 1",
          "later-result",
          "%end 1 207 1",
          "",
        ].join("\n"),
      );
      expect(cleanupHook).toHaveBeenCalledWith({ ok: true, lines: first });
      expect(cleanupExpected).toHaveBeenCalledWith({ ok: true, lines: second });
      expect(cleanupOwner).toHaveBeenCalledWith({ ok: true, lines: third });
      expect(later).toHaveBeenCalledWith({ ok: true, lines: ["later-result"] });
      expect(core.pendingCount).toBe(0);
    }

    const coreWithError = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const later = vi.fn();
    coreWithError.push({ kind: "discard" });
    coreWithError.push({ kind: "inline", onReply: firstCleanup, lines: [] });
    coreWithError.push({ kind: "discard" });
    coreWithError.push({ kind: "inline", onReply: secondCleanup, lines: [] });
    coreWithError.push({ kind: "inline", onReply: later, lines: [] });
    coreWithError.feed(
      [
        "%begin 1 301 1",
        "%end 1 301 1",
        "%begin 1 302 1",
        "%error 1 302 1",
        "%begin 1 303 1",
        "%end 1 303 1",
        "%begin 1 304 1",
        "%end 1 304 1",
        "%begin 1 305 1",
        "later-result",
        "%end 1 305 1",
        "",
      ].join("\n"),
    );
    expect(firstCleanup).toHaveBeenCalledWith({ ok: false, lines: [] });
    expect(secondCleanup).toHaveBeenCalledWith({ ok: true, lines: [] });
    expect(later).toHaveBeenCalledWith({ ok: true, lines: ["later-result"] });
    expect(coreWithError.pendingCount).toBe(0);

    const coreWithLostTarget = new ControlChannelCore({
      onOutput: vi.fn(),
      onNotify: vi.fn(),
      onExit: vi.fn(),
    });
    const rejectedCleanup = vi.fn();
    const afterLoss = vi.fn();
    coreWithLostTarget.pushCommandList(2, 1, rejectedCleanup);
    coreWithLostTarget.push({ kind: "inline", onReply: afterLoss, lines: [] });
    coreWithLostTarget.feed(
      [
        "%begin 1 401 1",
        "can't find pane: %7",
        "%error 1 401 1",
        "%begin 1 402 1",
        "later-result",
        "%end 1 402 1",
        "",
      ].join("\n"),
    );
    expect(rejectedCleanup).toHaveBeenCalledWith({ ok: false, lines: ["can't find pane: %7"] });
    expect(afterLoss).toHaveBeenCalledWith({ ok: true, lines: ["later-result"] });
    expect(coreWithLostTarget.pendingCount).toBe(0);
  });
});

describe("bounded native capture replies", () => {
  const create = () => {
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.feed("%begin 1 0 0\n%end 1 0 0\n");
    return core;
  };
  it("keeps fragmented protocol terminators outside the payload budget", () => {
    const core = create();
    const result = vi.fn();
    core.pushBounded({ maxBytes: 4, maxLines: 1 }, result);
    core.feed("%begin 1 1 1\nabc\n%end 1");
    core.feed(" 1 1\n");
    expect(result).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["abc"] });
  });
  it("retains exact-budget replies and preserves the next command after overflow", () => {
    const core = create();
    const first = vi.fn();
    const second = vi.fn();
    core.pushBounded({ maxBytes: 4, maxLines: 1 }, first);
    core.pushBounded({ maxBytes: 4, maxLines: 1 }, second);
    core.feed("%begin 1 1 1\nabc\nextra\n%end 1 1 1\n%begin 1 2 1\nxyz\n%end 1 2 1\n");
    expect(first).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: [] });
    expect(second).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["xyz"] });
  });
  it("drains an oversized unterminated line across chunks without losing FIFO alignment", () => {
    const core = create();
    const first = vi.fn();
    const second = vi.fn();
    core.pushBounded({ maxBytes: 16, maxLines: 2 }, first);
    core.pushBounded({ maxBytes: 16, maxLines: 2 }, second);
    core.feed("%begin 1 1 1\n" + "x".repeat(17));
    for (let i = 0; i < 100; i++) core.feed("x".repeat(1024));
    expect(first).not.toHaveBeenCalled();
    core.feed("tail\n%end 1 1 1\n%begin 1 2 1\nokay\n%end 1 2 1\n");
    expect(first).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: [] });
    expect(second).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["okay"] });
  });
  it("bounds row bookkeeping separately and settles channel failure once", () => {
    const core = create();
    const result = vi.fn();
    core.pushBounded({ maxBytes: 1024, maxLines: 1 }, result);
    core.feed("%begin 1 1 1\na\nb\n%end 1 1 1\n");
    expect(result).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: [] });
    const exit = vi.fn();
    core.pushBounded({ maxBytes: 1024, maxLines: 1 }, exit);
    core.fail("closed");
    core.fail("closed again");
    expect(exit).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: ["closed"] });
    expect(core.pushBounded({ maxBytes: Infinity, maxLines: 1 }, vi.fn())).toBe(false);
  });
});

describe("bounded marked capture command lists", () => {
  const setup = () => {
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.feed("%begin 1 0 0\n%end 1 0 0\n");
    return core;
  };
  it("discards successful prefix output and bounds the capture before the next reply", () => {
    const core = setup();
    const capture = vi.fn();
    const next = vi.fn();
    core.pushBoundedCommandList(2, 1, { maxBytes: 8, maxLines: 2 }, capture);
    core.pushBounded({ maxBytes: 8, maxLines: 2 }, next);
    core.feed("%begin 1 1 1\nprefix\n%end 1 1 1\n%begin 1 2 1\n" + "x".repeat(9));
    core.feed("more\n%end 1 2 1\n%begin 1 3 1\nnext\n%end 1 3 1\n");
    expect(capture).toHaveBeenCalledExactlyOnceWith({ ok: false, lines: [] });
    expect(next).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["next"] });
  });
  it("preserves a bounded parse error and removes the unexecuted capture slot", () => {
    const core = setup();
    const capture = vi.fn();
    const next = vi.fn();
    core.pushBoundedCommandList(2, 1, { maxBytes: 1024, maxLines: 2 }, capture);
    core.pushBounded({ maxBytes: 8, maxLines: 2 }, next);
    core.feed(
      "%begin 1 1 1\nparse error: command capture-pane: unknown flag -R\n%error 1 1 1\n%begin 1 2 1\nnext\n%end 1 2 1\n",
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      lines: ["parse error: command capture-pane: unknown flag -R"],
    });
    expect(next).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["next"] });
  });
});

describe("inline command-list parse diagnostics", () => {
  it.each([false, true])(
    "preserves only bounded first-slot errors and keeps FIFO aligned (oversized=%s)",
    (oversized) => {
      const core = new ControlChannelCore({
        onOutput: vi.fn(),
        onNotify: vi.fn(),
        onExit: vi.fn(),
      });
      core.feed("%begin 1 0 0\n%end 1 0 0\n");
      const capture = vi.fn(),
        next = vi.fn();
      core.pushCommandList(2, 1, capture);
      core.pushCommandList(1, 0, next);
      const error = oversized
        ? "x".repeat(4097)
        : "parse error: command capture-pane: unknown flag -R";
      core.feed(`%begin 1 1 1\n${error}\n%error 1 1 1\n%begin 1 2 1\nnext\n%end 1 2 1\n`);
      expect(capture).toHaveBeenCalledExactlyOnceWith({
        ok: false,
        lines: oversized ? [] : [error],
      });
      expect(next).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["next"] });
    },
  );
  it("discards successful prefix diagnostics before returning selected output", () => {
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
    core.feed("%begin 1 0 0\n%end 1 0 0\n");
    const capture = vi.fn();
    core.pushCommandList(2, 1, capture);
    core.feed("%begin 1 1 1\nprefix\n%end 1 1 1\n%begin 1 2 1\nselected\n%end 1 2 1\n");
    expect(capture).toHaveBeenCalledExactlyOnceWith({ ok: true, lines: ["selected"] });
  });
});

describe("owned pause hook on the shared collector", () => {
  const nonce = "abcdef0123456789abcdef0123456789";
  const block = (ordinal: number, lines: string[], flags = 0) => [
    `%begin 1 ${100 + ordinal} ${flags}`,
    ...lines,
    `%end 1 ${100 + ordinal} ${flags}`,
  ];
  const hook = (pause: string[], completeNonce = nonce, flags = 0) =>
    [
      ...block(0, [`%tmux-ide-atomic-v1 ${nonce} start`]),
      ...block(1, pause, flags),
      ...block(2, [`%tmux-ide-atomic-v1 ${completeNonce} complete`]),
      "",
    ].join("\n");
  const fixture = () => {
    const onNotify = vi.fn(),
      onSettled = vi.fn(),
      onDrained = vi.fn();
    const core = new ControlChannelCore({ onOutput: vi.fn(), onNotify, onExit: vi.fn() });
    const spec = {
      kind: "pause" as const,
      nonce,
      runtimePaneId: "%7",
      maxCaptureBytes: 4096,
      maxCaptureLines: 16,
      maxCursorBytes: 256,
      observerCommandCount: 0,
      onSettled,
      onDrained,
    };
    expect(core.armAtomicPaneSnapshotCollector(spec)).toBe(true);
    return { core, spec, onNotify, onSettled, onDrained };
  };
  it.each([true, false])("authenticates a pause hook with pauseObserved=%s", (observed) => {
    const f = fixture();
    f.core.feed(hook(observed ? ["%pause %7"] : []));
    expect(f.onSettled).toHaveBeenCalledOnce();
    expect(f.onSettled.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      pauseObserved: observed,
      captureLines: [],
      cursorLine: null,
    });
    expect(f.onDrained).toHaveBeenCalledExactlyOnceWith("complete");
    expect(f.onNotify).not.toHaveBeenCalled();
    expect(f.core.armAtomicPaneSnapshotCollector({ ...f.spec, kind: "snapshot" })).toBe(true);
  });
  it.each([
    { name: "wrong pane", pause: ["%pause %8"] },
    { name: "duplicate pause", pause: ["%pause %7", "%pause %7"] },
    { name: "foreign completion", pause: ["%pause %7"], complete: "f".repeat(32) },
    { name: "ordinary reply flags", pause: ["%pause %7"], flags: 1 },
    { name: "unexpected command content", pause: ["not-a-pause"] },
  ])("rejects $name without releasing admission", ({ pause, complete, flags }) => {
    const f = fixture();
    f.core.feed(hook(pause, complete, flags));
    expect(f.onSettled).toHaveBeenCalledOnce();
    expect(f.onSettled.mock.calls[0]?.[0].ok).toBe(false);
    expect(f.onDrained).not.toHaveBeenCalled();
    expect(f.core.armAtomicPaneSnapshotCollector({ ...f.spec, nonce: "e".repeat(32) })).toBe(false);
    expect(f.onNotify).not.toHaveBeenCalled();
  });
  it("retains cancelled pause-hook wire until the ordinary retirement fence", () => {
    const f = fixture();
    f.core.feed(block(0, [`%tmux-ide-atomic-v1 ${nonce} start`]).join("\n") + "\n");
    f.core.retireAtomicPaneSnapshotCollector(nonce);
    f.core.feed(
      [...block(1, ["%pause %7"]), ...block(2, [`%tmux-ide-atomic-v1 ${nonce} complete`]), ""].join(
        "\n",
      ),
    );
    expect(f.onSettled).toHaveBeenCalledOnce();
    expect(f.onSettled.mock.calls[0]?.[0].ok).toBe(false);
    expect(f.onDrained).not.toHaveBeenCalled();
    expect(f.core.armAtomicPaneSnapshotCollector({ ...f.spec, nonce: "e".repeat(32) })).toBe(false);
    const fence = vi.fn();
    f.core.push({
      kind: "inline",
      lines: [],
      onReply: (reply) => {
        fence(reply);
        if (reply.ok && reply.lines.join() === "fence") f.core.releaseRetiredCollector(nonce);
      },
    });
    f.core.feed("%begin 1 999 1\nfence\n%end 1 999 1\n");
    expect(fence).toHaveBeenCalledWith({ ok: true, lines: ["fence"] });
    expect(f.onDrained).toHaveBeenCalledExactlyOnceWith("fence");
    expect(f.onNotify).not.toHaveBeenCalled();
  });
});
