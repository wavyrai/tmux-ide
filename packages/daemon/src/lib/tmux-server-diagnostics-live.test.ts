import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";
import { shellEscape } from "./shell.ts";

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "reports selected server, not wrapper -V, and refuses replacement and retirement",
  async () => {
    const root = mkdtempSync("/tmp/tmux-version-owner-");
    const socket = join(root, "s");
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const run = (args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    const wrapper = join(root, "tmux");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "-V" ]; then echo 'tmux 99.9'; exit 0; fi\nexec ${shellEscape(executable)} "$@"\n`,
      { mode: 0o700 },
    );
    let owner: NativeTmuxServerOwner | undefined;
    try {
      run(["new-session", "-d", "-s", "owned", "exec sleep 60"]);
      const expected = run(["display-message", "-p", "#{version}"]);
      owner = await createNativeTmuxServerOwner({
        environmentId: randomUUID(),
        serverId: `tmux-server.${"a".repeat(32)}`,
        generation: randomUUID(),
        tmuxAuthority: { executablePath: wrapper, socketSelector: { kind: "path", path: socket } },
        stateDirectory: join(root, "state"),
        webSocketUrl: "ws://127.0.0.1:1/v2/terminal/pane-streams/redeem",
      });
      expect(await owner.readServerVersion()).toBe(expected);
      expect(expected).not.toBe("99.9");
      const abort = new AbortController();
      abort.abort();
      await expect(owner.readServerVersion(abort.signal)).rejects.toThrow();
      run(["kill-server"]);
      run(["new-session", "-d", "-s", "replacement", "exec sleep 60"]);
      await expect(owner.readServerVersion()).rejects.toThrow();
      await owner.dispose();
      await expect(owner.readServerVersion()).rejects.toThrow();
    } finally {
      await owner?.dispose();
      spawnSync(executable, ["-S", socket, "kill-server"], {
        env: { ...process.env, TMUX: "" },
        stdio: "ignore",
      });
      expect(
        spawnSync(executable, ["-S", socket, "list-sessions"], {
          env: { ...process.env, TMUX: "" },
          stdio: "ignore",
        }).status,
      ).not.toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
