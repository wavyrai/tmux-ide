import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { shellEscape } from "./shell.ts";
import {
  prepareTmuxTruecolorEnvironment,
  TMUX_TRUECOLOR_INTERACTIVE_SHELL_COMMAND,
  truecolorShellCommand,
} from "./tmux-terminal-color.ts";
import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const sockets: string[] = [];
const roots: string[] = [];

function tmuxExecutable(): string {
  return realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
}

function captureWhenReady(
  run: (args: readonly string[]) => string,
  target: string,
): Promise<string> {
  let frame = "";
  return vi
    .waitFor(
      () => {
        frame = run(["capture-pane", "-p", "-e", "-t", target]);
        expect(frame).toContain("RGB");
      },
      { timeout: 5_000, interval: 25 },
    )
    .then(() => frame);
}

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    spawnSync(tmuxExecutable(), ["-L", socket, "kill-server"], { stdio: "ignore" });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe
  .skipIf(!hasTmux)
  .sequential("tmux terminal color authority against isolated servers", () => {
    vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

    it("does not poison a cold-started tmux server from a headless parent", async () => {
      const socket = `tmux-ide-color-cold-${process.pid}-${Date.now()}`;
      sockets.push(socket);
      const previous = {
        NO_COLOR: process.env.NO_COLOR,
        COLORTERM: process.env.COLORTERM,
        TERM: process.env.TERM,
      };
      process.env.NO_COLOR = "1";
      delete process.env.COLORTERM;
      process.env.TERM = "dumb";
      const run = createPinnedWorkspaceTmuxRunner({
        executablePath: tmuxExecutable(),
        socketSelector: { kind: "name", name: socket },
      });
      if (previous.NO_COLOR === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous.NO_COLOR;
      if (previous.COLORTERM === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = previous.COLORTERM;
      if (previous.TERM === undefined) delete process.env.TERM;
      else process.env.TERM = previous.TERM;

      const script =
        'printf \'ENV:%s:%s:%s\\n\' "${NO_COLOR-unset}" "${COLORTERM-unset}" "$TERM"; ' +
        "printf '\\033[38;2;1;2;3mRGB\\033[0m\\n'; sleep 30";
      run([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "cold",
        truecolorShellCommand(`/bin/sh -c ${shellEscape(script)}`),
      ]);

      expect(() => run(["show-environment", "-g", "NO_COLOR"])).toThrow();
      expect(run(["show-environment", "-g", "COLORTERM"])).toBe("COLORTERM=truecolor");
      const frame = await captureWhenReady(run, "=cold:");
      expect(frame).toMatch(/ENV:unset:truecolor:(?:screen|tmux)-256color/u);
      expect(frame).toContain("\u001b[38;2;1;2;3mRGB");
    });

    it("overrides a dirty global for the first shell and every later child", async () => {
      const socket = `tmux-ide-color-dirty-${process.pid}-${Date.now()}`;
      sockets.push(socket);
      const root = mkdtempSync(join(tmpdir(), "tmux-ide-color-dirty-"));
      roots.push(root);
      const probeShell = join(root, "probe-shell");
      writeFileSync(
        probeShell,
        "#!/bin/sh\n" +
          'if [ "${1-unset}" = "-c" ]; then exec /bin/sh "$@"; fi\n' +
          'printf \'ENV:%s:%s:%s\\n\' "${NO_COLOR-unset}" "${COLORTERM-unset}" "$TERM"\n' +
          "printf '\\033[38;2;1;2;3mRGB\\033[0m\\n'\n" +
          "sleep 30\n",
      );
      chmodSync(probeShell, 0o755);
      const raw = (args: readonly string[]): string =>
        execFileSync(tmuxExecutable(), ["-L", socket, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).replace(/(?:\r?\n)+$/u, "");

      raw(["-f", "/dev/null", "new-session", "-d", "-s", "keeper", "sleep 30"]);
      raw(["set-environment", "-g", "NO_COLOR", "1"]);
      raw(["set-environment", "-g", "COLORTERM", "disabled"]);
      raw(["set-option", "-g", "default-shell", probeShell]);
      raw(["new-session", "-d", "-s", "first", TMUX_TRUECOLOR_INTERACTIVE_SHELL_COMMAND]);

      const firstFrame = await captureWhenReady(raw, "=first:");
      expect(firstFrame).toMatch(/ENV:unset:truecolor:(?:screen|tmux)-256color/u);
      expect(firstFrame).toContain("\u001b[38;2;1;2;3mRGB");

      prepareTmuxTruecolorEnvironment(raw, "first");
      expect(raw(["show-environment", "-t", "=first", "NO_COLOR"])).toBe("-NO_COLOR");
      expect(raw(["show-environment", "-t", "=first", "COLORTERM"])).toBe("COLORTERM=truecolor");

      const childPane = raw([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "=first:",
        probeShell,
      ]);
      const childFrame = await captureWhenReady(raw, childPane);
      expect(childFrame).toMatch(/ENV:unset:truecolor:(?:screen|tmux)-256color/u);
      expect(childFrame).toContain("\u001b[38;2;1;2;3mRGB");
    });
  });
