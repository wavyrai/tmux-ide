import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { appSettingsPath } from "../lib/app-settings.ts";
import {
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
