import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../../../../bin/cli.js", import.meta.url));
let directory: string;
let environment: NodeJS.ProcessEnv;
let forbiddenPath: string;
let launchedPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tmux-ide-ssh-cli-"));
  const home = join(directory, "home");
  const state = join(directory, "state");
  const tools = join(directory, "tools");
  for (const path of [home, state, tools]) mkdirSync(path, { recursive: true, mode: 0o700 });
  forbiddenPath = join(directory, "forbidden.jsonl");
  launchedPath = join(directory, "launched.json");
  const preload = join(directory, "guard.cjs");
  writeFileSync(
    preload,
    `
const cp=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
for(const method of ['spawn','execFileSync']) {
  const original=cp[method];
  cp[method]=function(binary,args,...rest) {
    if(path.basename(String(binary))==='tmux'||(Array.isArray(args)&&args.includes('--headless'))) {
      fs.appendFileSync(process.env.TEST_FORBIDDEN,JSON.stringify({binary,args})+'\\n');
      throw new Error('Hermetic SSH CLI test blocked a local mutation');
    }
    return original.call(this,binary,args,...rest);
  };
}
require('node:module').syncBuiltinESMExports();
`,
  );
  const tui = join(tools, "fake-tui");
  writeFileSync(
    tui,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.TEST_LAUNCHED,JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({ app: { detachable: true } }));
  environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TMUX_IDE_") && !["TMUX", "TMUX_PANE", "NODE_OPTIONS"].includes(key),
    ),
  );
  Object.assign(environment, {
    HOME: home,
    PATH: tools,
    NO_COLOR: "1",
    NODE_OPTIONS: `--require=${preload}`,
    TMUX_IDE_HOME: state,
    TMUX_IDE_DAEMON_INFO_DIR: state,
    TMUX_IDE_REGISTRY_DIR: state,
    TMUX_IDE_SETTINGS_DIR: state,
    TMUX_IDE_CONFIG: config,
    TMUX_IDE_TUI_BIN: tui,
    TEST_FORBIDDEN: forbiddenPath,
    TEST_LAUNCHED: launchedPath,
  });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 5000,
  });
}
function expectNoLocalMutation() {
  expect(existsSync(forbiddenPath)).toBe(false);
  expect(existsSync(join(directory, "state", "daemon.json"))).toBe(false);
}
describe("SSH app CLI entry", () => {
  it("rejects non-app commands and headless before any local mutation or TUI launch", () => {
    for (const args of [
      ["init", "--ssh=build"],
      ["start", "--ssh=build"],
      ["--headless", "--ssh=build"],
      ["app", "--headless", "--ssh=build"],
    ]) {
      const result = run(args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--ssh is supported only by tmux-ide app");
      expectNoLocalMutation();
      expect(existsSync(launchedPath)).toBe(false);
      expect(existsSync(join(directory, ".tmux-ide", "workspace.yml"))).toBe(false);
    }
  });
  it("validates aliases and rejects hosted flags before launching", () => {
    for (const args of [
      ["app", "--ssh=host;bad"],
      ["app", "--ssh="],
      ["app", "--ssh=build", "--hosted"],
      ["app", "--ssh=build", "--detachable"],
    ]) {
      const result = run(args);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expectNoLocalMutation();
      expect(existsSync(launchedPath)).toBe(false);
    }
  });
  it("forwards the selected session and SSH alias without starting local daemon or hosted tmux", () => {
    const result = run(["app", "remote-session", "--ssh", "alice@build"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual([
      "app",
      "--target=remote-session",
      "--ssh=alice@build",
    ]);
    expectNoLocalMutation();
  });
  it("forwards the equals form for remote Home independently of detachable configuration", () => {
    const result = run(["app", "--ssh=build"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual(["app", "--ssh=build"]);
    expectNoLocalMutation();
  });
});
