import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { appSettingsPath } from "../lib/app-settings.ts";
import { defaultControlSocketPath } from "../control/server.ts";
import { createHostCallHandler } from "./host-calls.ts";
import {
  daemonHostCallDependencies,
  daemonPrivateFiles,
  pluginsEnabled,
  resolveCliCommand,
  resolvePluginHostCommand,
  tmuxSocketDirs,
} from "./daemon-plugins.ts";

describe("resolvePluginHostCommand", () => {
  it("starts the bundled CLI with the hidden host command", () => {
    expect(
      resolvePluginHostCommand("/usr/lib/node_modules/tmux-ide/bin/cli.js", {
        execPath: "/usr/bin/node",
        execArgv: ["--inspect"],
      }),
    ).toEqual(["/usr/bin/node", "/usr/lib/node_modules/tmux-ide/bin/cli.js", "__plugin-host"]);
  });

  it("starts the host entry next to the source or build output with the runtime's loader flags", () => {
    expect(
      resolvePluginHostCommand("/repo/packages/daemon/src/plugins/daemon-plugins.ts", {
        execPath: "/usr/bin/node",
        execArgv: ["--import", "tsx"],
      }),
    ).toEqual([
      "/usr/bin/node",
      "--import",
      "tsx",
      "/repo/packages/daemon/src/plugins/host/entry.ts",
    ]);
    expect(
      resolvePluginHostCommand("/repo/packages/daemon/dist/plugins/daemon-plugins.js", {
        execPath: "/usr/bin/node",
        execArgv: [],
      }),
    ).toEqual(["/usr/bin/node", "/repo/packages/daemon/dist/plugins/host/entry.js"]);
  });
});

describe("pluginsEnabled", () => {
  it("is on unless TMUX_IDE_PLUGINS=0", () => {
    expect(pluginsEnabled({})).toBe(true);
    expect(pluginsEnabled({ TMUX_IDE_PLUGINS: "1" })).toBe(true);
    expect(pluginsEnabled({ TMUX_IDE_PLUGINS: "0" })).toBe(false);
  });
});

describe("daemonPrivateFiles", () => {
  it("names the daemon record and claim where they live, consent, stores and app settings", () => {
    expect(daemonPrivateFiles("/h", "/registry/daemon.json")).toEqual([
      "/registry/daemon.json",
      join("/registry", "daemon.claim"),
      join("/h", "consent"),
      join("/h", "plugin-store"),
      appSettingsPath(),
    ]);
  });

  it("follows TMUX_IDE_DAEMON_INFO_DIR by default", () => {
    const before = process.env.TMUX_IDE_DAEMON_INFO_DIR;
    process.env.TMUX_IDE_DAEMON_INFO_DIR = "/elsewhere/info";
    try {
      expect(daemonPrivateFiles("/h")[0]).toBe(join("/elsewhere/info", "daemon.json"));
    } finally {
      if (before === undefined) delete process.env.TMUX_IDE_DAEMON_INFO_DIR;
      else process.env.TMUX_IDE_DAEMON_INFO_DIR = before;
    }
  });
});

describe("tmuxSocketDirs", () => {
  it("names the default directory and the daemon server's, never a broad one", async () => {
    expect(
      await tmuxSocketDirs(async () => "/var/run/tmux-sockets/main\n", { TMUX_TMPDIR: "/t" }, 501),
    ).toEqual(["/t/tmux-501", "/tmp/tmux-501", "/var/run/tmux-sockets"]);
    expect(await tmuxSocketDirs(async () => "/tmp/odd.sock\n", {}, 501)).toEqual(["/tmp/tmux-501"]);
    expect(
      await tmuxSocketDirs(
        async () => {
          throw new Error("no server");
        },
        {},
        501,
      ),
    ).toEqual(["/tmp/tmux-501"]);
  });
});

describe("resolveCliCommand", () => {
  it("runs the bundled CLI, or bin/cli.ts under the loader from source", () => {
    expect(resolveCliCommand("/pkg/bin/cli.js", { execPath: "/node", execArgv: ["--x"] })).toEqual([
      "/node",
      "/pkg/bin/cli.js",
    ]);
    expect(
      resolveCliCommand("/repo/packages/daemon/src/plugins/daemon-plugins.ts", {
        execPath: "/node",
        execArgv: ["--import", "tsx"],
      }),
    ).toEqual(["/node", "--import", "tsx", "/repo/bin/cli.ts"]);
  });
});

describe("daemonHostCallDependencies", () => {
  it("keeps programs without panes.send from the tmux socket directories", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
    }));
    const deps = daemonHostCallDependencies({
      home: "/h",
      // The daemon's own tmux server lives in a socket directory of its own.
      tmux: async (args) => (args[0] === "list-sessions" ? "/var/run/tmux-daemon/main\n" : ""),
      secretSet: () => new Set(),
    });
    const calls = createHostCallHandler({ ...deps, exec });
    const run = (panes: boolean) =>
      calls.handle(
        { plugin: "p", capabilities: { exec: ["echo"], shell: false, panes } },
        "_exec",
        [{ cmd: "echo" }],
      );
    await run(false);
    const expected = await tmuxSocketDirs(async () => "/var/run/tmux-daemon/main\n");
    expect(expected).toContain("/var/run/tmux-daemon");
    expect(exec).toHaveBeenLastCalledWith(
      { cmd: "echo" },
      expect.objectContaining({ sandbox: expect.objectContaining({ tmuxSockets: expected }) }),
    );
    await run(true);
    expect(exec).toHaveBeenLastCalledWith(
      { cmd: "echo" },
      expect.objectContaining({ sandbox: expect.objectContaining({ tmuxSockets: [] }) }),
    );
  });

  it("keeps programs from the control socket and the daemon's port", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
    }));
    const deps = daemonHostCallDependencies({
      home: "/h",
      endpoint: () => ({ baseUrl: "http://127.0.0.1:47123", ownerToken: "owner-token" }),
      tmux: async () => "/tmp/tmux-501/default\n",
      secretSet: () => new Set(),
    });
    expect(deps.privateSockets?.()).toEqual([defaultControlSocketPath()]);
    const calls = createHostCallHandler({ ...deps, exec });
    await calls.handle(
      { plugin: "p", capabilities: { exec: ["echo"], shell: false, panes: false } },
      "_exec",
      [{ cmd: "echo" }],
    );
    expect(exec).toHaveBeenCalledWith(
      { cmd: "echo" },
      expect.objectContaining({
        sandbox: expect.objectContaining({
          stateHome: "/h",
          privateSockets: [defaultControlSocketPath()],
          daemonPorts: [47123],
          unreadable: daemonPrivateFiles("/h"),
        }),
      }),
    );
  });
});
