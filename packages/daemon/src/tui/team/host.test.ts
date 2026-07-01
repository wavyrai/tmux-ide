import { describe, expect, it } from "vitest";
import { HOST_SESSION, hostLayoutCommands, switcherPaneCommand } from "./host.ts";

describe("switcherPaneCommand", () => {
  it("cds into the repo root, forwards the invoke dir, and runs the switcher under bun", () => {
    const cmd = switcherPaneCommand("/repo", "/repo/switcher.tsx", "/work");
    expect(cmd).toContain("cd '/repo'");
    expect(cmd).toContain("TMUX_IDE_CWD='/work'");
    expect(cmd).toContain("bun '/repo/switcher.tsx'");
  });

  it("shell-escapes paths that contain spaces", () => {
    const cmd = switcherPaneCommand("/my repo", "/my repo/switcher.tsx", "/some dir");
    expect(cmd).toContain("cd '/my repo'");
    expect(cmd).toContain("TMUX_IDE_CWD='/some dir'");
    expect(cmd).toContain("bun '/my repo/switcher.tsx'");
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

  it("builds the layout in order: new-session, split-window, resize-pane, select-pane", () => {
    expect(commands.map((argv) => argv[0])).toEqual([
      "new-session",
      "split-window",
      "resize-pane",
      "select-pane",
    ]);
  });

  it("starts a detached session running the switcher command from the repo root", () => {
    const [newSession] = commands;
    expect(newSession).toContain("-d");
    expect(newSession).toContain("-s");
    expect(newSession).toContain(HOST_SESSION);
    expect(newSession).toContain("-c");
    expect(newSession).toContain("/repo");
    // The final argument is the switcher shell command.
    expect(newSession!.at(-1)).toBe(switcherPaneCommand("/repo", "/repo/switcher.tsx", "/work"));
  });

  it("splits a shell to the RIGHT (-h) started in the user's cwd", () => {
    const split = commands[1]!;
    expect(split[0]).toBe("split-window");
    expect(split).toContain("-h");
    expect(split).toContain("-t");
    expect(split).toContain(`${HOST_SESSION}:0.0`);
    expect(split).toContain("-c");
    expect(split).toContain("/work");
  });

  it("pins the switcher pane to the requested width", () => {
    const resize = commands[2]!;
    expect(resize[0]).toBe("resize-pane");
    expect(resize).toContain("-t");
    expect(resize).toContain(`${HOST_SESSION}:0.0`);
    expect(resize).toContain("-x");
    expect(resize).toContain("34");
  });

  it("selects the switcher pane back into focus", () => {
    const select = commands[3]!;
    expect(select[0]).toBe("select-pane");
    expect(select).toContain("-t");
    expect(select).toContain(`${HOST_SESSION}:0.0`);
  });

  it("addresses the switcher as pane 0 in window 0", () => {
    // new-session targets the switcher implicitly; every follow-up targets 0.0.
    for (const argv of commands.slice(1)) {
      expect(argv).toContain(`${HOST_SESSION}:0.0`);
    }
  });
});
