/**
 * Unit tests for the pure cheat-sheet builder + its bind/unbind commands.
 */
import { describe, expect, it } from "vitest";
import {
  buildCheatsheet,
  cheatsheetBindCommand,
  cheatsheetUnbindCommand,
  CHEATSHEET_KEY,
} from "./cheatsheet.ts";
import { POPUP_KEY } from "./statusline.ts";
import { DEFAULT_KEYMAP } from "../team/keymap.ts";

/** Strip ANSI SGR escapes so we can assert on visible content and width. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The rendered form of a tmux `M-x` key on the sheet (`M-` → `⌥`). */
function pretty(tmuxKey: string): string {
  return tmuxKey.replace(/M-/g, "⌥");
}

describe("buildCheatsheet", () => {
  it("renders every group heading", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    for (const heading of ["dock", "picker", "team app", "tmux essentials", "cli"]) {
      expect(sheet).toContain(heading);
    }
  });

  it("sources the switcher key hint from POPUP_KEY", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    // POPUP_KEY is "M-p" → rendered "⌥p"; the raw constant must not leak.
    expect(sheet).toContain(pretty(POPUP_KEY));
    expect(sheet).not.toContain(POPUP_KEY);
  });

  it("renders its own key hint from CHEATSHEET_KEY", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    expect(sheet).toContain(pretty(CHEATSHEET_KEY));
  });

  it("derives the team-app rows from DEFAULT_KEYMAP (e.g. rename R)", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    const rename = DEFAULT_KEYMAP.rename;
    expect(sheet).toContain(rename.keys.join("/"));
    expect(sheet).toContain(rename.description);
    // spot-check another so it's clearly the whole keymap, not one hardcoded line
    expect(sheet).toContain(DEFAULT_KEYMAP.filter.description);
  });

  it("includes the glyph legend and the tmux essentials", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    expect(sheet).toContain("blocked");
    expect(sheet).toContain("stopped");
    expect(sheet).toContain("prefix d");
    expect(sheet).toContain("prefix z");
  });

  it("respects width — no visible line exceeds it (wide + narrow)", () => {
    for (const width of [100, 60, 40, 24]) {
      const sheet = buildCheatsheet({ width });
      for (const line of sheet.split("\n")) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("cheatsheetBindCommand", () => {
  it("binds M-k in the root table to a display-popup running the sheet", () => {
    const cmd = cheatsheetBindCommand();
    expect(cmd.slice(0, 5)).toEqual(["bind-key", "-n", CHEATSHEET_KEY, "display-popup", "-E"]);
    expect(cmd).toContain("-w");
    expect(cmd).toContain("-h");
    expect(cmd[cmd.length - 1]).toBe("tmux-ide cheatsheet");
  });

  it("uses M-k as the cheat-sheet key", () => {
    expect(CHEATSHEET_KEY).toBe("M-k");
  });

  it("passes a custom cheatsheet command through as the bound command", () => {
    const cmd = cheatsheetBindCommand("bun run cheatsheet");
    expect(cmd[cmd.length - 1]).toBe("bun run cheatsheet");
  });
});

describe("cheatsheetUnbindCommand", () => {
  it("unbinds M-k from the root table", () => {
    expect(cheatsheetUnbindCommand()).toEqual(["unbind-key", "-n", CHEATSHEET_KEY]);
  });
});
