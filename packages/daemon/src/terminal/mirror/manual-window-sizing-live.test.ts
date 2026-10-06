import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!available)("managed viewport recovery from manual sizing", () => {
  it.each(["window", "inherited"])(
    "repairs a %s pin through the retained control client",
    async (scope) => {
      const socket = `tmux-ide-manual-${process.pid}-${randomUUID().slice(0, 8)}`;
      const run = (...args: string[]) =>
        execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          env: { ...process.env, TMUX: "" },
        }).trim();
      let control!: MirrorControlChannel;
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
        const window = run("display-message", "-p", "-t", "proof", "#{window_id}");
        const neighbour = run("new-window", "-d", "-t", "proof", "-P", "-F", "#{window_id}", "cat");
        run("set-option", "-w", "-t", neighbour, "window-size", "manual");
        if (scope === "inherited") {
          run("set-option", "-gw", "window-size", "manual");
          run("set-option", "-wu", "-t", window, "window-size");
        } else run("set-option", "-w", "-t", window, "window-size", "manual");
        run("resize-window", "-t", neighbour, "-x", "90", "-y", "25");
        const identity = run("display-message", "-p", "-t", "proof", "#{pid}:#{pane_pid}");
        await service.retainSession("proof");
        service.setGeometryParticipation("proof", true);
        service.fitViewport("proof", 120, 40);
        await vi.waitFor(
          () =>
            expect(
              run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
            ).toBe("120x40"),
          { timeout: 1500 },
        );
        expect(run("show-option", "-w", "-v", "-t", window, "window-size")).toBe("latest");
        expect(await control.request('display-message -p "after-manual-repair"')).toEqual([
          "after-manual-repair",
        ]);
        expect(run("show-option", "-w", "-v", "-t", neighbour, "window-size")).toBe("manual");
        // The installed shell pre-fits hidden windows too. Those requests must
        // not release a user's manual pin on a background window.
        const hidden = run("show-option", "-wv", "-t", neighbour, "@tmux_ide_window_id");
        expect(hidden).toMatch(/^window\./);
        service.fitWindowViewport("proof", hidden, 120, 40);
        // A later resize on the same retained connection fences the hidden fit.
        service.fitViewport("proof", 121, 41);
        await vi.waitFor(() =>
          expect(
            run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
          ).toBe("121x41"),
        );
        expect(run("show-option", "-Awv", "-t", neighbour, "window-size")).toBe("manual");
        expect(await control.request('display-message -p "after-hidden-fit"')).toEqual([
          "after-hidden-fit",
        ]);
        expect(
          run("display-message", "-p", "-t", neighbour, "#{window_width}x#{window_height}"),
        ).toBe("90x25");
        // Re-pinning an already open window must also recover on the next fit.
        run("resize-window", "-t", window, "-x", "90", "-y", "25");
        service.fitViewport("proof", 130, 42);
        await vi.waitFor(() =>
          expect(
            run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
          ).toBe("130x42"),
        );
        // Existing arbitration choices are not rewritten by an ordinary fit.
        expect(await control.request('display-message -p "after-repin"')).toEqual(["after-repin"]);
        run("set-option", "-w", "-t", window, "window-size", "smallest");
        service.fitViewport("proof", 110, 32);
        await vi.waitFor(() =>
          expect(
            run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
          ).toBe("110x32"),
        );
        expect(run("show-option", "-w", "-v", "-t", window, "window-size")).toBe("smallest");
        expect(await control.request('display-message -p "after-smallest-fit"')).toEqual([
          "after-smallest-fit",
        ]);
        expect(run("display-message", "-p", "-t", "proof", "#{pid}:#{pane_pid}")).toBe(identity);
      } finally {
        await service.dispose();
        spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      }
    },
    15000,
  );
});
