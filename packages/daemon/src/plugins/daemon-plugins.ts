/**
 * How the canonical daemon creates its plugin supervisor.
 */
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/log.ts";
import { stateHome } from "../lib/state-home.ts";
import { appendPluginLog, pluginLogPath } from "./plugin-log.ts";
import { PluginSupervisor, secretEnvValues } from "./supervisor.ts";

/** `TMUX_IDE_PLUGINS=0` turns plugins off for a daemon. */
export function pluginsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TMUX_IDE_PLUGINS !== "0";
}

/**
 * The argv that starts the plugin host. In the published CLI every module is
 * bundled into `bin/cli.js`, which starts the host with `__plugin-host`.
 * From source, the host entry sits next to this file and inherits the
 * runtime's loader flags (tsx under Node; Bun runs TypeScript directly).
 */
export function resolvePluginHostCommand(
  here: string = fileURLToPath(import.meta.url),
  runtime: { execPath: string; execArgv: readonly string[] } = process,
): string[] {
  if (basename(here) === "cli.js") return [runtime.execPath, here, "__plugin-host"];
  const entry = join(dirname(here), "host", `entry${extname(here)}`);
  return [runtime.execPath, ...runtime.execArgv, entry];
}

export function createDaemonPluginSupervisor(options: {
  productVersion: string;
  /** Daemon credentials that must never reach a plugin log or `lua run` output. */
  secrets: readonly (string | null | undefined)[];
  home?: string;
}): PluginSupervisor {
  const secrets = options.secrets.filter((secret): secret is string => typeof secret === "string");
  const home = options.home ?? stateHome();
  const logPath = pluginLogPath(home);
  return new PluginSupervisor({
    stateHome: home,
    productVersion: options.productVersion,
    hostCommand: resolvePluginHostCommand(),
    secrets: () => [...secrets, ...secretEnvValues()],
    onLog: (entry) => {
      appendPluginLog(logPath, entry);
      logger[entry.level](`plugin.${entry.plugin}`, entry.message, entry.fields);
    },
  });
}
