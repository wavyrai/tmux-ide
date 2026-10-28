import { describe, expect, it } from "vitest";
import { createBrowserPane, resolveTerminalBrowser, validateBrowserOpen } from "./open-browser.ts";

describe("browser pane creation", () => {
  function fixture(options = {}, url: string | undefined = "https://example.com") {
    const calls: string[][] = [];
    const result = createBrowserPane(
      (args) => {
        calls.push([...args]);
        return args[0] === "display-message" ? "$2\t@4\t%8\t123" : "$2\t@4\t%9";
      },
      "/opt/browser",
      url,
      options,
      {
        TMUX: "/tmp/socket,123,2",
        TMUX_PANE: "%8",
        PATH: "/usr/bin",
        TMUX_IDE_NATIVE_SURFACE: "parent-only",
      },
      "/tmp/project",
      { TMUX_IDE_RUNTIME_MODE: "development" },
    );
    return { calls, result };
  }
  it("passes the URL literally and gives tmux responsibility for the new pane identity", () => {
    const url = "https://example.com/?q=$(touch /tmp/nope); x&y='z'";
    const { calls, result } = fixture({}, url);
    expect(calls[0]?.[3]).toBe("$2:.%8");
    expect(calls[1]?.slice(-4)).toEqual(["/opt/browser", "open", url, "--no-merge"]);
    expect(calls[1]).toContain("$2:@4.%8");
    expect(calls[1]).toContain("TMUX_IDE_RUNTIME_MODE=development");
    expect(calls[1]?.join(" ")).not.toMatch(/parent-only|TMUX_PANE=/);
    expect(result).toEqual({ pane: "%9", session: "$2", window: "@4", status: "created" });
  });
  it("opens the start page without a URL", () => {
    const { calls } = fixture({}, "https://example.com");
    expect(calls[1]).toContain("-h");
    const run = (args: readonly string[]) =>
      args[0] === "display-message" ? "$2\t@4\t%8\t123" : "$2\t@4\t%9";
    expect(
      createBrowserPane(run, "/opt/browser", undefined, { session: "web" }, {}, "/tmp", {}).pane,
    ).toBe("%9");
  });
  it("supports a vertical split and a new window", () => {
    expect(fixture({ split: "down", size: "30" }).calls[1]).toEqual(
      expect.arrayContaining(["-v", "30%"]),
    );
    expect(fixture({ window: true }).calls[1]?.[0]).toBe("new-window");
  });
  it("refuses an implicit target on another server before creating a pane", () => {
    const calls: string[][] = [];
    expect(() =>
      createBrowserPane(
        (args) => {
          calls.push([...args]);
          return "$2\t@4\t%8\t999";
        },
        "/opt/browser",
        undefined,
        {},
        { TMUX: "/tmp/socket,123,2", TMUX_PANE: "%8" },
        "/tmp",
        {},
      ),
    ).toThrow("different tmux server");
    expect(calls).toHaveLength(1);
  });
  it("requires a target outside tmux", () => {
    expect(() =>
      createBrowserPane(
        () => {
          throw new Error("must not run");
        },
        "/opt/browser",
        undefined,
        {},
        {},
        "/tmp",
        {},
      ),
    ).toThrow("--session");
  });
  it("rejects conflicting session and pane selection", () => {
    expect(() =>
      createBrowserPane(
        (args) => (args.at(-1) === "#{session_id}" ? "$3" : "$2\t@4\t%8\t123"),
        "/opt/browser",
        undefined,
        { session: "web", pane: "%8" },
        {},
        "/tmp",
        {},
      ),
    ).toThrow("does not belong");
  });
  it.each([
    { split: "left" },
    { size: "5" },
    { size: "50;true" },
    { window: true, size: "30" },
    { pane: "pane" },
    { session: "name:window" },
  ])("rejects invalid options %j", (options) => {
    expect(() => validateBrowserOpen(undefined, options)).toThrow();
  });
  it.each(["--ssh", "https://example.com\n", ""])("rejects invalid URL %j", (url) => {
    expect(() => validateBrowserOpen(url, {})).toThrow();
  });
  it("does not fall back when an explicit browser is unavailable", () => {
    expect(() =>
      resolveTerminalBrowser({
        TMUX_IDE_TERMINAL_BROWSER_BIN: "/does-not-exist",
        PATH: process.env.PATH,
      }),
    ).toThrow("absolute executable");
    expect(() => resolveTerminalBrowser({ PATH: ".:relative" })).toThrow("not installed");
  });
});
