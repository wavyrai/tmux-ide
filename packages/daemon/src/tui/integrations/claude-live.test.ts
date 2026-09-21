import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HOOK_SCRIPT_RELPATH, installClaudeIntegration } from "./claude.ts";
import {
  parseAgentStateFacts,
  AGENT_STATE_TMUX_ARGS,
} from "../../command-center/daemon-fleet-facts-observer.ts";
import { resolveAgentStatus } from "../detect/agent-resolution.ts";

let tmux: string | null = null;
try {
  tmux = execFileSync("which", ["tmux"], { encoding: "utf8", timeout: 2000 }).trim();
} catch {
  /* Explicitly skipped without tmux. */
}
it.skipIf(!tmux)(
  "executes quoted installed hooks on the exact private socket/pane and feeds authority status",
  () => {
    const root = mkdtempSync(join(tmpdir(), "h09-"));
    const sockets = [join(root, "a,sock"), join(root, "b.sock")];
    const env = { ...process.env, TMUX: "", TMUX_PANE: "" };
    const run = (socket: string, args: readonly string[]) =>
      execFileSync(tmux!, ["-S", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 3000,
      });
    const created: string[] = [];
    try {
      for (const socket of sockets) {
        run(socket, ["new-session", "-d", "-s", "h09", "sleep 120"]);
        created.push(socket);
      }
      const pane = run(sockets[0]!, ["display-message", "-p", "-t", "h09", "#{pane_id}"]).trim();
      const serverPid = run(sockets[0]!, ["display-message", "-p", "-t", "h09", "#{pid}"]).trim();
      const paths = {
        scriptPath: join(root, "spaces ' $literal", HOOK_SCRIPT_RELPATH),
        settingsPath: join(root, "settings.json"),
      };
      installClaudeIntegration(paths);
      const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
      const command = (event: string) => settings.hooks[event][0].hooks[0].command;
      const execute = (
        event: string,
        environment = { ...env, TMUX: `${sockets[0]},${serverPid},0`, TMUX_PANE: pane },
      ) =>
        execFileSync("/bin/sh", ["-c", command(event)], {
          env: environment,
          input: '{"session_id":"fixture-session_123"}',
          encoding: "utf8",
          timeout: 3000,
        });
      const state = () =>
        run(sockets[0]!, ["show-options", "-pv", "-t", pane, "@agent_state"]).trim();
      for (const [event, expected] of [
        ["UserPromptSubmit", "working"],
        ["Notification", "blocked"],
        ["Stop", "done"],
        ["SessionEnd", "idle"],
      ]) {
        expect(execute(event!)).toBe("");
        expect(state()).toMatch(new RegExp(`^${expected}:[0-9]+$`));
        const facts = parseAgentStateFacts(run(sockets[0]!, AGENT_STATE_TMUX_ARGS));
        expect(
          resolveAgentStatus({
            authorityRaw: facts.get("h09")!.get(pane)!.state,
            nowSec: Math.floor(Date.now() / 1000),
            scrape: () => "unknown",
          }),
        ).toMatchObject({ status: expected, source: "authority" });
      }
      expect(run(sockets[0]!, ["show-options", "-pv", "-t", pane, "@agent_hint"]).trim()).toBe(
        "claude",
      );
      expect(
        run(sockets[0]!, ["show-options", "-pv", "-t", pane, "@agent_session_id"]).trim(),
      ).toBe("fixture-session_123");
      const matcher = new RegExp(settings.hooks.Notification[0].matcher);
      const previous = state();
      for (const type of ["idle_prompt", "auth_success", "agent_completed"]) {
        if (matcher.test(type)) execute("Notification");
      }
      expect(state()).toBe(previous);
      for (const bad of [
        "",
        "/missing",
        `${sockets[0]},invalid,0`,
        `${sockets[0]},${Number(serverPid) + 1},0`,
      ])
        execute("Stop", { ...env, TMUX: bad, TMUX_PANE: pane });
      execute("Stop", { ...env, TMUX: `${sockets[0]},${serverPid},0`, TMUX_PANE: "h09" });
      expect(state()).toBe(previous);
      expect(run(sockets[1]!, ["show-options", "-p", "-t", "h09"])).not.toContain("@agent_");
    } finally {
      for (const socket of created) {
        try {
          run(socket, ["kill-server"]);
        } catch {
          /* Already stopped fixture. */
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
