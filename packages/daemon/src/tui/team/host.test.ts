import { describe, expect, it } from "vitest";
import {
  HOST_SESSION,
  HOST_SOCKET,
  MAIN_PANE,
  SWITCHER_PANE,
  hostLayoutCommands,
  hostTmux,
  mainRespawnCommand,
  switcherPaneCommand,
} from "./host.ts";

/** Assert an argv runs on the host socket, and return the command tail after `-L tmux-ide`. */
function onHostSocket(argv: string[]): string[] {
  expect(argv.slice(0, 2)).toEqual(["-L", HOST_SOCKET]);
  return argv.slice(2);
}

describe("host pane constants", () => {
  it("addresses the switcher as pane 0 and the main area as pane 1", () => {
    expect(SWITCHER_PANE).toBe(`${HOST_SESSION}:0.0`);
    expect(MAIN_PANE).toBe(`${HOST_SESSION}:0.1`);
  });
});

describe("hostTmux", () => {
  it("prefixes argv with the dedicated host socket", () => {
    expect(HOST_SOCKET).toBe("tmux-ide");
    expect(hostTmux(["list-sessions"])).toEqual(["-L", "tmux-ide", "list-sessions"]);
  });

  it("preserves the original argv after the socket flag", () => {
    expect(hostTmux(["has-session", "-t", HOST_SESSION])).toEqual([
      "-L",
      "tmux-ide",
      "has-session",
      "-t",
      HOST_SESSION,
    ]);
  });
});

describe("switcherPaneCommand", () => {
  it("cds into the repo root, forwards the invoke dir, and runs the switcher under bun", () => {
    const cmd = switcherPaneCommand("/repo", "/repo/switcher.tsx", "/work");
    expect(cmd).toContain("cd '/repo'");
    expect(cmd).toContain("TMUX_IDE_CWD='/work'");
    expect(cmd).toContain("bun '/repo/switcher.tsx'");
  });

  it("exports the main-pane target so the switcher runs in host mode", () => {
    const cmd = switcherPaneCommand("/repo", "/repo/switcher.tsx", "/work");
    expect(cmd).toContain(`TMUX_IDE_MAIN_PANE='${MAIN_PANE}'`);
  });

  it("shell-escapes paths that contain spaces", () => {
    const cmd = switcherPaneCommand("/my repo", "/my repo/switcher.tsx", "/some dir");
    expect(cmd).toContain("cd '/my repo'");
    expect(cmd).toContain("TMUX_IDE_CWD='/some dir'");
    expect(cmd).toContain("bun '/my repo/switcher.tsx'");
  });
});

describe("mainRespawnCommand", () => {
  const argv = mainRespawnCommand(MAIN_PANE, "my-project", "/work");

  it("runs on the host socket, then respawns the main pane, killing whatever it was running", () => {
    expect(argv.slice(0, 5)).toEqual(["-L", HOST_SOCKET, "respawn-pane", "-k", "-t"]);
    expect(argv).toContain(MAIN_PANE);
  });

  it("sets the pane working directory", () => {
    expect(argv).toContain("-c");
    expect(argv).toContain("/work");
  });

  it("runs a nested tmux attach with $TMUX cleared (default socket)", () => {
    expect(argv.at(-1)).toBe("TMUX= tmux attach -t 'my-project'");
  });

  it("orders the argv as -L tmux-ide respawn-pane -k -t <pane> -c <dir> <command>", () => {
    expect(mainRespawnCommand("_tmux-ide:0.1", "sess", "/dir")).toEqual([
      "-L",
      "tmux-ide",
      "respawn-pane",
      "-k",
      "-t",
      "_tmux-ide:0.1",
      "-c",
      "/dir",
      "TMUX= tmux attach -t 'sess'",
    ]);
  });
});

describe("hostLayoutCommands", () => {
  const commands = hostLayoutCommands({
    session: HOST_SESSION,
    repoRoot: "/repo",
    switcherScript: "/repo/switcher.tsx",
    userCwd: "/work",
    switcherWidth: 34,
  });
  // Command tails (after the `-L tmux-ide` socket prefix) for content assertions.
  const tails = commands.map(onHostSocket);

  it("runs every command on the dedicated host socket", () => {
    for (const argv of commands) {
      expect(argv.slice(0, 2)).toEqual(["-L", HOST_SOCKET]);
    }
  });

  it("builds the layout first: new-session, split-window, resize-pane, select-pane", () => {
    expect(tails.slice(0, 4).map((argv) => argv[0])).toEqual([
      "new-session",
      "split-window",
      "resize-pane",
      "select-pane",
    ]);
  });

  it("starts a detached session running the switcher command from the repo root", () => {
    const newSession = tails[0]!;
    expect(newSession).toContain("-d");
    expect(newSession).toContain("-s");
    expect(newSession).toContain(HOST_SESSION);
    expect(newSession).toContain("-c");
    expect(newSession).toContain("/repo");
    // The final argument is the switcher shell command.
    expect(newSession.at(-1)).toBe(switcherPaneCommand("/repo", "/repo/switcher.tsx", "/work"));
  });

  it("splits a shell to the RIGHT (-h) started in the user's cwd", () => {
    const split = tails[1]!;
    expect(split[0]).toBe("split-window");
    expect(split).toContain("-h");
    expect(split).toContain("-t");
    expect(split).toContain(`${HOST_SESSION}:0.0`);
    expect(split).toContain("-c");
    expect(split).toContain("/work");
  });

  it("pins the switcher pane to the requested width", () => {
    const resize = tails[2]!;
    expect(resize[0]).toBe("resize-pane");
    expect(resize).toContain("-t");
    expect(resize).toContain(`${HOST_SESSION}:0.0`);
    expect(resize).toContain("-x");
    expect(resize).toContain("34");
  });

  it("selects the switcher pane back into focus", () => {
    const select = tails[3]!;
    expect(select[0]).toBe("select-pane");
    expect(select).toContain("-t");
    expect(select).toContain(`${HOST_SESSION}:0.0`);
  });

  it("sets the host prefix to C-a and clears prefix2 so C-b passes through", () => {
    const setKeys = tails.map((argv) => argv.join(" "));
    expect(setKeys).toContain("set-option -g prefix C-a");
    expect(setKeys).toContain("set-option -g prefix2 None");
  });

  it("binds root focus-toggle keys (M-h/M-l) on the host server only", () => {
    const binds = tails.filter((argv) => argv[0] === "bind-key");
    expect(binds.length).toBeGreaterThanOrEqual(2);
    // All root (no-prefix) binds that select a pane.
    for (const bind of binds) {
      expect(bind).toContain("-n");
      expect(bind).toContain("select-pane");
    }
    const keys = binds.map((argv) => argv[2]);
    expect(keys).toEqual(expect.arrayContaining(["M-h", "M-l"]));
  });

  it("enables pane-border labels showing each pane's title", () => {
    const setKeys = tails.map((argv) => argv.join(" "));
    expect(setKeys).toContain("set-option -g pane-border-status top");
    expect(setKeys.some((s) => s.startsWith("set-option -g pane-border-format"))).toBe(true);
  });

  it("titles the switcher and main panes", () => {
    const titled = tails
      .filter((argv) => argv[0] === "select-pane" && argv.includes("-T"))
      .map((argv) => argv.at(-1));
    expect(titled).toEqual(expect.arrayContaining(["switcher", "main"]));
  });
});
