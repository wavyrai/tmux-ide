import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createPinnedWorkspaceTmuxRunner,
  createPinnedWorkspaceTmuxAsyncRunner,
} from "./workspace-pane-creation.ts";
import { createTmuxAuthorityReplacementProbe } from "./tmux-authority-replacement.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux)("named tmux authority replacement", () => {
  it("recognizes a socket recreated by SIGUSR1 while preserving the original server", async () => {
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const name = `tmi-socket-${randomUUID()}`;
    const native = (args: string[]) =>
      execFileSync(executablePath, ["-L", name, ...args], {
        encoding: "utf8",
        env: { TERM: "xterm-256color" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    let socket: string | null = null;
    let movedSocket: string | null = null;
    try {
      native(["-f", "/dev/null", "new-session", "-d", "-s", "owned", "exec sleep 300"]);
      socket = native(["display-message", "-p", "#{socket_path}"]);
      const authority = { executablePath, socketSelector: { kind: "path" as const, path: socket } };
      const oldRun = createPinnedWorkspaceTmuxRunner(authority);
      const probe = createTmuxAuthorityReplacementProbe(authority, oldRun);
      const pid = Number(native(["display-message", "-p", "#{pid}"]));
      expect(await probe()).toBe(false);
      process.kill(pid, "SIGUSR1");
      await expect.poll(probe).toBe(true);
      expect(Number(native(["display-message", "-p", "#{pid}"]))).toBe(pid);
      expect(() => oldRun(["list-sessions"])).toThrow();
      const freshRun = createPinnedWorkspaceTmuxRunner({ ...authority });
      expect(Number(freshRun(["display-message", "-p", "#{pid}"]))).toBe(pid);
      const freshProbe = createTmuxAuthorityReplacementProbe({ ...authority }, freshRun);
      movedSocket = `${socket}.moved`;
      renameSync(socket, movedSocket);
      native(["-f", "/dev/null", "new-session", "-d", "-s", "owned", "exec sleep 300"]);
      expect(Number(native(["display-message", "-p", "#{pid}"]))).not.toBe(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await freshProbe()).toBe(false);
    } finally {
      spawnSync(executablePath, ["-L", name, "kill-server"], {
        stdio: "ignore",
        env: { TERM: "xterm-256color" },
      });
      if (socket) rmSync(socket, { force: true });
      if (movedSocket) {
        spawnSync(executablePath, ["-S", movedSocket, "kill-server"], {
          stdio: "ignore",
          env: { TERM: "xterm-256color" },
        });
        rmSync(movedSocket, { force: true });
      }
    }
  });

  it("observes a late first server without creating it, then recognizes its replacement", async () => {
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const name = `tmi-replacement-${randomUUID()}`;
    const authority = { executablePath, socketSelector: { kind: "name" as const, name } };
    const run = createPinnedWorkspaceTmuxRunner(authority);
    const observer = createPinnedWorkspaceTmuxAsyncRunner(authority);
    const native = (args: string[]) =>
      execFileSync(executablePath, ["-L", name, ...args], {
        encoding: "utf8",
        env: { TERM: "xterm-256color" },
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    const probe = createTmuxAuthorityReplacementProbe(authority, run);
    const dormantAuthority = { ...authority };
    const dormantRun = createPinnedWorkspaceTmuxRunner(dormantAuthority);
    const dormantProbe = createTmuxAuthorityReplacementProbe(dormantAuthority, dormantRun);
    let ownedSocket: string | null = null;
    try {
      expect(await probe()).toBe(false);
      expect(() => run(["-N", "list-sessions"])).toThrow();
      run(["-f", "/dev/null", "new-session", "-d", "-s", "owned", "exec sleep 300"]);
      ownedSocket = run(["display-message", "-p", "#{socket_path}"]);
      const firstPid = run(["display-message", "-p", "#{pid}"]);
      expect(await probe()).toBe(false);
      expect(await probe()).toBe(false);
      expect(await dormantProbe()).toBe(false);
      run(["kill-server"]);
      expect(await probe()).toBe(false);
      native(["-f", "/dev/null", "new-session", "-d", "-s", "owned", "exec sleep 300"]);
      expect(native(["display-message", "-p", "#{pid}"])).not.toBe(firstPid);
      await expect.poll(probe).toBe(true);
      expect(() => run(["set-option", "-t", "owned", "@stale", "true"])).toThrow();
      await expect(Promise.resolve().then(() => observer(["list-sessions"]))).rejects.toThrow();
      const lateOldRunner = createPinnedWorkspaceTmuxRunner(authority);
      expect(() => lateOldRunner(["set-option", "-t", "owned", "@stale", "true"])).toThrow();
      expect(native(["show-options", "-qv", "-t", "owned", "@stale"])).toBe("");
      expect(() => dormantRun(["set-option", "-t", "owned", "@stale", "true"])).toThrow();
      const nextAuthority = { ...authority };
      const nextRun = createPinnedWorkspaceTmuxRunner(nextAuthority);
      expect(nextRun(["display-message", "-p", "#{pid}"])).not.toBe(firstPid);
      const nextProbe = createTmuxAuthorityReplacementProbe(nextAuthority, nextRun);
      expect(await nextProbe()).toBe(false);
    } finally {
      spawnSync(executablePath, ["-L", name, "kill-server"], {
        stdio: "ignore",
        env: { TERM: "xterm-256color" },
      });
      if (ownedSocket) rmSync(ownedSocket, { force: true });
    }
  });
});
