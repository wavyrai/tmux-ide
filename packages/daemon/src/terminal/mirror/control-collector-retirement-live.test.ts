import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;

it.skipIf(!binary)(
  "drains a cancelled real hook before admitting a new snapshot collector",
  async () => {
    expect(isAbsolute(binary!)).toBe(true);
    const socket = `zz-collector-retire-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    let channel: MirrorControlChannel | undefined;
    let reader: ChildProcess["stdout"] = null;
    try {
      const pane = run(
        "new-session",
        "-d",
        "-s",
        "retirement",
        "-x",
        "80",
        "-y",
        "24",
        "-P",
        "-F",
        "#{pane_id}",
        "printf READY; sleep 60",
      );
      await vi.waitFor(() => expect(run("capture-pane", "-p", "-t", pane)).toBe("READY"));
      channel = new MirrorControlChannel({
        executable: binary!,
        socketName: socket,
        configFile: "/dev/null",
        session: "retirement",
        handlers: { onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() },
      });
      await channel.start();
      const prepare = (nonce: string) => {
        const hook = `@retirement_${nonce}`;
        const sentinel = (name: string) =>
          `display-message -p -l "%tmux-ide-atomic-v1 ${nonce} ${name}"`;
        // This is the real NOHOOKS protocol, with no interaction observer.
        // The execution marker replaces its silent cleanup command so another
        // client can prove execution while the tested reader is stalled.
        const body = [
          sentinel("start"),
          `capture-pane -p -t ${pane}`,
          sentinel("capture-end"),
          `display-message -p -t ${pane} "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"`,
          sentinel("cursor-end"),
          `refresh-client -A '${pane}:continue'`,
          `if-shell -F 1 "set-option -gu @retirement_unused"`,
          sentinel("status-ok"),
          `set-option -g @retirement_executed ${nonce}`,
          sentinel("complete"),
        ].join(" ; ");
        run("set-option", "-p", "-t", pane, hook, body);
        return `set-hook -Rp -t ${pane} ${hook}`;
      };
      const nonce = randomBytes(16).toString("hex");
      const nextNonce = randomBytes(16).toString("hex");
      const firstHook = prepare(nonce);
      const secondHook = prepare(nextNonce);
      await channel.request(`refresh-client -A '${pane}:pause'`);
      const first = vi.fn();
      const drained = vi.fn();
      const second = vi.fn();
      const spec = {
        nonce,
        runtimePaneId: pane,
        maxCaptureBytes: 4096,
        maxCaptureLines: 128,
        maxCursorBytes: 256,
        observerCommandCount: 0,
        onSettled: first,
        onDrained: drained,
      };
      expect(channel.armAtomicPaneSnapshotCollector(spec, 5000)).toBe(true);
      reader = (channel as unknown as { proc: ChildProcess }).proc.stdout;
      expect(reader).not.toBeNull();
      reader!.pause();
      channel.commandInline(firstHook, () => {});
      await vi.waitFor(() =>
        expect(run("show-options", "-gqv", "@retirement_executed")).toBe(nonce),
      );
      channel.retireAtomicPaneSnapshotCollector(nonce);
      expect(first).toHaveBeenCalledOnce();
      expect(first.mock.calls[0]?.[0]).toMatchObject({ ok: false, failureReason: "retired" });
      expect(
        channel.armAtomicPaneSnapshotCollector(
          { ...spec, nonce: nextNonce, onSettled: second },
          5000,
        ),
      ).toBe(false);
      reader!.resume();
      await vi.waitFor(() => expect(drained).toHaveBeenCalledExactlyOnceWith("fence"));
      expect(first).toHaveBeenCalledOnce();
      await channel.request(`refresh-client -A '${pane}:pause'`);
      expect(
        channel.armAtomicPaneSnapshotCollector(
          { ...spec, nonce: nextNonce, onSettled: second },
          5000,
        ),
      ).toBe(true);
      channel.commandInline(secondHook, () => {});
      await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
      expect(second.mock.calls[0]?.[0]).toMatchObject({ ok: true });
      expect(second.mock.calls[0]?.[0].captureLines.join("\n").trimEnd()).toBe("READY");
      expect(drained.mock.calls.map(([reason]) => reason)).toEqual(["fence", "complete"]);
      expect(await channel.request("display-message -p -l still-aligned")).toEqual([
        "still-aligned",
      ]);
    } finally {
      reader?.resume();
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
  20000,
);
