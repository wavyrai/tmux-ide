import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
describe.skipIf(!available)("background geometry release", () => {
  it("preserves the last grid with no other sizing client", async () => {
    const socket = `tmux-ide-background-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (...args: string[]) =>
      execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    let control!: MirrorControlChannel;
    let peer: ReturnType<typeof spawn> | undefined;
    const service = new MirrorService({
      createIo: (session, handlers) =>
        (control = new MirrorControlChannel({
          session,
          handlers,
          socketName: socket,
          configFile: "/dev/null",
        })),
    });
    try {
      run("new-session", "-d", "-s", "proof", "-x", "100", "-y", "30", "cat");
      run("set-option", "-t", "proof", "status", "off");
      const identity = run("display-message", "-p", "-t", "proof", "#{pid}:#{pane_pid}");
      await service.retainSession("proof");
      const window = run("show-option", "-wv", "-t", "proof", "@tmux_ide_window_id");
      service.setGeometryParticipation("proof", true);
      service.fitWindowViewport("proof", window, 111, 47);
      const grid = () =>
        run("display-message", "-p", "-t", "proof", "#{window_width}x#{window_height}");
      await vi.waitFor(() => expect(grid()).toBe("111x47"));
      service.setGeometryParticipation("proof", false);
      await control.request('display-message -p "after-background"');
      expect(grid()).toBe("111x47");
      expect(run("list-clients", "-t", "proof", "-F", "#{client_flags}")).toContain("ignore-size");
      peer = spawn("tmux", ["-L", socket, "-C", "attach-session", "-t", "proof"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      peer.stdout!.resume();
      peer.stderr!.resume();
      peer.stdin!.write("refresh-client -C 95x31\n");
      await vi.waitFor(() => expect(grid()).toBe("95x31"));
      service.setGeometryParticipation("proof", false);
      await control.request('display-message -p "after-peer-handoff"');
      expect(grid()).toBe("95x31");
      peer.stdin!.end();
      await vi.waitFor(() =>
        expect(
          run("list-clients", "-t", "proof", "-F", "#{client_flags}").split("\n"),
        ).toHaveLength(1),
      );
      // Reacquisition alone keeps the window dimensions; a fresh fit changes them.
      const beforeResume = grid();
      service.setGeometryParticipation("proof", true);
      await control.request('display-message -p "after-resume"');
      expect(grid()).toBe(beforeResume);
      service.fitWindowViewport("proof", window, 123, 43);
      await vi.waitFor(() => expect(grid()).toBe("123x43"));
      service.setGeometryParticipation("proof", false);
      await control.request('display-message -p "after-second-background"');
      expect(grid()).toBe("123x43");
      expect(run("display-message", "-p", "-t", "proof", "#{pid}:#{pane_pid}")).toBe(identity);
    } finally {
      peer?.stdin?.end();
      await service.dispose();
      spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      peer?.kill();
    }
  }, 15000);
});
