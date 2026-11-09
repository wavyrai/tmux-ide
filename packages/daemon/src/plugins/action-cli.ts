/**
 * `tmux-ide action list` and `tmux-ide action run`: the command catalog from
 * a shell, and the way tmux key bindings reach plugin actions.
 */
import { parseArgs } from "node:util";
import type {
  CommandCatalogEntry,
  CommandCatalogResource,
  CommandInvokeResult,
  CommandParam,
} from "@tmux-ide/contracts";
import { callDaemon, formatValue, PluginCliError, type PluginCliIo } from "./cli.ts";

export const ACTION_USAGE = `Usage:
  tmux-ide action list [--json]                List built-in and plugin commands
  tmux-ide action run <id> [--arg name=value]… [--yes] [--json]
                                               Run a plugin command (plugin.<plugin>.<id>)
  tmux-ide action run <id> --input '<json>'    Run a built-in command with its JSON input
Options for run:
  --session <name>  --pane <id>   Where to act (default: this pane, from $TMUX_PANE)
  --yes                           Confirm a dangerous command without a prompt`;

function describeParam(param: CommandParam): string {
  const choices = param.choices?.length
    ? ` (${param.choices.map((choice) => choice.value).join(", ")})`
    : param.dynamicChoices
      ? " (choices from the plugin)"
      : "";
  const fallback =
    param.default !== undefined
      ? `, default ${JSON.stringify(param.default)}`
      : param.dynamicDefault
        ? ", default from the plugin"
        : "";
  return `${param.name}: ${param.type}${param.required ? "" : "?"}${choices}${fallback}`;
}

export function formatCatalog(catalog: CommandCatalogResource): string {
  const plugins = catalog.entries.filter((entry) => entry.plugin);
  const builtins = catalog.entries.filter((entry) => !entry.plugin);
  const lines: string[] = [];
  const section = (title: string, entries: readonly CommandCatalogEntry[]) => {
    if (entries.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(title);
    const width = Math.max(...entries.map((entry) => entry.descriptor.id.length));
    for (const entry of entries) {
      const flag = entry.descriptor.dangerous ? "  [asks to confirm]" : "";
      lines.push(`  ${entry.descriptor.id.padEnd(width)}  ${entry.descriptor.label}${flag}`);
      for (const param of entry.params)
        lines.push(`  ${" ".repeat(width)}    ${describeParam(param)}`);
    }
  };
  section("Plugin commands", plugins);
  section("Built-in commands (take --input JSON)", builtins);
  if (lines.length === 0) lines.push("No commands.");
  return lines.join("\n");
}

/** Turn `--arg name=value` strings into typed arguments for `entry`. */
export function parseActionArgs(
  entry: CommandCatalogEntry,
  raw: readonly string[],
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const item of raw) {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new PluginCliError(`--arg expects name=value, got '${item}'`, 2);
    const name = item.slice(0, eq);
    const value = item.slice(eq + 1);
    const param = entry.params.find((candidate) => candidate.name === name);
    if (!param) {
      const known = entry.params.map((candidate) => candidate.name).join(", ") || "none";
      throw new PluginCliError(
        `'${entry.descriptor.id}' has no parameter '${name}' (it takes: ${known})`,
        2,
      );
    }
    if (name in out) throw new PluginCliError(`--arg ${name} is given twice`, 2);
    if (param.type === "number") {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number))
        throw new PluginCliError(`${name} must be a number`, 2);
      out[name] = number;
    } else if (param.type === "boolean") {
      if (value !== "true" && value !== "false")
        throw new PluginCliError(`${name} must be true or false`, 2);
      out[name] = value === "true";
    } else {
      out[name] = value;
    }
  }
  return out;
}

export async function runActionCli(argv: readonly string[], io: PluginCliIo): Promise<number> {
  try {
    return await actionCli(argv, io);
  } catch (error) {
    if (error instanceof PluginCliError) {
      io.err(error.message);
      return error.exitCode;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.err(`${error.message}\n${ACTION_USAGE}`);
      return 2;
    }
    if (error instanceof Error && error.name === "CliActionInvocationError") {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function actionCli(argv: readonly string[], io: PluginCliIo): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      arg: { type: "string", short: "a", multiple: true },
      input: { type: "string" },
      session: { type: "string" },
      pane: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || sub === "help") {
    io.out(ACTION_USAGE);
    return 0;
  }
  if (!sub) throw new PluginCliError(ACTION_USAGE, 2);
  if (sub === "list") {
    const catalog = await callDaemon<CommandCatalogResource>(
      io,
      "GET",
      "/api/resources/command-catalog",
    );
    io.out(values.json ? JSON.stringify(catalog, null, 2) : formatCatalog(catalog));
    return 0;
  }
  if (sub !== "run")
    throw new PluginCliError(`Unknown action command '${sub}'.\n${ACTION_USAGE}`, 2);

  const id = positionals[0];
  if (!id || positionals.length > 1)
    throw new PluginCliError(`Name one command to run.\n${ACTION_USAGE}`, 2);

  if (!id.startsWith("plugin.")) {
    if (values.arg?.length)
      throw new PluginCliError("Built-in commands take --input JSON, not --arg.", 2);
    let input: unknown = {};
    if (values.input !== undefined) {
      try {
        input = JSON.parse(values.input);
      } catch {
        throw new PluginCliError("--input must be JSON.", 2);
      }
    }
    const result = await io.dispatchBuiltin(id, input);
    io.out(values.json ? JSON.stringify(result, null, 2) : formatValue(result));
    return 0;
  }

  if (values.input !== undefined)
    throw new PluginCliError("Plugin commands take --arg name=value.", 2);
  const catalog = await callDaemon<CommandCatalogResource>(
    io,
    "GET",
    "/api/resources/command-catalog",
  );
  const entry = catalog.entries.find((candidate) => candidate.descriptor.id === id);
  if (!entry) throw new PluginCliError(`No command named '${id}'. See \`tmux-ide action list\`.`);
  const args = parseActionArgs(entry, values.arg ?? []);

  let confirmed = values.yes === true;
  if (entry.descriptor.dangerous && !confirmed) {
    if (!io.interactive())
      throw new PluginCliError(`'${entry.descriptor.label}' asks to confirm: pass --yes.`, 2);
    const answer = (await io.ask(`${entry.descriptor.label}: are you sure? [y/N] `))
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      io.out("Cancelled.");
      return 1;
    }
    confirmed = true;
  }

  const pane = values.pane ?? io.tmuxPane();
  const result = await callDaemon<CommandInvokeResult>(io, "POST", "/api/v2/commands/invoke", {
    id,
    args,
    context: {
      source: "cli",
      ...(values.session ? { session: values.session } : {}),
      ...(pane ? { pane } : {}),
    },
    ...(confirmed ? { confirmed: true } : {}),
  });
  if (values.json) {
    io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    io.err(result.error);
    return 1;
  }
  if (result.value !== undefined) io.out(formatValue(result.value));
  return 0;
}
