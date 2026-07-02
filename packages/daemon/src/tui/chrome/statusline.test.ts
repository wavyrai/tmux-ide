/**
 * Unit tests for the pure status-bar builder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptableSessionNames,
  adoptOptionCommands,
  adoptSession,
  altKeyBinds,
  buildStatusline,
  homeBindCommand,
  homePopupCommand,
  homeUnbindCommand,
  HOME_KEY,
  isInternalName,
  popupBindCommand,
  popupUnbindCommand,
  POPUP_KEY,
  statusClickBindCommand,
  statusClickUnbindCommand,
  STATUS_CLICK_KEY,
  switcherPopupCommand,
  unadoptOptionCommands,
  unadoptSession,
  updatePopupCommand,
} from "./statusline.ts";
import { kittyEscapeFor, kittyUserKeyIndex, kittyUserKeyName } from "./kitty-keys.ts";
import { menuBindCommand, menuPaneBindCommand, menuStatusBindCommand } from "./menu.ts";
import { PANEL_POPUPS, panelKey, panelPopupBindCommand } from "./panels.ts";
import { sidebarToggleBindCommand } from "./sidebar.ts";
import { ADOPTED_OPTION, STATUS_OPTION } from "./updater.ts";
import {
  DEFAULT_KEYS,
  DEFAULT_THEME,
  _resetForTests,
  type AppTheme,
} from "../../lib/app-config.ts";
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
// adoptSession fires the first-run welcome (a detached `tmux display-popup` +
// marker write) — stub it so the pure bind assertions never touch the real
// filesystem or spawn a process. The welcome logic is tested in welcome.test.ts.
vi.mock("./welcome.ts", () => ({ maybeShowWelcomePopup: () => {} }));

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

  it("carries a muted `[ ⌂ home ⌥h ]` trigger as the first right-side trigger", () => {
    const bar = buildStatusline([project("web")], null);
    expect(bar).toContain("#[range=user|home]");
    expect(bar).toContain("[ ⌂ home ⌥h ]");
    // the home trigger leads the right-side triggers (home → keys → switch)
    expect(bar.indexOf("range=user|home")).toBeLessThan(bar.indexOf("range=user|keys"));
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
    // empty by default — no stray content before the first (home) trigger
    expect(plain).toContain(`#[align=right]#[range=user|home]`);

    const withExtra = buildStatusline([project("web")], null, 12, DEFAULT_THEME, "⬆ v9.9.9");
    expect(withExtra).toContain("⬆ v9.9.9");
    // it sits after the align=right marker and before the first (home) trigger
    const alignAt = withExtra.indexOf("#[align=right]");
    const extraAt = withExtra.indexOf("⬆ v9.9.9");
    const homeAt = withExtra.indexOf("#[range=user|home]");
    expect(alignAt).toBeLessThan(extraAt);
    expect(extraAt).toBeLessThan(homeAt);
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

  it("dispatches the `home` range to the home-cockpit display-popup, nesting the rest", () => {
    const branch = statusClickBindCommand().at(-1)!;
    // the home branch matches the `home` range and opens the home popup
    expect(branch).toContain("#{==:#{mouse_status_range},home}");
    expect(branch).toContain(`tmux-ide team --popup`);
    // and the keys + sw* branches remain nested inside it (dispatch chain intact)
    expect(branch).toContain("#{==:#{mouse_status_range},keys}");
    expect(branch).toContain("#{m:sw*,#{mouse_status_range}}");
  });

  it("passes a custom cheatsheet command into the keys branch", () => {
    const branch = statusClickBindCommand("tmux-ide switcher", "bun run cheatsheet").at(-1)!;
    expect(branch).toContain("bun run cheatsheet");
  });

  it("dispatches the `update` range to the update-flow display-popup, nesting the rest", () => {
    const branch = statusClickBindCommand().at(-1)!;
    // the update branch matches the `update` range and opens the update popup
    expect(branch).toContain("#{==:#{mouse_status_range},update}");
    expect(branch).toContain("tmux-ide update --dry-run");
    // and the home + keys + sw* branches remain nested inside it (chain intact)
    expect(branch).toContain("#{==:#{mouse_status_range},home}");
    expect(branch).toContain("#{==:#{mouse_status_range},keys}");
    expect(branch).toContain("#{m:sw*,#{mouse_status_range}}");
  });
});

describe("updatePopupCommand", () => {
  it("runs `tmux-ide update --dry-run` in a popup that waits for Enter", () => {
    const cmd = updatePopupCommand();
    expect(cmd).toContain("display-popup -E");
    expect(cmd).toContain("tmux-ide update --dry-run");
    expect(cmd).toContain("read _"); // holds the popup open until Enter
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

describe("homePopupCommand / homeBindCommand / homeUnbindCommand", () => {
  it("floats the full home cockpit via `tmux-ide team --popup`", () => {
    expect(homePopupCommand()).toBe(`display-popup -E -w 95% -h 95% "tmux-ide team --popup"`);
  });

  it("binds M-h in the root table to the home popup", () => {
    const cmd = homeBindCommand();
    expect(cmd.slice(0, 5)).toEqual(["bind-key", "-n", HOME_KEY, "display-popup", "-E"]);
    expect(HOME_KEY).toBe("M-h");
    // large (95%) popup, `tmux-ide team --popup` command last
    expect(cmd).toContain("95%");
    expect(cmd[cmd.length - 1]).toBe("tmux-ide team --popup");
  });

  it("passes a custom home command through as the bound command", () => {
    expect(homeBindCommand("bun run home").at(-1)).toBe("bun run home");
  });

  it("unbinds M-h from the root table", () => {
    expect(homeUnbindCommand()).toEqual(["unbind-key", "-n", HOME_KEY]);
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

  it("binds M-m and the right-click menu (MouseUp3Status + MouseUp3Pane) alongside the popup/click binds", () => {
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

  it("binds the home cockpit key (M-h → tmux-ide team --popup)", () => {
    adoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    expect(calls).toContainEqual(homeBindCommand("tmux-ide team --popup", DEFAULT_KEYS.home));
  });

  it("binds the sidebar toggle key (M-b → tmux-ide sidebar-toggle)", () => {
    adoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    expect(calls).toContainEqual(
      sidebarToggleBindCommand("tmux-ide sidebar-toggle", DEFAULT_KEYS.sidebar),
    );
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

  it("registers a kitty-protocol User-key fallback alongside every Alt-key bind", () => {
    adoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    // Every entry in the single altKeyBinds source is an `M-<c>` key, so each
    // gets all three: the M- bind, the user-keys[100+i] escape, and the UserN
    // twin running the identical action argv (bind minus `bind-key -n <key>`).
    altKeyBinds(DEFAULT_KEYS).forEach(({ key, bind }, i) => {
      const escape = kittyEscapeFor(key);
      expect(escape).not.toBeNull();
      expect(calls).toContainEqual(bind);
      expect(calls).toContainEqual([
        "set-option",
        "-s",
        `user-keys[${kittyUserKeyIndex(i)}]`,
        escape,
      ]);
      expect(calls).toContainEqual(["bind-key", "-n", kittyUserKeyName(i), ...bind.slice(3)]);
    });
    // the popup fallback specifically: User100 runs the same display-popup as M-p
    expect(calls).toContainEqual([
      "bind-key",
      "-n",
      "User100",
      ...popupBindCommand("tmux-ide switcher", DEFAULT_KEYS.popup).slice(3),
    ]);
  });

  it("unbinds every Alt key, its User-key twin, and the user-keys slot on unadopt", () => {
    unadoptSession("web");
    const calls = runTmux.mock.calls.map((c) => c[0] as string[]);
    altKeyBinds(DEFAULT_KEYS).forEach(({ key }, i) => {
      expect(calls).toContainEqual(["unbind-key", "-n", key]);
      expect(calls).toContainEqual(["unbind-key", "-n", kittyUserKeyName(i)]);
      expect(calls).toContainEqual(["set-option", "-su", `user-keys[${kittyUserKeyIndex(i)}]`]);
    });
  });
});

describe("prefixKeyBinds", () => {
  it("derives prefix twins for every Alt action, remapping tmux-default letters", async () => {
    const { prefixKeyBinds } = await import("./statusline.ts");
    const { DEFAULT_KEYS } = await import("../../lib/app-config.ts");
    const pkeys = prefixKeyBinds(DEFAULT_KEYS).map((b) => b.pkey);
    // pinned set — the cheat sheet's "prefix keys" section lists exactly these
    expect(pkeys.sort()).toEqual(["b", "e", "g", "h", "j", "k", "u", "v"].sort());
  });
  it("binds into the prefix table with the same action argv", async () => {
    const { prefixKeyBinds } = await import("./statusline.ts");
    const { DEFAULT_KEYS } = await import("../../lib/app-config.ts");
    for (const { bind } of prefixKeyBinds(DEFAULT_KEYS)) {
      expect(bind.slice(0, 3)).toEqual(["bind-key", "-T", "prefix"]);
      expect(bind.length).toBeGreaterThan(4);
    }
  });
});
