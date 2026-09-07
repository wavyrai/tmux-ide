import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import type { MirrorLayoutEvent } from "./events.ts";

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "shares effective per-window copy key modes and follows quiet inherited option changes",
  async () => {
    const root = mkdtempSync("/tmp/tmi-copy-modes-");
    const socketPath = join(root, "tmux.sock");
    const tmux = (...args: string[]) =>
      execFileSync("tmux", ["-S", socketPath, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
        timeout: 2_000,
      }).trimEnd();
    let channels = 0;
    const mirror = new MirrorService({
      createIo: (session, handlers) => {
        channels++;
        return new MirrorControlChannel({ session, handlers, socketPath, configFile: "/dev/null" });
      },
    });
    try {
      tmux("new-session", "-d", "-s", "copy-reference", "-n", "inherited", "sleep 600");
      tmux("set-option", "-gw", "mode-keys", "vi");
      tmux("new-window", "-d", "-t", "copy-reference", "-n", "overridden", "sleep 600");
      tmux("set-option", "-w", "-t", "copy-reference:overridden", "mode-keys", "emacs");
      const first = new Map<string, MirrorLayoutEvent>();
      const second = new Map<string, MirrorLayoutEvent>();
      const a = await mirror.subscribeLayout("copy-reference", (event) =>
        first.set(event.windowName!, event),
      );
      const b = await mirror.subscribeLayout("copy-reference", (event) =>
        second.set(event.windowName!, event),
      );
      const check = (inherited: string, overridden: string) => {
        for (const events of [first, second]) {
          expect(events.get("inherited")?.modeKeys).toBe(inherited);
          expect(events.get("overridden")?.modeKeys).toBe(overridden);
        }
      };
      check("vi", "emacs");
      tmux("set-option", "-gw", "mode-keys", "emacs");
      await vi.waitFor(() => check("emacs", "emacs"), { timeout: 5_000 });
      tmux("set-option", "-w", "-t", "copy-reference:overridden", "mode-keys", "vi");
      await vi.waitFor(() => check("emacs", "vi"), { timeout: 5_000 });
      tmux("set-option", "-wu", "-t", "copy-reference:overridden", "mode-keys");
      await vi.waitFor(() => check("emacs", "emacs"), { timeout: 5_000 });
      expect(channels).toBe(1);
      expect(
        tmux("list-clients", "-F", "#{client_control_mode}")
          .split("\n")
          .filter((value) => value === "1"),
      ).toHaveLength(1);
      await a.close();
      await b.close();
    } finally {
      await mirror.dispose();
      spawnSync("tmux", ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
