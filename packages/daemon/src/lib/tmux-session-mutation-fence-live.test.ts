import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTmuxSessionMutationFence } from "./tmux-session-mutation-fence.ts";
import { createServerGenerationFencedTmuxRunner } from "./tmux-server-generation-runner.ts";
import { liveSessionIdForNativeIdentity } from "../terminal/protocol/live-session-identity.ts";

it.skipIf(spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0)(
  "uses exact selected session context and rejects replacement before mutation",
  async () => {
    const root = mkdtempSync("/tmp/tmux-session-fence-");
    const socket = join(root, "s");
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const native = (args: readonly string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, HOME: root, TMUX: "", TMUX_PANE: "" },
        cwd: root,
      }).trim();
    try {
      native(["new-session", "-d", "-s", "owned", "sleep 300"]);
      native(["new-session", "-d", "-s", "owned-other", "sleep 300"]);
      const [pid, id, created] = native([
        "list-sessions",
        "-F",
        "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}",
      ])
        .split("\n")
        .find((row) => row.endsWith("\towned"))!
        .split("\t");
      const liveSessionId = liveSessionIdForNativeIdentity(pid!, id!, created!);
      const fence = createTmuxSessionMutationFence();
      const run = fence.wrap(
        createServerGenerationFencedTmuxRunner({
          executablePath: executable,
          socketSelector: { kind: "path", path: socket },
        }),
      );
      const execute = (mutate: () => Promise<string>) =>
        fence.execute({
          liveSessionId,
          sessionName: "owned",
          run: async (args) => native(args),
          mutate,
        });
      await execute(async () => run(["set-option", "-t", "=owned:", "@fence-proof", "selected"]));
      expect(native(["show-options", "-qv", "-t", "=owned:", "@fence-proof"])).toBe("selected");
      expect(native(["show-options", "-qv", "-t", "=owned-other:", "@fence-proof"])).toBe("");
      await expect(
        execute(async () => {
          native(["kill-session", "-t", "=owned"]);
          native(["new-session", "-d", "-s", "owned", "sleep 300"]);
          return run(["set-option", "-t", "=owned:", "@fence-proof", "wrong"]);
        }),
      ).rejects.toThrow("Selected live tmux session changed before mutation");
      expect(native(["show-options", "-qv", "-t", "=owned:", "@fence-proof"])).toBe("");
    } finally {
      spawnSync(executable, ["-S", socket, "kill-server"], { stdio: "ignore" });
      expect(
        spawnSync(executable, ["-S", socket, "list-sessions"], { stdio: "ignore" }).status,
      ).not.toBe(0);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
