import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { resolveTmuxExecutable } from "./lib/tmux-client-execution.ts";

it("the built CLI creates an isolated browser pane with literal argv and its own identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tmi-open-"));
  const socket = join(directory, "tmux.sock");
  const report = join(directory, "report.json");
  const browser = join(directory, "browser");
  const tmux = resolveTmuxExecutable();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("TMUX") || key.startsWith("PIXEL_")) delete env[key];
  const run = (...args: string[]) =>
    execFileSync(tmux, ["-S", socket, ...args], { env, encoding: "utf8" }).trim();
  writeFileSync(
    browser,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({args:process.argv.slice(2),pane:process.env.TMUX_PANE,tmux:process.env.TMUX,browserTmux:process.env.TMUX_IDE_BROWSER_TMUX,cwd:process.cwd()}));setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  try {
    run("new-session", "-d", "-s", "browser-test", "-x", "120", "-y", "40");
    const identity = run(
      "display-message",
      "-p",
      "-t",
      "=browser-test:",
      "#{pid}\t#{session_id}\t#{pane_id}",
    ).split("\t");
    const url = "https://example.com/?value=$(touch SHOULD_NOT_EXIST); spaces&quote='yes'";
    const commandEnvironment = {
      ...env,
      TMUX: `${socket},${identity[0]},${identity[1]!.slice(1)}`,
      TMUX_PANE: identity[2],
      TMUX_IDE_TMUX_BIN: tmux,
      TMUX_IDE_TERMINAL_BROWSER_BIN: browser,
    };
    const cli = resolve("../../bin/cli.js");
    const launch = (args: string[], overrides = {}) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, "open", ...args, "--json"], {
          env: { ...commandEnvironment, ...overrides },
          cwd: directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    const result = launch([url]);
    let observed;
    for (let attempt = 0; attempt < 250; attempt++) {
      try {
        observed = JSON.parse(readFileSync(report, "utf8"));
        break;
      } catch {
        await setTimeout(20);
      }
    }
    expect(observed).toBeDefined();
    expect(observed.args).toEqual(["open", url, "--no-merge"]);
    expect(observed.pane).toBe(result.pane);
    expect(realpathSync(observed.browserTmux)).toBe(realpathSync(tmux));
    expect(observed.pane).not.toBe(identity[2]);
    expect(realpathSync(observed.cwd)).toBe(realpathSync(directory));
    expect(result.status).toBe("created");
    expect(run("list-panes", "-t", "=browser-test:", "-F", "#{pane_id}").split("\n")).toHaveLength(
      2,
    );
    rmSync(report);
    const separate = launch(["--session", "browser-test", "--window"], { TMUX_PANE: undefined });
    expect(separate.window).not.toBe(result.window);
    for (let attempt = 0; attempt < 250; attempt++) {
      try {
        observed = JSON.parse(readFileSync(report, "utf8"));
        break;
      } catch {
        await setTimeout(20);
      }
    }
    expect(observed.pane).toBe(separate.pane);
    expect(observed.args).toEqual(["open", "--no-merge"]);
    if (process.platform === "darwin") {
      const bundled = join(
        directory,
        "Library/Application Support/tmux-ide/native-alpha/TmuxIDE.app/Contents/Resources/browser/terminal-browser",
      );
      mkdirSync(dirname(bundled), { recursive: true });
      writeFileSync(bundled, readFileSync(browser), { mode: 0o700 });
      rmSync(report);
      const managed = launch([url, "--window"], {
        HOME: directory,
        TMUX_IDE_TERMINAL_BROWSER_BIN: undefined,
      });
      observed = undefined;
      for (let attempt = 0; attempt < 250; attempt++) {
        try {
          observed = JSON.parse(readFileSync(report, "utf8"));
          break;
        } catch {
          await setTimeout(20);
        }
      }
      expect(observed?.pane).toBe(managed.pane);
      expect(observed?.args).toEqual(["open", url, "--no-merge"]);
    }
    const before = run("list-panes", "-a", "-F", "#{pane_id}");
    expect(() => launch(["--unknown-option"])).toThrow();
    expect(() => launch([], { TMUX_IDE_TERMINAL_BROWSER_BIN: "/missing-browser" })).toThrow();
    expect(run("list-panes", "-a", "-F", "#{pane_id}")).toBe(before);
  } finally {
    try {
      run("kill-server");
    } catch {
      /* Already stopped. */
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
