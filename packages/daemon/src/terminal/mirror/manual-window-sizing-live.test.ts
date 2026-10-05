import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!available)("managed viewport recovery from manual sizing", () => {
  it.each(["window", "session"])(
    "repairs a %s pin through the retained control client",
    async (scope) => {
      const socket = `tmux-ide-manual-${process.pid}-${randomUUID().slice(0, 8)}`;
      const run = (...args: string[]) =>
        execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          env: { ...process.env, TMUX: "" },
        }).trim();
      const service = new MirrorService({
        createIo: (session, handlers) =>
          new MirrorControlChannel({
            session,
            handlers,
            socketName: socket,
            configFile: "/dev/null",
          }),
      });
      try {
        run("new-session", "-d", "-s", "proof", "-x", "100", "-y", "30", "cat");
        run("set-option", "-t", "proof", "status", "off");
        const window = run("display-message", "-p", "-t", "proof", "#{window_id}");
        const neighbour = run("new-window", "-d", "-t", "proof", "-P", "-F", "#{window_id}", "cat");
        run("set-option", "-w", "-t", neighbour, "window-size", "manual");
        run(
          "set-option",
          ...(scope === "window" ? ["-w"] : []),
          "-t",
          "proof",
          "window-size",
          "manual",
        );
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
        expect(run("show-option", "-w", "-v", "-t", neighbour, "window-size")).toBe("manual");
        // Re-pinning an already open window must also recover on the next fit.
        run("resize-window", "-t", window, "-x", "90", "-y", "25");
        service.fitViewport("proof", 130, 42);
        await vi.waitFor(() =>
          expect(
            run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
          ).toBe("130x42"),
        );
        // Existing arbitration choices are not rewritten by an ordinary fit.
        run("set-option", "-w", "-t", window, "window-size", "smallest");
        service.fitViewport("proof", 110, 32);
        await vi.waitFor(() =>
          expect(
            run("display-message", "-p", "-t", window, "#{window_width}x#{window_height}"),
          ).toBe("110x32"),
        );
        expect(run("show-option", "-w", "-v", "-t", window, "window-size")).toBe("smallest");
        expect(run("display-message", "-p", "-t", "proof", "#{pid}:#{pane_pid}")).toBe(identity);
      } finally {
        await service.dispose();
        spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      }
    },
    15000,
  );
});
