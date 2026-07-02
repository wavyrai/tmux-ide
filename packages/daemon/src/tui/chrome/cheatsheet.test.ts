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
import { PANEL_POPUPS, panelKey } from "./panels.ts";
import { DEFAULT_KEYS, DEFAULT_THEME } from "../../lib/app-config.ts";
import { DEFAULT_KEYMAP } from "../team/keymap.ts";
import { GRAMMAR_HELP } from "../../widgets/lib/grammar.ts";

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
    for (const heading of [
      "dock",
      "panels",
      "in panels & sidebar",
      "picker",
      "team app",
      "tmux essentials",
      "cli",
    ]) {
      expect(sheet).toContain(heading);
    }
  });

  it("documents the shared interaction grammar from GRAMMAR_HELP (no duplication)", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    for (const row of GRAMMAR_HELP) {
      expect(sheet).toContain(row.keys);
      expect(sheet).toContain(row.label);
    }
  });

  it("lists each widget panel with its rendered key and label", () => {
    const sheet = stripAnsi(buildCheatsheet({ width: 100 }));
    for (const panel of PANEL_POPUPS) {
      expect(sheet).toContain(pretty(panelKey(panel, DEFAULT_KEYS.panels)));
      expect(sheet).toContain(panel.label);
    }
    expect(sheet).toContain("esc/q closes any panel");
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

  it("renders custom key binds and a custom legend glyph", () => {
    const sheet = stripAnsi(
      buildCheatsheet({
        width: 100,
        keys: {
          popup: "M-o",
          cheatsheet: "M-j",
          menu: "M-u",
          sidebar: "M-w",
          panels: { explorer: "M-x", changes: "M-y", config: "M-z" },
        },
        theme: {
          ...DEFAULT_THEME,
          glyphs: { active: "▲", inactive: "△" },
        },
      }),
    );
    // configured keys drive the dock hints (rendered ⌥o / ⌥j / ⌥u)
    expect(sheet).toContain("⌥o");
    expect(sheet).toContain("⌥j");
    expect(sheet).toContain("⌥u");
    // the sidebar toggle key renders in the dock group (⌥w)
    expect(sheet).toContain("⌥w");
    // and the panels group renders the configured panel keys (⌥x / ⌥y / ⌥z)
    expect(sheet).toContain("⌥x");
    expect(sheet).toContain("⌥y");
    expect(sheet).toContain("⌥z");
    // the default M-p hint is gone
    expect(sheet).not.toContain("⌥p");
    // the legend uses the custom glyphs
    expect(sheet).toContain("▲");
    expect(sheet).toContain("△");
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
