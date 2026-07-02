/**
 * Unit tests for the pure status-bar builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptableSessionNames,
  adoptOptionCommands,
  adoptSession,
  buildStatusline,
  isInternalName,
  popupBindCommand,
  popupUnbindCommand,
  POPUP_KEY,
  statusClickBindCommand,
  statusClickUnbindCommand,
  STATUS_CLICK_KEY,
  switcherPopupCommand,
  unadoptOptionCommands,
} from "./statusline.ts";
import { menuBindCommand, menuPaneBindCommand, menuStatusBindCommand } from "./menu.ts";
import { PANEL_POPUPS, panelKey, panelPopupBindCommand } from "./panels.ts";
import { ADOPTED_OPTION, STATUS_OPTION } from "./updater.ts";
import { DEFAULT_KEYS, DEFAULT_THEME, _resetForTests, type AppTheme } from "../../lib/app-config.ts";
import type { TeamProject } from "../team/projects.ts";
import type { TeamSession } from "../team/sessions.ts";

/** A theme that differs from the defaults in every surface it touches. */
const CUSTOM_THEME: AppTheme = {
  ...DEFAULT_THEME,
  accent: "colour200",
  fg: "colour15",
  muted: "colour238",
  status: { ...DEFAULT_THEME.status, blocked: "colour99", working: "colour45" },
  glyphs: { active: "▲", inactive: "△" },
};

// adoptSession funnels every tmux mutation through runTmux; spy on it and stub
// the updater's io so we can assert the exact key binds adopt applies without
// touching a real tmux server.
const runTmux = vi.fn(() => "");
vi.mock("@tmux-ide/tmux-bridge", () => ({
  runTmux: (...args: unknown[]) => runTmux(...(args as [])),
}));
vi.mock("./updater.ts", async (importActual) => ({
  ...(await importActual<typeof import("./updater.ts")>()),
  seedSessionStatus: () => {},
  startUpdaterIfNeeded: () => {},
}));

function session(name: string, status: TeamSession["status"]): TeamSession {
  return { name, attached: false, windows: 1, panes: 1, status, windowList: [] };
}

function project(name: string, overrides: Partial<TeamProject> = {}): TeamProject {
  return {
    name,
    dir: `/p/${name}`,
    hasIdeYml: false,
    gitBranch: null,
    registered: true,
    running: true,
    status: "idle",
    sessions: [session(name, "idle")],
    ...overrides,
  };
}

describe("buildStatusline", () => {
  it("renders a running project with its status glyph and name", () => {
    const bar = buildStatusline([project("web", { status: "working" })], null);
    expect(bar).toContain("tmux-ide");
    expect(bar).toContain("#[fg=colour221]●#[default]");
    expect(bar).toContain("web");
  });

  it("renders a stopped project muted with a hollow glyph", () => {
    const bar = buildStatusline([project("api", { running: false, sessions: [] })], null);
    expect(bar).toContain("#[fg=colour240]○#[default]");
    expect(bar).toContain("#[fg=colour240]api#[default]");
  });

  it("highlights the active session's project", () => {
    const bar = buildStatusline([project("web"), project("api")], "web");
    expect(bar).toContain("#[fg=colour231,bold,underscore]web#[default]");
    expect(bar).not.toContain("underscore]api");
  });

  it("matches active by contained session name, not just project name", () => {
    const p = project("mono", { sessions: [session("mono-api", "idle")] });
    const bar = buildStatusline([p], "mono-api");
    expect(bar).toContain("underscore]mono#[default]");
  });

  it("uses the blocked style for a blocked project", () => {
    const bar = buildStatusline([project("hot", { status: "blocked" })], null);
    expect(bar).toContain("#[fg=colour203,bold]●#[default]");
  });

  it("caps segments and reports the overflow count", () => {
    const many = Array.from({ length: 15 }, (_, i) => project(`p${i}`));
    const bar = buildStatusline(many, null, 12);
    expect(bar).toContain("p11");
    expect(bar).not.toContain("p12 ");
    expect(bar).toContain("+3");
  });

  it("renders the brand alone for an empty fleet", () => {
    const bar = buildStatusline([], null);
    expect(bar).toContain("tmux-ide");
  });

  it("hides internal `_`-prefixed projects and their sessions", () => {
    const bar = buildStatusline(
      [
        project("_tmux-ide"),
        project("_scratch", { sessions: [session("_scratch", "idle")] }),
        project("web"),
      ],
      null,
    );
    expect(bar).toContain("web");
    expect(bar).not.toContain("_tmux-ide");
    expect(bar).not.toContain("_scratch");
  });

  it("wraps each running project in a session-keyed click range", () => {
    const bar = buildStatusline([project("web", { sessions: [session("web-dev", "idle")] })], null);
    expect(bar).toContain("#[range=user|swweb-dev]");
    expect(bar).toContain("#[norange]");
  });

  it("does NOT range a stopped project (no session to switch to)", () => {
    const bar = buildStatusline([project("api", { running: false, sessions: [] })], null);
    // no project range for `api`; the only sw-range in the bar is the trigger
    expect(bar).not.toContain("range=user|swapi");
    expect(bar.match(/range=user\|sw/g)).toHaveLength(1); // just the switcher trigger
  });

  it("ends with a right-aligned switcher trigger button carrying the ⌥p hint", () => {
    const bar = buildStatusline([project("web")], null);
    expect(bar).toContain("#[range=user|switcher]");
    expect(bar).toContain("⧉ switch ⌥p");
    expect(bar).toContain("#[align=right]");
    // the trigger's range sits after the project ranges (right side of the row)
    expect(bar.indexOf("range=user|switcher")).toBeGreaterThan(bar.indexOf("range=user|sw"));
  });

  it("carries a muted `[ ? keys ]` trigger just left of the switch trigger", () => {
    const bar = buildStatusline([project("web")], null);
    expect(bar).toContain("#[range=user|keys]");
    expect(bar).toContain("[ ? keys ]");
    // the keys trigger sits before (left of) the primary switch trigger
    expect(bar.indexOf("range=user|keys")).toBeLessThan(bar.indexOf("range=user|switcher"));
  });

  it("applies a custom theme's tokens to the brand, glyph, and colors", () => {
    const bar = buildStatusline([project("hot", { status: "blocked" })], null, 12, CUSTOM_THEME);
    // brand + switch trigger use the custom accent
    expect(bar).toContain("#[fg=colour200,bold] tmux-ide #[default]");
    expect(bar).toContain("#[fg=colour200,bold][ ⧉ switch ⌥p ]");
    // blocked keeps its bold, but with the custom status color + active glyph
    expect(bar).toContain("#[fg=colour99,bold]▲#[default]");
    // running name uses the custom fg
    expect(bar).toContain("#[fg=colour15]hot#[default]");
    // and none of the default tokens leak through for those surfaces
    expect(bar).not.toContain("colour75");
    expect(bar).not.toContain("#[fg=colour203,bold]");
  });

  it("renders a stopped project with the custom muted color + inactive glyph", () => {
    const bar = buildStatusline(
      [project("api", { running: false, sessions: [] })],
      null,
      12,
      CUSTOM_THEME,
    );
    expect(bar).toContain("#[fg=colour238]△#[default]");
    expect(bar).toContain("#[fg=colour238]api#[default]");
  });

  it("renders the reserved extraSegment on the right before the triggers (empty by default)", () => {
    const plain = buildStatusline([project("web")], null);
    // empty by default — no stray content before the keys trigger
    expect(plain).toContain(`#[align=right]#[range=user|keys]`);

    const withExtra = buildStatusline([project("web")], null, 12, DEFAULT_THEME, "⬆ v9.9.9");
    expect(withExtra).toContain("⬆ v9.9.9");
    // it sits after the align=right marker and before the keys trigger
    const alignAt = withExtra.indexOf("#[align=right]");
    const extraAt = withExtra.indexOf("⬆ v9.9.9");
    const keysAt = withExtra.indexOf("#[range=user|keys]");
    expect(alignAt).toBeLessThan(extraAt);
    expect(extraAt).toBeLessThan(keysAt);
  });
});

describe("isInternalName", () => {
  it("treats `_`-prefixed names as internal", () => {
    expect(isInternalName("_tmux-ide")).toBe(true);
    expect(isInternalName("_scratch")).toBe(true);
    expect(isInternalName("web")).toBe(false);
    expect(isInternalName("api-2")).toBe(false);
  });
});

describe("adoptOptionCommands", () => {
  const cmds = adoptOptionCommands("web");

  it("points status-format[1] at the pre-computed var (a bare #{…} read, no spawn)", () => {
    const fmt = cmds.find((c) => c[3] === "status-format[1]");
    expect(fmt).toEqual([
      "set-option",
      "-t",
      "web",
      "status-format[1]",
      `#[align=left]#{${STATUS_OPTION}}`,
    ]);
    // no `#()` shell-out — the old per-tick spawn is gone
    expect(cmds.some((c) => c.some((a) => a.includes("#(")))).toBe(false);
  });

  it("sets the adopted marker so the updater can enumerate the session", () => {
    expect(cmds).toContainEqual(["set-option", "-t", "web", ADOPTED_OPTION, "1"]);
  });

  it("enables the second status row and mouse mode per-session", () => {
    expect(cmds).toContainEqual(["set-option", "-t", "web", "status", "2"]);
    expect(cmds).toContainEqual(["set-option", "-t", "web", "mouse", "on"]);
    // every command is per-session (`-t web`), never global
    expect(cmds.every((c) => c.includes("-t") && c.includes("web"))).toBe(true);
  });
});

describe("unadoptOptionCommands", () => {
  const cmds = unadoptOptionCommands("web");

  it("unsets the marker and the status var", () => {
    expect(cmds).toContainEqual(["set-option", "-u", "-t", "web", ADOPTED_OPTION]);
    expect(cmds).toContainEqual(["set-option", "-u", "-t", "web", STATUS_OPTION]);
  });

  it("reverts the status row + mouse to inherited", () => {
    expect(cmds).toContainEqual(["set-option", "-u", "-t", "web", "status"]);
    expect(cmds).toContainEqual(["set-option", "-u", "-t", "web", "status-format[1]"]);
    expect(cmds).toContainEqual(["set-option", "-u", "-t", "web", "mouse"]);
    // all unsets (`-u`), all per-session
    expect(cmds.every((c) => c.includes("-u") && c[3] === "web")).toBe(true);
  });
});

describe("adoptableSessionNames", () => {
  it("keeps non-internal sessions and drops `_`-prefixed plumbing", () => {
    expect(adoptableSessionNames(["web", "_tmux-ide-chrome", "api", "_scratch"])).toEqual([
      "web",
      "api",
    ]);
  });

  it("ignores blank lines", () => {
    expect(adoptableSessionNames(["web", "", "api"])).toEqual(["web", "api"]);
  });
});

describe("statusClickBindCommand", () => {
  it("binds MouseDown1Status in the root table via if-shell", () => {
    const cmd = statusClickBindCommand();
    expect(cmd.slice(0, 5)).toEqual(["bind-key", "-n", STATUS_CLICK_KEY, "if-shell", "-F"]);
    expect(STATUS_CLICK_KEY).toBe("MouseDown1Status");
  });

  it("dispatches the `switcher` range to the same display-popup as M-p", () => {
    const cmd = statusClickBindCommand();
    // top-level condition matches the trigger range
    expect(cmd).toContain("#{==:#{mouse_status_range},switcher}");
    // the then-branch is the popup command
    expect(cmd.some((a) => a.includes(`display-popup -E -w 80% -h 60% "tmux-ide switcher"`))).toBe(
      true,
    );
  });

  it("dispatches `sw*` ranges to a run-shell switch-client with the extracted name", () => {
    const elseBranch = statusClickBindCommand().at(-1)!;
    expect(elseBranch).toContain("#{m:sw*,#{mouse_status_range}}");
    expect(elseBranch).toContain("run-shell");
    expect(elseBranch).toContain("switch-client -c '#{client_name}'");
    // session name extracted with the colon-free s/// (a `:` in the pattern breaks it)
    expect(elseBranch).toContain("#{s/^sw//:mouse_status_range}");
    // clicks that aren't ours fall back to tmux's default window select
    expect(elseBranch).toContain("select-window -t =");
  });

  it("passes a custom switcher command into the popup branch", () => {
    const cmd = statusClickBindCommand("bun run switcher");
    expect(cmd.some((a) => a.includes(`"bun run switcher"`))).toBe(true);
  });

  it("dispatches the `keys` range to the cheat-sheet display-popup", () => {
    const branch = statusClickBindCommand().at(-1)!;
    expect(branch).toContain("#{==:#{mouse_status_range},keys}");
    expect(branch).toContain("tmux-ide cheatsheet");
    // the sw* switch stays nested inside the keys branch (not lost)
    expect(branch).toContain("#{m:sw*,#{mouse_status_range}}");
    expect(branch).toContain("switch-client -c '#{client_name}'");
  });

  it("passes a custom cheatsheet command into the keys branch", () => {
    const branch = statusClickBindCommand("tmux-ide switcher", "bun run cheatsheet").at(-1)!;
    expect(branch).toContain("bun run cheatsheet");
  });
});

describe("statusClickUnbindCommand", () => {
  it("unbinds MouseDown1Status from the root table", () => {
    expect(statusClickUnbindCommand()).toEqual(["unbind-key", "-n", STATUS_CLICK_KEY]);
  });
});

describe("popupBindCommand", () => {
  it("binds M-p in the root table to a display-popup running the switcher", () => {
    const cmd = popupBindCommand();
    expect(cmd.slice(0, 5)).toEqual(["bind-key", "-n", POPUP_KEY, "display-popup", "-E"]);
    // sized popup, switcher command last
    expect(cmd).toContain("-w");
    expect(cmd).toContain("-h");
    expect(cmd[cmd.length - 1]).toBe("tmux-ide switcher");
  });

  it("uses M-p as the popup key (root table, avoids prefix p)", () => {
    expect(POPUP_KEY).toBe("M-p");
  });

  it("passes a custom switcher command through as the bound command", () => {
    const cmd = popupBindCommand("bun run switcher");
    expect(cmd[cmd.length - 1]).toBe("bun run switcher");
  });

  it("does NOT append a #{client_name} arg (it would not format-expand)", () => {
    // The switcher resolves its own client from inside the popup instead.
    expect(popupBindCommand().join(" ")).not.toContain("client_name");
  });
});

describe("popupUnbindCommand", () => {
  it("unbinds M-p from the root table", () => {
    expect(popupUnbindCommand()).toEqual(["unbind-key", "-n", POPUP_KEY]);
  });
});

describe("switcherPopupCommand", () => {
  it("is the display-popup command string the M-p bind runs", () => {
    expect(switcherPopupCommand()).toBe(`display-popup -E -w 80% -h 60% "tmux-ide switcher"`);
  });

  it("is what statusClickBindCommand dispatches the `switcher` range to", () => {
    expect(statusClickBindCommand()).toContain(switcherPopupCommand());
  });
});

describe("adoptSession key binds", () => {
  // adoptSession resolves keys from the app config; pin it to the defaults by
  // pointing TMUX_IDE_CONFIG at a missing file (so a real ~/.tmux-ide/config.json
  // on the dev/CI box can't change which keys it binds).
  const savedConfig = process.env.TMUX_IDE_CONFIG;
  beforeEach(() => {
    process.env.TMUX_IDE_CONFIG = "/tmp/zz-statusline-test-missing.json";
    _resetForTests();
  });
  afterEach(() => {
    runTmux.mockClear();
    if (savedConfig === undefined) delete process.env.TMUX_IDE_CONFIG;
    else process.env.TMUX_IDE_CONFIG = savedConfig;
    _resetForTests();
  });

  it("binds M-m and the right-click menu (MouseDown3Status + MouseDown3Pane) alongside the popup/click binds", () => {
    adoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    // the menu binds are applied — key, chrome-row right-click, AND any-pane right-click
    expect(calls).toContainEqual(menuBindCommand());
    expect(calls).toContainEqual(menuStatusBindCommand());
    expect(calls).toContainEqual(menuPaneBindCommand());
    // and the pre-existing binds are still applied (no regression)
    expect(calls).toContainEqual(popupBindCommand("tmux-ide switcher"));
    expect(calls).toContainEqual(statusClickBindCommand("tmux-ide switcher"));
  });

  it("binds one display-popup panel key per widget (explorer/changes/config)", () => {
    adoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    for (const panel of PANEL_POPUPS) {
      const key = panelKey(panel, DEFAULT_KEYS.panels);
      expect(calls).toContainEqual(panelPopupBindCommand(panel, key));
    }
    // the three panels are the explorer/changes/config widgets on M-e/M-g/M-,
    expect(PANEL_POPUPS.map((p) => p.widget)).toEqual(["explorer", "changes", "config"]);
    expect([
      DEFAULT_KEYS.panels.explorer,
      DEFAULT_KEYS.panels.changes,
      DEFAULT_KEYS.panels.config,
    ]).toEqual(["M-e", "M-g", "M-,"]);
  });
});
