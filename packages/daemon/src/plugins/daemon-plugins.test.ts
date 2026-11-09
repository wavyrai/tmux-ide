import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { appSettingsPath } from "../lib/app-settings.ts";
import { daemonPrivateFiles, pluginsEnabled, resolvePluginHostCommand } from "./daemon-plugins.ts";

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
  it("names the daemon record, its claim, consent, plugin stores and the app settings", () => {
    expect(daemonPrivateFiles("/h")).toEqual([
      join("/h", "daemon.json"),
      join("/h", "daemon.claim"),
      join("/h", "consent"),
      join("/h", "plugin-store"),
      appSettingsPath(),
    ]);
  });
});
