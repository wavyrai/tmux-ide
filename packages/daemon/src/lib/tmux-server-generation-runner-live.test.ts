import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createServerGenerationFencedTmuxRunner,
  createServerGenerationFencedTmuxAsyncRunner,
} from "./tmux-server-generation-runner.ts";
import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";
import { WorkspaceTerminalInventoryRuntime } from "../terminal/attachments/native-runtime.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { MirrorControlChannel } from "../terminal/mirror/control-channel.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";
import { shellEscape } from "./shell.ts";

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "guards native commands after validation/before connect and preserves argv",
  async () => {
    const root = mkdtempSync("/tmp/tmux-generation-");
    const socket = join(root, "s"),
      marker = join(root, "swap"),
      wrapper = join(root, "tmux-wrapper");
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const native = (args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trimEnd();
    try {
      native(["new-session", "-d", "-s", "shared", "sleep 300"]);
      writeFileSync(
        wrapper,
        `#!/bin/sh\nif [ -f ${shellEscape(marker)} ]; then\nrm ${shellEscape(marker)}\n${shellEscape(executable)} -S ${shellEscape(socket)} kill-server\n${shellEscape(executable)} -S ${shellEscape(socket)} -f /dev/null new-session -d -s shared -n replacement 'sleep 300'\nfi\nexec ${shellEscape(executable)} "$@"\n`,
        { mode: 0o700 },
      );
      const authority = {
        executablePath: wrapper,
        socketSelector: { kind: "path" as const, path: socket },
      };
      let run = createServerGenerationFencedTmuxRunner(authority);
      expect(run(["-N", "-u", "display-message", "-p", "global-flags-ok"])).toBe("global-flags-ok");
      expect(() => run(["-S", socket, "display-message", "-p", "bad"])).toThrow(
        "Unsupported tmux global option",
      );
      const initialIdentity = native(["display-message", "-p", "#{pid}\t#{start_time}"]).split(
        "\t",
      );
      const flaggedAsync = createServerGenerationFencedTmuxAsyncRunner(authority, {
        pid: initialIdentity[0]!,
        startTime: initialIdentity[1]!,
      });
      expect(await flaggedAsync(["-N", "-u", "display-message", "-p", "async-flags-ok"])).toBe(
        "async-flags-ok",
      );

      const value = "dollar $HOME ; slash \\ quote ' double \" unicode é\nsecond line";
      run(["set-option", "-t", "shared", "@guard-test", value]);
      expect(native(["show-options", "-qv", "-t", "shared", "@guard-test"])).toBe(value);
      expect(run(["display-message", "-p", "first", ";", "display-message", "-p", "second"])).toBe(
        "first\nsecond",
      );
      expect(() => run(["rename-window", "-t", "missing:99", "bad"])).toThrow();
      // Baseline proof of the gap: a pinned inode check alone accepts replacement.
      const unguarded = createPinnedWorkspaceTmuxRunner(authority);
      writeFileSync(marker, "");
      unguarded(["rename-window", "-t", "shared:0", "WRONG"]);
      expect(native(["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe("WRONG");
      run = createServerGenerationFencedTmuxRunner(authority);
      writeFileSync(marker, "");
      expect(() => run(["rename-window", "-t", "shared:0", "WRONG_AGAIN"])).toThrow(
        "generation changed",
      );
      expect(native(["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe(
        "replacement",
      );
      const [pid, startTime] = native(["display-message", "-p", "#{pid}\t#{start_time}"]).split(
        "\t",
      );
      const socketIdentity = captureUnixSocketIdentity(socket);
      const output: Uint8Array[] = [];
      const channelOptions = {
        session: "shared",
        executable: wrapper,
        socketPath: socket,
        nativeServerIdentity: { pid: pid!, startTime: startTime! },
        resolveSocketPath: () => revalidateUnixSocketIdentity(socketIdentity),
        handlers: {
          onOutput: (_pane: string, data: Uint8Array) => output.push(data),
          onNotify: () => undefined,
          onExit: () => undefined,
        },
      };
      const healthy = new MirrorControlChannel(channelOptions);
      try {
        await healthy.start();
        expect(await healthy.request("display-message -p 'correct-fifo'")).toEqual([
          "correct-fifo",
        ]);
      } finally {
        await healthy.dispose();
      }
      output.length = 0;
      const stale = new MirrorControlChannel(channelOptions);
      writeFileSync(marker, "");
      try {
        await expect(stale.start()).rejects.toThrow();
      } finally {
        await stale.dispose();
      }
      expect(output).toHaveLength(0);
      expect(native(["list-clients", "-F", "#{client_control_mode}"])).toBe("");
      const captureIdentity = () => {
        const [pid, startTime] = native(["display-message", "-p", "#{pid}\t#{start_time}"]).split(
          "\t",
        );
        return { pid: pid!, startTime: startTime! };
      };
      const asyncRun = createServerGenerationFencedTmuxAsyncRunner(authority, captureIdentity());
      writeFileSync(marker, "");
      await expect(asyncRun(["set-option", "-g", "@maintenance", "BAD"])).rejects.toThrow(
        "generation changed",
      );
      expect(native(["show-options", "-gqv", "@maintenance"])).toBe("");
      for (const asynchronous of [false, true]) {
        const inventory = new WorkspaceTerminalInventoryRuntime({
          registry: new WorkspaceRegistry({ dir: root }),
          tmuxAuthority: {
            ...authority,
            trustedCwd: root,
            nativeServerIdentity: captureIdentity(),
          },
        });
        try {
          await inventory.whenReady();
          writeFileSync(marker, "");
          const command = {
            executable: "tmux" as const,
            argv: ["set-option", "-g", "@maintenance", "BAD"],
          };
          const result = asynchronous
            ? await inventory.readRunner.run(command)
            : inventory.runner.run(command);
          expect(result.status).toBe("failed");
          expect(native(["show-options", "-gqv", "@maintenance"])).toBe("");
        } finally {
          inventory.dispose();
        }
      }
    } finally {
      spawnSync(executable, ["-S", socket, "kill-server"], {
        stdio: "ignore",
        env: { ...process.env, TMUX: "" },
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
