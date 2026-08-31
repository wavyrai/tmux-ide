import { describe, expect, it, vi } from "vitest";

import {
  prepareTmuxTruecolorEnvironment,
  TMUX_TRUECOLOR_ENVIRONMENT_ARGS,
  TMUX_TRUECOLOR_INTERACTIVE_SHELL_COMMAND,
  tmuxTruecolorEnvironmentCommands,
  truecolorShellCommand,
} from "./tmux-terminal-color.ts";

describe("tmux terminal color authority", () => {
  it("uses a removal tombstone instead of the invalid new-session -e removal spelling", () => {
    expect(TMUX_TRUECOLOR_ENVIRONMENT_ARGS).toEqual(["-e", "COLORTERM=truecolor"]);
    expect(tmuxTruecolorEnvironmentCommands("demo")).toEqual([
      ["set-environment", "-r", "-t", "=demo", "NO_COLOR"],
      ["set-environment", "-t", "=demo", "COLORTERM", "truecolor"],
    ]);

    const runTmux = vi.fn(() => "");
    prepareTmuxTruecolorEnvironment(runTmux, "demo");
    expect(runTmux.mock.calls.map(([args]) => args)).toEqual(
      tmuxTruecolorEnvironmentCommands("demo"),
    );
  });

  it("clears NO_COLOR in both explicit commands and a fresh session's first shell", () => {
    expect(truecolorShellCommand("claude --resume")).toBe(
      "env -u NO_COLOR COLORTERM=truecolor claude --resume",
    );
    expect(TMUX_TRUECOLOR_INTERACTIVE_SHELL_COMMAND).toBe(
      'exec env -u NO_COLOR COLORTERM=truecolor "${SHELL:-/bin/sh}" -l',
    );
  });
});
