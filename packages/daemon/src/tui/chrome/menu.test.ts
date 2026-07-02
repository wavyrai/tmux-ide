/**
 * Unit tests for the pure right-click actions menu builder + its bind commands.
 */
import { describe, expect, it } from "vitest";
import {
  buildMenu,
  menuBindCommand,
  menuPaneBindCommand,
  menuPaneUnbindCommand,
  menuPositionArgs,
  menuQuoteName,
  menuStatusBindCommand,
  menuStatusUnbindCommand,
  menuUnbindCommand,
  MENU_KEY,
  MENU_PANE_KEY,
  MENU_STATUS_KEY,
} from "./menu.ts";
import { switcherPopupCommand } from "./statusline.ts";
import { cheatsheetPopupCommand } from "./cheatsheet.ts";
import { PANEL_POPUPS, panelPopupCommand } from "./panels.ts";
import { DEFAULT_THEME, type AppTheme } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";

function sess(name: string, status: AgentStatus) {
  return { name, status };
}

describe("buildMenu", () => {
  it("leads with the tmux-ide title", () => {
    const args = buildMenu([]);
    expect(args.slice(0, 2)).toEqual(["-T", "tmux-ide"]);
  });

  it("opens the switcher via the exact same popup command M-p uses", () => {
    const args = buildMenu([]);
    const i = args.indexOf("⧉ Switch session…");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("s"); // mnemonic key
    expect(args[i + 2]).toBe(switcherPopupCommand());
  });

  it("opens the cheat sheet via the exact same popup command M-k uses", () => {
    const args = buildMenu([]);
    const i = args.indexOf("? Cheat sheet");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("k");
    expect(args[i + 2]).toBe(cheatsheetPopupCommand());
  });

  it("lists each session with a status glyph, a 1..N key, and a switch-client target", () => {
    const args = buildMenu([sess("web", "working"), sess("api", "idle")]);
    const iWeb = args.findIndex((a) => a.includes("web"));
    expect(args[iWeb]).toContain("#[fg=colour221]●#[default]"); // working glyph, amber
    expect(args[iWeb]).toContain("web");
    expect(args[iWeb + 1]).toBe("1");
    expect(args[iWeb + 2]).toBe("switch-client -t 'web'");

    const iApi = args.findIndex((a) => a.includes("api"));
    expect(args[iApi]).toContain("#[fg=colour114]○#[default]"); // idle glyph, hollow green
    expect(args[iApi + 1]).toBe("2");
    expect(args[iApi + 2]).toBe("switch-client -t 'api'");
  });

  it("maps every status to its bar-matching colour", () => {
    const args = buildMenu([
      sess("b", "blocked"),
      sess("w", "working"),
      sess("d", "done"),
      sess("i", "idle"),
      sess("u", "unknown"),
    ]);
    expect(args.some((a) => a.includes("#[fg=colour203]●#[default] b"))).toBe(true);
    expect(args.some((a) => a.includes("#[fg=colour221]●#[default] w"))).toBe(true);
    expect(args.some((a) => a.includes("#[fg=colour111]●#[default] d"))).toBe(true);
    expect(args.some((a) => a.includes("#[fg=colour114]○#[default] i"))).toBe(true);
    expect(args.some((a) => a.includes("#[fg=colour244]·#[default] u"))).toBe(true);
  });

  it("uses a custom theme's status colors + glyphs for the session rows", () => {
    const theme: AppTheme = {
      ...DEFAULT_THEME,
      status: { ...DEFAULT_THEME.status, working: "colour45" },
      glyphs: { active: "▲", inactive: "△" },
    };
    const args = buildMenu([sess("web", "working"), sess("api", "idle")], theme);
    // working → custom color + custom active glyph
    expect(args.some((a) => a.includes("#[fg=colour45]▲#[default] web"))).toBe(true);
    // idle → its status color + the custom inactive (hollow) glyph
    expect(args.some((a) => a.includes("#[fg=colour114]△#[default] api"))).toBe(true);
    // no default working color / glyph leaks through
    expect(args.some((a) => a.includes("#[fg=colour221]"))).toBe(false);
  });

  it("caps the session list at 8 rows (keys 1..8)", () => {
    const many = Array.from({ length: 12 }, (_, i) => sess(`s${i}`, "idle"));
    const args = buildMenu(many);
    // 8 switch-client targets, no more
    const switches = args.filter((a) => a.startsWith("switch-client -t "));
    expect(switches).toHaveLength(8);
    expect(args).not.toContain("9");
    expect(args.some((a) => a.includes("s7"))).toBe(true); // 8th (index 7) present
    expect(args.some((a) => a.includes("s8"))).toBe(false); // 9th dropped
  });

  it("always offers new-session and kill-session actions", () => {
    const args = buildMenu([]);
    const iNew = args.indexOf("＋ New session…");
    expect(iNew).toBeGreaterThanOrEqual(0);
    expect(args[iNew + 1]).toBe("n");
    expect(args[iNew + 2]).toContain("command-prompt");
    expect(args[iNew + 2]).toContain("new-session -d -s '%%'");

    const iKill = args.indexOf("✕ Kill this session");
    expect(iKill).toBeGreaterThanOrEqual(0);
    expect(args[iKill + 1]).toBe("x");
    expect(args[iKill + 2]).toContain("confirm-before");
    expect(args[iKill + 2]).toContain("kill-session");
  });

  it("separates the groups with empty-name separator items", () => {
    // With sessions: header · sep · panels · sep · sessions · sep · footer →
    // exactly 3 separators.
    expect(buildMenu([sess("web", "idle")]).filter((a) => a === "")).toHaveLength(3);
  });

  it("collapses the separator when there are no sessions (no stacked dividers)", () => {
    // header · sep · panels · sep · footer → exactly 2 separators, never two in a row.
    const args = buildMenu([]);
    expect(args.filter((a) => a === "")).toHaveLength(2);
    for (let i = 1; i < args.length; i++) {
      expect(args[i] === "" && args[i - 1] === "").toBe(false);
    }
  });

  it("lists each widget panel with a mnemonic key and its floating popup command", () => {
    const args = buildMenu([]);
    for (const panel of PANEL_POPUPS) {
      const i = args.indexOf(panel.label);
      expect(i).toBeGreaterThanOrEqual(0);
      // command opens the same display-popup the panel's root-table key does,
      // on the pane's cwd.
      expect(args[i + 2]).toBe(panelPopupCommand(panel));
      expect(args[i + 2]).toContain(`tmux-ide popup ${panel.widget}`);
      expect(args[i + 2]).toContain("-d '#{pane_current_path}'");
    }
    // mnemonics: Files e, Changes g, Config ,
    expect(args[args.indexOf("⊞ Files") + 1]).toBe("e");
    expect(args[args.indexOf("± Changes") + 1]).toBe("g");
    expect(args[args.indexOf("⚙ Config") + 1]).toBe(",");
  });

  it("quotes odd session names so shell/tmux metachars can't leak as tokens", () => {
    const args = buildMenu([sess("a; rm -rf", "idle"), sess("we ird#$", "idle")]);
    expect(args).toContain("switch-client -t 'a; rm -rf'");
    expect(args).toContain("switch-client -t 'we ird#$'");
  });
});

describe("menuQuoteName", () => {
  it("single-quotes a plain name", () => {
    expect(menuQuoteName("web")).toBe("'web'");
  });

  it("escapes an embedded single quote the shell way", () => {
    expect(menuQuoteName("it's")).toBe(`'it'\\''s'`);
  });
});

describe("menuBindCommand", () => {
  it("binds M-m in the root table via a run-shell that expands the client", () => {
    const cmd = menuBindCommand();
    expect(cmd.slice(0, 4)).toEqual(["bind-key", "-n", MENU_KEY, "run-shell"]);
    expect(cmd).toContain("-b"); // detached so key dispatch isn't blocked
    expect(cmd[cmd.length - 1]).toBe(`tmux-ide menu --client '#{client_name}'`);
    expect(MENU_KEY).toBe("M-m");
  });

  it("passes a custom menu command through", () => {
    const cmd = menuBindCommand("bun run menu");
    expect(cmd[cmd.length - 1]).toBe(`bun run menu --client '#{client_name}'`);
  });
});

describe("menuStatusBindCommand", () => {
  it("binds a right-click on the status bar (MouseDown3Status) to the same menu, at the pointer", () => {
    const cmd = menuStatusBindCommand();
    expect(cmd.slice(0, 4)).toEqual(["bind-key", "-n", MENU_STATUS_KEY, "run-shell"]);
    // status mouse_x is already a screen column; the dock is at the bottom, so
    // client_height as the bottom edge opens the menu right above the bar.
    expect(cmd[cmd.length - 1]).toBe(
      `tmux-ide menu --client '#{client_name}' --x '#{mouse_x}' --y '#{client_height}'`,
    );
    expect(MENU_STATUS_KEY).toBe("MouseDown3Status");
  });
});

describe("menuPaneBindCommand", () => {
  it("binds a right-click on ANY pane body (MouseDown3Pane) to the same menu, at the pointer", () => {
    const cmd = menuPaneBindCommand();
    expect(cmd.slice(0, 4)).toEqual(["bind-key", "-n", MENU_PANE_KEY, "run-shell"]);
    expect(cmd).toContain("-b");
    // pane mouse coords are PANE-relative — the bind adds the pane origin with
    // tmux format arithmetic so display-menu gets SCREEN coords.
    expect(cmd[cmd.length - 1]).toBe(
      `tmux-ide menu --client '#{client_name}' --x '#{e|+:#{pane_left},#{mouse_x}}' --y '#{e|+:#{pane_top},#{mouse_y}}'`,
    );
    expect(MENU_PANE_KEY).toBe("MouseDown3Pane");
  });

  it("passes a custom menu command through with the coord forwarding", () => {
    const cmd = menuPaneBindCommand("bun run menu");
    expect(cmd[cmd.length - 1]).toBe(
      `bun run menu --client '#{client_name}' --x '#{e|+:#{pane_left},#{mouse_x}}' --y '#{e|+:#{pane_top},#{mouse_y}}'`,
    );
  });
});

describe("menuPositionArgs", () => {
  it("emits -x/-y flags for numeric coords", () => {
    expect(menuPositionArgs("12", "5")).toEqual(["-x", "12", "-y", "5"]);
    expect(menuPositionArgs("0", "0")).toEqual(["-x", "0", "-y", "0"]);
  });

  it("omits the flags (→ centered) when either coord is missing or non-numeric", () => {
    expect(menuPositionArgs(undefined, "5")).toEqual([]);
    expect(menuPositionArgs("12", undefined)).toEqual([]);
    // an unexpanded #{mouse_*} literal from the keyboard path
    expect(menuPositionArgs("#{mouse_x}", "#{mouse_y}")).toEqual([]);
    expect(menuPositionArgs("12", "abc")).toEqual([]);
    expect(menuPositionArgs("1.5", "2")).toEqual([]);
  });
});

describe("menu unbind commands", () => {
  it("unbind M-m and both right-click binds from the root table", () => {
    expect(menuUnbindCommand()).toEqual(["unbind-key", "-n", MENU_KEY]);
    expect(menuStatusUnbindCommand()).toEqual(["unbind-key", "-n", MENU_STATUS_KEY]);
    expect(menuPaneUnbindCommand()).toEqual(["unbind-key", "-n", MENU_PANE_KEY]);
  });
});
