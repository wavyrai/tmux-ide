/**
 * How the canonical daemon creates its plugin supervisor.
 */
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appSettingsPath } from "../lib/app-settings.ts";
import { getCanonicalDaemonInfoPath } from "../lib/canonical-daemon.ts";
import { logger } from "../lib/log.ts";
import { stateHome } from "../lib/state-home.ts";
import { appendPluginLog, pluginLogPath } from "./plugin-log.ts";
import { createHostCallHandler, type DaemonEndpoint, type NotifyLevel } from "./host-calls.ts";
import { DEFAULT_PLUGIN_LIMITS } from "./protocol.ts";
import { minimalHostEnv, PluginSupervisor, secretEnvValues } from "./supervisor.ts";

/**
 * `ide.notify`: a short message in the status line of every attached tmux
 * client (and so in the TUI, which is one), prefixed with the plugin name.
 * `#` is doubled so tmux does not expand formats in plugin text.
 */
export async function notifyTmuxClients(
  tmux: (args: readonly string[]) => Promise<string>,
  plugin: string,
  text: string,
  level: NotifyLevel,
): Promise<void> {
  const prefix = level === "info" ? "" : `${level}: `;
  const message = `${plugin}: ${prefix}${text}`.replace(/#/gu, "##");
  const clients = (await tmux(["list-clients", "-F", "#{client_name}"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await Promise.all(
    clients.map((client) =>
      tmux(["display-message", "-c", client, "-d", "4000", message]).catch(() => ""),
    ),
  );
}

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

/**
 * Files programs from plugins may not read: the daemon record (its port and
 * owner token), the app settings (the remote-access token), the consent
 * records and every plugin's store.
 */
export function daemonPrivateFiles(
  home: string,
  daemonInfoPath: string = getCanonicalDaemonInfoPath(),
): string[] {
  // Prefixes: daemon.json also covers its .tmp and .retired siblings, and the
  // record follows TMUX_IDE_DAEMON_INFO_DIR / the registry dir, wherever it is.
  const infoDir = dirname(daemonInfoPath);
  return [
    daemonInfoPath,
    join(infoDir, "daemon.claim"),
    join(home, "consent"),
    join(home, "plugin-store"),
    appSettingsPath(),
  ];
}

export function createDaemonPluginSupervisor(options: {
  productVersion: string;
  /** Daemon credentials that must never reach a plugin log or `lua run` output. */
  secrets: readonly (string | null | undefined)[];
  /** Called when plugin actions change, to invalidate the command catalog. */
  onCatalogChange?: () => void;
  /** The daemon's own HTTP endpoint, once it listens; plugins' pane calls go through it. */
  endpoint?: () => DaemonEndpoint | null;
  /** Run tmux against the daemon's server. */
  tmux?: (args: readonly string[]) => Promise<string>;
  home?: string;
}): PluginSupervisor {
  const secrets = options.secrets.filter((secret): secret is string => typeof secret === "string");
  const home = options.home ?? stateHome();
  const logPath = pluginLogPath(home);
  const secretSet = () =>
    new Set([...secrets, ...secretEnvValues()].filter((secret) => secret.length >= 8));
  const tmux = options.tmux ?? (async () => Promise.reject(new Error("tmux is unavailable")));
  const calls = createHostCallHandler({
    stateHome: home,
    endpoint: options.endpoint ?? (() => null),
    tmux,
    baseEnv: () => minimalHostEnv(),
    secrets: secretSet,
    notify: (plugin, text, level) => notifyTmuxClients(tmux, plugin, text, level),
    unreadable: () => daemonPrivateFiles(home),
    execMaxTimeoutMs: DEFAULT_PLUGIN_LIMITS.wallClockMs,
  });
  return new PluginSupervisor({
    calls,
    stateHome: home,
    productVersion: options.productVersion,
    hostCommand: resolvePluginHostCommand(),
    secrets: () => [...secrets, ...secretEnvValues()],
    ...(options.onCatalogChange ? { onCatalogChange: options.onCatalogChange } : {}),
    onLog: (entry) => {
      appendPluginLog(logPath, entry);
      logger[entry.level](`plugin.${entry.plugin}`, entry.message, entry.fields);
    },
  });
}
