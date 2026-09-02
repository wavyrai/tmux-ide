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
    expect(rejectedCleanup).toHaveBeenCalledWith({ ok: false, lines: [] });
    expect(afterLoss).toHaveBeenCalledWith({ ok: true, lines: ["later-result"] });
    expect(coreWithLostTarget.pendingCount).toBe(0);
  });
});
