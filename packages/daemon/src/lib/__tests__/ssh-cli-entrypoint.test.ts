import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
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
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input));
  if(url.hostname==='127.0.0.1'&&url.port==='43333'){
    const info=JSON.parse(fs.readFileSync(process.env.TEST_DAEMON_RECORD,'utf8'));
    fs.appendFileSync(process.env.TEST_DAEMON_PROBES,url.pathname+'\\n');
    if(url.pathname==='/identity')return Response.json({ok:true,...info,...(process.env.TEST_LOCAL_IDENTITY_MISMATCH?{instanceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}:{})});
    if(url.pathname==='/api/v1/tmux-servers')return process.env.TEST_OLD_SERVER_API?new Response('Not Found',{status:404}):Response.json({version:1,servers:[]});
    if(url.pathname==='/health')return Response.json({ok:true,protocolVersion:info.protocolVersion,productVersion:info.productVersion,uptime:1});
    throw new Error('unexpected local daemon request');
  }
  return originalFetch(input,options);
};
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
    TEST_DAEMON_RECORD: join(state, "daemon.json"),
    TEST_DAEMON_PROBES: join(directory, "daemon-probes.txt"),
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
function installExistingLocalDaemon() {
  writeFileSync(
    environment.TEST_DAEMON_RECORD!,
    JSON.stringify({
      pid: process.pid,
      port: 43333,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: JSON.parse(
        readFileSync(new URL("../../../../../package.json", import.meta.url), "utf8"),
      ).version,
      instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startedAt: "2026-09-09T10:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "private-test-token",
    }),
    { mode: 0o600 },
  );
}
function expectExistingLocalDaemonVerified() {
  expect(existsSync(forbiddenPath)).toBe(false);
  expect(readFileSync(environment.TEST_DAEMON_PROBES!, "utf8")).toContain("/identity");
  expect(readFileSync(environment.TEST_DAEMON_PROBES!, "utf8")).toContain("/health");
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
  it("verifies the local daemon and forwards the selected remote session without hosted tmux", () => {
    installExistingLocalDaemon();
    const result = run(["app", "remote-session", "--ssh", "alice@build"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual([
      "app",
      "--target=remote-session",
      "--ssh=alice@build",
    ]);
    expectExistingLocalDaemonVerified();
  });
  it("forwards an explicit server scope and rejects an ambiguous machine choice", () => {
    installExistingLocalDaemon();
    const serverId = `tmux-server.${"a".repeat(32)}`;
    const result = run(["app", "main", "--server", serverId, "--ssh=build"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual([
      "app",
      "--target=main",
      `--server=${serverId}`,
      "--ssh=build",
    ]);
    const ambiguous = run(["app", "--server", serverId, "--ssh=build", "--ssh=dev"]);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toContain("at most one --ssh");
    expect(existsSync(forbiddenPath)).toBe(false);
  });
  it("keeps a local explicit server launch in the foreground despite detachable config", () => {
    installExistingLocalDaemon();
    const serverId = `tmux-server.${"b".repeat(32)}`;
    const result = run(["app", "main", "--server", serverId]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual([
      "app",
      "--target=main",
      `--server=${serverId}`,
    ]);
    expect(existsSync(forbiddenPath)).toBe(false);
    expect(run(["app", "--server", serverId, "--hosted"]).status).toBe(2);
    expect(run(["app", "--server", serverId, "--headless"]).status).toBe(2);
  });
  it("lists server registrations through the authenticated canonical daemon and reports old capability", () => {
    installExistingLocalDaemon();
    const result = run(["servers", "list", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, servers: [] });
    expectExistingLocalDaemonVerified();
    environment.TEST_OLD_SERVER_API = "1";
    const old = run(["servers", "add", "--socket-name", "work", "--json"]);
    expect(old.status).not.toBe(0);
    expect(old.stderr + old.stdout).toContain("does not support tmux server selection");
    expect(existsSync(forbiddenPath)).toBe(false);
  });
  it("forwards multiple SSH machines independently of detachable configuration", () => {
    installExistingLocalDaemon();
    const result = run(["app", "--ssh=build", "--ssh=dev"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual([
      "app",
      "--ssh=build",
      "--ssh=dev",
    ]);
    expectExistingLocalDaemonVerified();
  });
  it("keeps explicit SSH machines launchable when local daemon identity is incompatible", () => {
    installExistingLocalDaemon();
    environment.TEST_LOCAL_IDENTITY_MISMATCH = "1";
    const result = run(["app", "--ssh=build"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Local sessions are unavailable; continuing with SSH machines");
    expect(result.stderr).toContain("tmux-ide doctor");
    expect(result.stderr).not.toContain("private-test-token");
    expect(JSON.parse(readFileSync(launchedPath, "utf8"))).toEqual(["app", "--ssh=build"]);
    expect(existsSync(forbiddenPath)).toBe(false);
  });
  it("keeps a local-only launch fail-fast when its daemon identity is incompatible", () => {
    installExistingLocalDaemon();
    environment.TEST_LOCAL_IDENTITY_MISMATCH = "1";
    const result = run(["app"]);
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(existsSync(launchedPath)).toBe(false);
    expect(existsSync(forbiddenPath)).toBe(false);
    expect(result.stderr).not.toContain("continuing with SSH machines");
  });
});
