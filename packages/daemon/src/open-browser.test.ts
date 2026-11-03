import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  NO_NATIVE_CONTROLS_NOTICE,
  createBrowserPane,
  nativeControlsNotice,
  openBrowser,
  resolveTerminalBrowser,
  validateBrowserOpen,
} from "./open-browser.ts";

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
    expect(() => resolveTerminalBrowser({ PATH: ".:relative" }, "linux")).toThrow("not installed");
  });
});

describe("managed native browser discovery", () => {
  it("prefers the installed app browser while preserving explicit overrides and PATH fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "tmi-browser-discovery-"));
    const bundled = join(
      home,
      "Library/Application Support/tmux-ide/native-alpha/TmuxIDE.app/Contents/Resources/browser/terminal-browser",
    );
    const pathBrowser = join(home, "bin", "terminal-browser");
    const env = { HOME: home, PATH: dirname(pathBrowser) };
    try {
      for (const executable of [bundled, pathBrowser]) {
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      }
      expect(resolveTerminalBrowser(env, "darwin")).toBe(realpathSync(bundled));
      expect(
        resolveTerminalBrowser({ ...env, TMUX_IDE_TERMINAL_BROWSER_BIN: pathBrowser }, "darwin"),
      ).toBe(realpathSync(pathBrowser));
      expect(() =>
        resolveTerminalBrowser({ ...env, TMUX_IDE_TERMINAL_BROWSER_BIN: "/absent" }, "darwin"),
      ).toThrow("absolute executable");
      expect(resolveTerminalBrowser(env, "linux")).toBe(realpathSync(pathBrowser));
      rmSync(bundled);
      expect(resolveTerminalBrowser(env, "darwin")).toBe(realpathSync(pathBrowser));
      rmSync(pathBrowser);
      expect(() => resolveTerminalBrowser(env, "darwin")).toThrow("not installed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("native controls notice", () => {
  const bundled =
    "/Users/u/Library/Application Support/tmux-ide/native-alpha/TmuxIDE.app/Contents/Resources/browser/terminal-browser";
  const standalone = "/Users/u/.local/share/terminal-browser/app/bin/terminal-browser";
  const control = '{"version":1,"pid":7,"socket":"/tmp/b.sock","instance":"i","pane":"%9"}';
  // The pane's @tmux_ide_browser_control after each read (the last value repeats),
  // on a fake clock that only sleeps move.
  function probe(values: string[], options: { throws?: boolean } = {}) {
    const reads: string[][] = [];
    let clock = 0;
    const run = (args: readonly string[]) => {
      reads.push([...args]);
      if (options.throws) throw new Error("can't find pane: %9");
      return `${values[Math.min(reads.length - 1, values.length - 1)]}\n`;
    };
    const wait = {
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
    };
    return { run, wait, reads, elapsed: () => clock };
  }

  it("says nothing once the browser publishes its controls", async () => {
    const p = probe(["", "", control]);
    expect(await nativeControlsNotice(p.run, "%9", standalone, p.wait)).toBeNull();
    expect(p.reads[0]).toEqual([
      "display-message",
      "-p",
      "-t",
      "%9",
      "#{@tmux_ide_browser_control}",
    ]);
    expect(p.reads).toHaveLength(3);
  });

  it("prints the notice when a standalone browser never publishes controls", async () => {
    const p = probe([""]);
    expect(await nativeControlsNotice(p.run, "%9", standalone, p.wait)).toBe(
      NO_NATIVE_CONTROLS_NOTICE,
    );
    expect(p.elapsed()).toBeGreaterThanOrEqual(2000);
    expect(p.elapsed()).toBeLessThan(2250);
  });

  it("never reports a browser bundled in the native app, even a slow one", async () => {
    const p = probe([""]);
    expect(await nativeControlsNotice(p.run, "%9", bundled, p.wait)).toBeNull();
    expect(p.reads).toHaveLength(0);
    expect(p.elapsed()).toBe(0);
  });

  it("bounds the wait by wall-clock time when tmux answers slowly", async () => {
    // Each read blocks for 400 ms, as on a loaded machine; the real clock and sleep.
    const slow = () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return "\n";
    };
    const started = Date.now();
    expect(await nativeControlsNotice(slow, "%9", standalone)).toBe(NO_NATIVE_CONTROLS_NOTICE);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("names the native app in one line", () => {
    expect(NO_NATIVE_CONTROLS_NOTICE).not.toContain("\n");
    expect(NO_NATIVE_CONTROLS_NOTICE).toMatch(/native app/u);
    expect(NO_NATIVE_CONTROLS_NOTICE).toMatch(/back\/forward\/reload/u);
  });

  it("stays quiet about controls when the pane is already gone", async () => {
    const p = probe([""], { throws: true });
    expect(await nativeControlsNotice(p.run, "%9", standalone, p.wait)).toBeNull();
  });

  it("openBrowser prints the notice once for a standalone browser and returns the pane", async () => {
    for (const [executable, expected] of [
      [standalone, [NO_NATIVE_CONTROLS_NOTICE]],
      [bundled, []],
    ] as const) {
      const p = probe([""]);
      const lines: string[] = [];
      const pane = { pane: "%9", session: "$2", window: "@4", status: "created" as const };
      const result = await openBrowser(
        "https://example.com",
        {},
        {
          executable: () => executable,
          create: () => ({ result: pane, run: p.run }),
          notice: (line) => lines.push(line),
          wait: p.wait,
        },
      );
      expect(result).toEqual(pane);
      expect(lines).toEqual(expected);
    }
  });
});
