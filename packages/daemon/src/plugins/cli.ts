/**
 * `tmux-ide lua …` and `tmux-ide plugin …`.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { grantConsent, hashPluginDirectory, revokeConsent } from "./consent.ts";
import { discoverPlugins, type PluginAwaitingConsent } from "./discovery.ts";
import { API_ENTRIES, findApiEntry, suggestApiEntries, type ApiEntry } from "./api-table.ts";
import {
  formatPluginLogEntry,
  pluginLogPath,
  readPluginLog,
  type PluginLogEntry,
} from "./plugin-log.ts";
import { PLUGIN_API_VERSION } from "./protocol.ts";
import type { LuaRunResult, PluginSupervisorStatus } from "./supervisor.ts";

export interface PluginCliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly readFile: (path: string) => string;
  readonly readStdin: () => string;
  /** Resolves the running daemon, or null when there is none. */
  readonly daemon: () => Promise<{ baseUrl: string; ownerToken: string | null } | null>;
  readonly fetch: typeof fetch;
  readonly stateHome: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** Whether a person can answer a question on this terminal. */
  readonly interactive: () => boolean;
  readonly ask: (question: string) => Promise<string>;
  /** `$TMUX_PANE` when the CLI runs inside a tmux pane. */
  readonly tmuxPane: () => string | undefined;
  /** Run a built-in daemon action through the typed action route. */
  readonly dispatchBuiltin: (name: string, input: unknown) => Promise<unknown>;
}

export class PluginCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "PluginCliError";
    this.exitCode = exitCode;
  }
}

export const LUA_USAGE = `Usage:
  tmux-ide lua run <file | -> [--timeout <ms>] [--json]   Run a Lua file once against the daemon
  tmux-ide lua run -e <code> [--timeout <ms>] [--json]     Run Lua source given inline
  tmux-ide lua api [--json]                                List the Lua API (version ${PLUGIN_API_VERSION})
  tmux-ide lua describe <name> [--json]                    Describe one API entry, e.g. ide.log.info`;

export const PLUGIN_USAGE = `Usage:
  tmux-ide plugin list [--json]             Show the plugin host and every plugin's state
  tmux-ide plugin reload [name] [--json]    Discover plugins again and reload all, or one
  tmux-ide plugin logs [name] [-n <lines>] [-f]   Show ~/.tmux-ide/logs/plugins.log
  tmux-ide plugin consent <name> [--yes]    Review a plugin's permissions and allow it to run
  tmux-ide plugin revoke <name>             Stop a plugin and withdraw consent`;

export async function callDaemon<T>(
  io: PluginCliIo,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const daemon = await io.daemon();
  if (!daemon)
    throw new PluginCliError(
      "The tmux-ide daemon is not running and could not be started. Run `tmux-ide doctor`.",
    );
  let response: Response;
  try {
    response = await io.fetch(`${daemon.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(daemon.ownerToken ? { Authorization: `Bearer ${daemon.ownerToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new PluginCliError(`Could not reach the daemon: ${(error as Error).message}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PluginCliError(`The daemon answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new PluginCliError(message);
  }
  return payload as T;
}

export function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function formatRunResult(result: LuaRunResult): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const log of result.logs) {
    if (log.level === "info") stdout.push(log.message);
    else stderr.push(`${log.level}: ${log.message}`);
  }
  if (result.ok) {
    for (const value of result.values ?? []) stdout.push(formatValue(value));
  } else {
    stderr.push(`error: ${result.error ?? "unknown error"}`);
  }
  return { stdout, stderr };
}

export function formatApiList(entries: readonly ApiEntry[] = API_ENTRIES): string {
  const width = Math.max(...entries.map((entry) => entry.signature.length));
  const lines = [`tmux-ide Lua API ${PLUGIN_API_VERSION}`, ""];
  for (const entry of entries) {
    const tag = entry.stability === "stable" ? "" : ` [${entry.stability}]`;
    lines.push(`  ${entry.signature.padEnd(width)}  ${entry.summary}${tag}`);
  }
  lines.push("", "More: tmux-ide lua describe <name>");
  return lines.join("\n");
}

export function formatApiEntry(entry: ApiEntry): string {
  const lines = [entry.signature, "", entry.summary];
  if (entry.details) lines.push("", entry.details);
  if (entry.errors?.length) lines.push("", `Errors: ${entry.errors.join(", ")}`);
  if (entry.example) lines.push("", "Example:", `  ${entry.example}`);
  lines.push("", `Since API ${entry.since}, ${entry.stability}.`);
  return lines.join("\n");
}

export function formatPluginStatus(status: PluginSupervisorStatus): string {
  const lines = [
    status.host.running
      ? `Plugin host: running (pid ${status.host.pid}, ${status.host.restarts} restarts)`
      : "Plugin host: not running",
  ];
  if (status.plugins.length === 0) {
    lines.push("No plugins. Add ~/.tmux-ide/init.lua or a directory in ~/.tmux-ide/plugins/.");
    return lines.join("\n");
  }
  const width = Math.max(...status.plugins.map((plugin) => plugin.name.length));
  for (const plugin of status.plugins) {
    const memory =
      plugin.memoryBytes !== undefined
        ? ` ${(plugin.memoryBytes / (1024 * 1024)).toFixed(1)} MiB`
        : "";
    lines.push(`  ${plugin.name.padEnd(width)}  ${plugin.state}${memory}`);
    if (plugin.error) lines.push(`  ${" ".repeat(width)}  ${plugin.error.split("\n")[0]}`);
  }
  return lines.join("\n");
}

async function luaCli(argv: readonly string[], io: PluginCliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      eval: { type: "string", short: "e" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(LUA_USAGE);
    return 0;
  }
  if (!sub) throw new PluginCliError(LUA_USAGE, 2);
  switch (sub) {
    case "api":
      io.out(
        values.json
          ? JSON.stringify({ api: PLUGIN_API_VERSION, entries: API_ENTRIES }, null, 2)
          : formatApiList(),
      );
      return 0;
    case "describe": {
      const name = positionals[0];
      if (!name) throw new PluginCliError(`Name an entry to describe.\n${LUA_USAGE}`, 2);
      const entry = findApiEntry(name);
      if (!entry) {
        const close = suggestApiEntries(name).map((candidate) => candidate.name);
        throw new PluginCliError(
          `No API entry named '${name}'.${close.length ? ` Did you mean: ${close.join(", ")}?` : " See `tmux-ide lua api`."}`,
        );
      }
      io.out(values.json ? JSON.stringify(entry, null, 2) : formatApiEntry(entry));
      return 0;
    }
    case "run": {
      let code: string;
      let chunkName: string;
      if (values.eval !== undefined) {
        if (positionals.length > 0)
          throw new PluginCliError("Give either a file or -e, not both.", 2);
        code = values.eval;
        chunkName = "=(command line)";
      } else {
        const file = positionals[0];
        if (!file)
          throw new PluginCliError(`Name a file, - for stdin, or use -e.\n${LUA_USAGE}`, 2);
        code = file === "-" ? io.readStdin() : io.readFile(file);
        chunkName = file === "-" ? "=stdin" : `@${basename(file)}`;
      }
      let budgetMs: number | undefined;
      if (values.timeout !== undefined) {
        budgetMs = Number(values.timeout);
        if (!Number.isInteger(budgetMs) || budgetMs < 10 || budgetMs > 600_000)
          throw new PluginCliError(
            "--timeout must be a whole number of milliseconds from 10 to 600000.",
            2,
          );
      }
      const { result } = await callDaemon<{ result: LuaRunResult }>(io, "POST", "/api/v2/lua/run", {
        code,
        chunkName,
        ...(budgetMs !== undefined ? { budgetMs } : {}),
      });
      if (values.json) {
        io.out(JSON.stringify(result, null, 2));
      } else {
        const formatted = formatRunResult(result);
        for (const line of formatted.stdout) io.out(line);
        for (const line of formatted.stderr) io.err(line);
      }
      return result.ok ? 0 : 1;
    }
    default:
      throw new PluginCliError(`Unknown lua command '${sub}'.\n${LUA_USAGE}`, 2);
  }
}

async function followLog(
  path: string,
  plugin: string | undefined,
  io: PluginCliIo,
): Promise<never> {
  let offset = existsSync(path) ? statSync(path).size : 0;
  let pending = "";
  for (;;) {
    await io.sleep(500);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) continue;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      readSync(fd, buffer, 0, buffer.length, offset);
      offset = size;
      pending += buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as PluginLogEntry;
        if (!plugin || entry.plugin === plugin) io.out(formatPluginLogEntry(entry));
      } catch {
        // torn line
      }
    }
  }
}

export function describeForConsent(plugin: PluginAwaitingConsent): string {
  const { manifest } = plugin;
  const exec = manifest.capabilities.exec ?? [];
  const asks = [
    exec.length > 0 ? `run these programs: ${exec.join(", ")}` : null,
    manifest.capabilities.keys ? "add key bindings" : null,
    manifest.capabilities.sidebar ? "add rows to the sidebar" : null,
    manifest.capabilities.status ? "add status items" : null,
  ].filter((line): line is string => line !== null);
  return [
    `${manifest.name} ${manifest.version}${plugin.reason === "changed" ? " (changed since you last allowed it)" : ""}`,
    ...(manifest.description ? [manifest.description] : []),
    `Directory: ${plugin.path}`,
    `Content:   ${plugin.hash}`,
    "",
    "It asks to:",
    ...(asks.length > 0 ? asks.map((line) => `  - ${line}`) : ["  - nothing beyond logging"]),
    "",
    "Plugins run with your permissions, inside tmux-ide.",
  ].join("\n");
}

async function reloadAfterConsentChange(io: PluginCliIo, name: string): Promise<void> {
  try {
    const status = await callDaemon<PluginSupervisorStatus>(io, "POST", "/api/v2/plugins/reload", {
      name,
    });
    const plugin = status.plugins.find((candidate) => candidate.name === name);
    if (plugin)
      io.out(`${name}: ${plugin.state}${plugin.error ? ` (${plugin.error.split("\n")[0]})` : ""}`);
  } catch (error) {
    io.err(`The daemon will pick this up on its next reload (${(error as Error).message}).`);
  }
}

async function pluginCli(argv: readonly string[], io: PluginCliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      yes: { type: "boolean", short: "y" },
      lines: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(PLUGIN_USAGE);
    return 0;
  }
  if (!sub) throw new PluginCliError(PLUGIN_USAGE, 2);
  switch (sub) {
    case "list": {
      const status = await callDaemon<PluginSupervisorStatus>(io, "GET", "/api/v2/plugins");
      io.out(values.json ? JSON.stringify(status, null, 2) : formatPluginStatus(status));
      return 0;
    }
    case "reload": {
      const name = positionals[0];
      const status = await callDaemon<PluginSupervisorStatus>(
        io,
        "POST",
        "/api/v2/plugins/reload",
        name ? { name } : {},
      );
      io.out(values.json ? JSON.stringify(status, null, 2) : formatPluginStatus(status));
      const failed = status.plugins.some(
        (plugin) => (!name || plugin.name === name) && plugin.state !== "loaded",
      );
      return failed ? 1 : 0;
    }
    case "consent": {
      const name = positionals[0];
      if (!name) throw new PluginCliError(`Name the plugin to consent to.\n${PLUGIN_USAGE}`, 2);
      const home = io.stateHome();
      const discovery = discoverPlugins(home);
      if (discovery.specs.some((spec) => spec.name === name && spec.kind === "plugin")) {
        io.out(`${name} is already allowed to run.`);
        return 0;
      }
      const pending = discovery.awaitingConsent.find((plugin) => plugin.name === name);
      if (!pending) {
        const problem = discovery.problems.find((candidate) => candidate.name === name);
        throw new PluginCliError(
          problem
            ? `${name} cannot run: ${problem.error}`
            : `No plugin named '${name}' in ${home}/plugins.`,
        );
      }
      io.out(describeForConsent(pending));
      if (!values.yes) {
        if (!io.interactive())
          throw new PluginCliError("Not a terminal: pass --yes to consent without a prompt.", 2);
        const answer = (await io.ask("Allow this plugin to run? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          io.out("Not allowed. Nothing changed.");
          return 1;
        }
      }
      // Hash again: consent covers what is on disk now, not what was shown a moment ago.
      const hash = hashPluginDirectory(pending.path);
      if (hash !== pending.hash)
        throw new PluginCliError(`${name} changed while you were reviewing it. Run consent again.`);
      grantConsent(home, name, hash);
      io.out(`Allowed ${name}.`);
      await reloadAfterConsentChange(io, name);
      return 0;
    }
    case "revoke": {
      const name = positionals[0];
      if (!name) throw new PluginCliError(`Name the plugin to revoke.\n${PLUGIN_USAGE}`, 2);
      if (!revokeConsent(io.stateHome(), name)) {
        io.out(`${name} was not allowed to run. Nothing changed.`);
        return 0;
      }
      io.out(`Revoked ${name}.`);
      await reloadAfterConsentChange(io, name);
      return 0;
    }
    case "logs": {
      const path = pluginLogPath(io.stateHome());
      const plugin = positionals[0];
      const limit = values.lines !== undefined ? Number(values.lines) : 50;
      if (!Number.isInteger(limit) || limit < 0)
        throw new PluginCliError("-n must be a whole number.", 2);
      const entries = readPluginLog(path, { limit, ...(plugin ? { plugin } : {}) });
      for (const entry of entries)
        io.out(values.json ? JSON.stringify(entry) : formatPluginLogEntry(entry));
      if (values.follow) await followLog(path, plugin, io);
      return 0;
    }
    default:
      throw new PluginCliError(`Unknown plugin command '${sub}'.\n${PLUGIN_USAGE}`, 2);
  }
}

export async function runPluginCommandLine(
  command: "lua" | "plugin",
  argv: readonly string[],
  io: PluginCliIo,
): Promise<number> {
  try {
    return command === "lua" ? await luaCli(argv, io) : await pluginCli(argv, io);
  } catch (error) {
    if (error instanceof PluginCliError) {
      io.err(error.message);
      return error.exitCode;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      String((error as { code: unknown }).code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.err(`${error.message}\n${command === "lua" ? LUA_USAGE : PLUGIN_USAGE}`);
      return 2;
    }
    throw error;
  }
}

/** The real terminal, filesystem and daemon. */
export async function defaultPluginCliIo(): Promise<PluginCliIo> {
  const { resolveCanonicalDaemonEndpoint, cliBridgeFetch } =
    await import("../lib/cli-action-bridge.ts");
  const { stateHome } = await import("../lib/state-home.ts");
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    readFile: (path) => readFileSync(path, "utf8"),
    readStdin: () => readFileSync(0, "utf8"),
    daemon: () => resolveCanonicalDaemonEndpoint(),
    fetch: (...args) => cliBridgeFetch()(...args),
    stateHome,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    tmuxPane: () => process.env.TMUX_PANE || undefined,
    dispatchBuiltin: async (name, input) => {
      const { ACTION_NAMES } = await import("@tmux-ide/contracts");
      if (!(ACTION_NAMES as readonly string[]).includes(name))
        throw new PluginCliError(`No command named '${name}'.`);
      const { tryDispatchAction } = await import("../lib/cli-action-bridge.ts");
      const result = await tryDispatchAction(name as never, input as never);
      if (result === null) throw new PluginCliError("The daemon did not run the command.");
      return result;
    },
    ask: async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await prompt.question(question);
      } finally {
        prompt.close();
      }
    },
  };
}
