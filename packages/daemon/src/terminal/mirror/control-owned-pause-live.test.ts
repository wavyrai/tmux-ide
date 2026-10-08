import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary).each([false, true])(
  "authenticates a real owned pause hook (already paused: %s)",
  async (alreadyPaused) => {
    expect(isAbsolute(binary!)).toBe(true);
    const socket = `zz-owned-pause-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    let channel: MirrorControlChannel | undefined;
    try {
      const pane = run(
        "new-session",
        "-d",
        "-s",
        "pause",
        "-P",
        "-F",
        "#{pane_id}",
        "stty -echo; printf BEFORE; read line; printf '\\rAFTER!'; sleep 60",
      );
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("BEFORE"));
      const onOutput = vi.fn(),
        onNotify = vi.fn(),
        onSettled = vi.fn(),
        onDrained = vi.fn();
      channel = new MirrorControlChannel({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        session: "pause",
        handlers: { onOutput, onNotify, onExit: vi.fn() },
      });
      await channel.start();
      if (alreadyPaused) await channel.request(`refresh-client -A '${pane}:pause'`);
      const nonce = randomBytes(16).toString("hex");
      const hook = `@owned_pause_${nonce}`;
      run(
        "set-option",
        "-p",
        "-t",
        pane,
        hook,
        `display-message -p -l "%tmux-ide-atomic-v1 ${nonce} start" ; refresh-client -A '${pane}:pause' ; display-message -p -l "%tmux-ide-atomic-v1 ${nonce} complete"`,
      );
      expect(
        channel.armAtomicPaneSnapshotCollector(
          {
            kind: "pause",
            nonce,
            runtimePaneId: pane,
            maxCaptureBytes: 4096,
            maxCaptureLines: 16,
            maxCursorBytes: 256,
            observerCommandCount: 0,
            onSettled,
            onDrained,
          },
          5000,
        ),
      ).toBe(true);
      // Resolving this pane target and running its nonwaiting NOHOOKS body is
      // essential: refresh-client alone silently succeeds for nonexistent IDs.
      channel.commandInline(`set-hook -Rp -t ${pane} ${hook}`, () => {});
      await vi.waitFor(() => expect(onDrained).toHaveBeenCalledExactlyOnceWith("complete"));
      expect(onSettled).toHaveBeenCalledOnce();
      expect(onSettled.mock.calls[0]?.[0]).toMatchObject({
        ok: true,
        pauseObserved: !alreadyPaused,
      });
      onOutput.mockClear();
      run("send-keys", "-t", pane, "-l", "go");
      run("send-keys", "-t", pane, "Enter");
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("AFTER!"));
      // The ordinary reply is a wire fence after the native AFTER! checkpoint.
      // Both fresh and already-paused hooks leave target delivery parked.
      expect(await channel.request("display-message -p -l paused-proof")).toEqual(["paused-proof"]);
      expect(onOutput).not.toHaveBeenCalled();
      expect(onNotify.mock.calls.filter(([name]) => name === "pause")).toEqual([]);
    } finally {
      try {
        await channel?.dispose();
      } finally {
        spawnSync(binary!, ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
        expect(
          spawnSync(binary!, ["-L", socket, "has-session"], { stdio: "ignore", timeout: 5000 })
            .status,
        ).toBe(1);
      }
    }
  },
  15000,
);
