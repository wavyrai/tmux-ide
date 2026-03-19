#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { launch } from "../dist/launch.js";
import { init } from "../dist/init.js";
import { stop } from "../dist/stop.js";
import { attach } from "../dist/attach.js";
import { ls } from "../dist/ls.js";
import { doctor } from "../dist/doctor.js";
import { status } from "../dist/status.js";
import { inspect } from "../dist/inspect.js";
import { validate } from "../dist/validate.js";
import { detect } from "../dist/detect.js";
import { config } from "../dist/config.js";
import { restart } from "../dist/restart.js";
import { IdeError } from "../dist/lib/errors.js";
import { printCommandError } from "../dist/lib/output.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    row: { type: "string" },
    pane: { type: "string" },
    title: { type: "string" },
    command: { type: "string" },
    size: { type: "string" },
    write: { type: "boolean" },
    template: { type: "string" },
    name: { type: "string" },
    new: { type: "boolean" },
    session: { type: "string" },
    all: { type: "boolean" },
    filter: { type: "boolean" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

const knownCommands = new Set([
  "start",
  "init",
  "stop",
  "attach",
  "restart",
  "ls",
  "doctor",
  "status",
  "inspect",
  "validate",
  "detect",
  "config",
  "help",
]);

// --version / -v
if (values.version) {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json");
  console.log(`tmux-ide v${pkg.version}`);
  process.exit(0);
}

if (values.verbose) {
  globalThis.__tmuxIdeVerbose = true;
}

const firstPositional = positionals[0];
const hasKnownCommand = firstPositional ? knownCommands.has(firstPositional) : false;
const command = hasKnownCommand ? firstPositional : "start";
const startTargetDir = hasKnownCommand ? positionals[1] : firstPositional;
const json = values.json ?? false;

const noColor = "NO_COLOR" in process.env;
const bold = (s) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
const cyan = (s) => (noColor ? s : `\x1b[36m${s}\x1b[39m`);
const dim = (s) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);

if (values.help) {
  printHelp();
  process.exit(0);
}

function printHelp() {
  console.log(`${bold("tmux-ide")} — Terminal IDE powered by tmux

${bold("Usage:")}
  ${cyan("tmux-ide")}                    ${dim("Launch IDE from ide.yml")}
  ${cyan("tmux-ide <path>")}             ${dim("Launch from a specific directory")}
  ${cyan("tmux-ide init")} [--template]  ${dim("Scaffold a new ide.yml (auto-detects stack)")}
  ${cyan("tmux-ide stop")}               ${dim("Kill the current IDE session")}
  ${cyan("tmux-ide restart")}            ${dim("Stop and relaunch the IDE session")}
  ${cyan("tmux-ide attach")}             ${dim("Reattach to a running session")}
  ${cyan("tmux-ide ls")}                 ${dim("List all tmux sessions")}
  ${cyan("tmux-ide status")} [--json]    ${dim("Show session status")}
  ${cyan("tmux-ide inspect")} [--json]   ${dim("Show effective config and runtime state")}
  ${cyan("tmux-ide doctor")}             ${dim("Check system requirements")}
  ${cyan("tmux-ide validate")} [--json]  ${dim("Validate ide.yml")}
  ${cyan("tmux-ide detect")} [--json]    ${dim("Detect project stack")}
  ${cyan("tmux-ide detect --write")}     ${dim("Detect and write ide.yml")}
  ${cyan("tmux-ide config")} [--json]    ${dim("Dump config as JSON")}
  ${cyan("tmux-ide config set")} <path> <value>
  ${cyan("tmux-ide config add-pane")} --row <N> --title <T> [--command <C>]
  ${cyan("tmux-ide config remove-pane")} --row <N> --pane <M>
  ${cyan("tmux-ide config add-row")} [--size <percent>]
  ${cyan("tmux-ide config enable-team")} [--name <N>]   ${dim("Enable agent teams")}
  ${cyan("tmux-ide config disable-team")}               ${dim("Disable agent teams")}

${bold("Flags:")}
  ${cyan("--json")}                      ${dim("Output as JSON (all commands)")}
  ${cyan("--new")}                       ${dim("Launch a new parallel session instance")}
  ${cyan("--session <name>")}            ${dim("Target a specific session (stop/attach/status/restart/inspect)")}
  ${cyan("--all")}                       ${dim("Stop all instances of this project's session")}
  ${cyan("--filter")}                    ${dim("Filter ls output to this project's sessions")}
  ${cyan("--template <name>")}           ${dim("Use specific template for init")}
  ${cyan("--write")}                     ${dim("Write detected config to ide.yml")}
  ${cyan("--verbose")}                   ${dim("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan("-h, --help")}                  ${dim("Show usage")}
  ${cyan("-v, --version")}               ${dim("Show version number")}`);
}

try {
  switch (command) {
    case "start":
      await launch(startTargetDir, { json, newInstance: values.new });
      break;

    case "init":
      await init({ template: values.template, json });
      break;

    case "stop":
      await stop(positionals[1], { json, session: values.session, all: values.all });
      break;

    case "attach":
      await attach(positionals[1], { json, session: values.session });
      break;

    case "restart":
      await restart(positionals[1], { json, session: values.session });
      break;

    case "ls":
      await ls({ json, filter: values.filter });
      break;

    case "doctor":
      await doctor({ json });
      break;

    case "status":
      await status(positionals[1], { json, session: values.session });
      break;

    case "inspect":
      await inspect(positionals[1], { json, session: values.session });
      break;

    case "validate":
      await validate(positionals[1], { json });
      break;

    case "detect":
      await detect(positionals[1], { json, write: values.write });
      break;

    case "config": {
      const sub = positionals[1]; // set, add-pane, remove-pane, add-row, or undefined (dump)
      let action = "dump";
      let configArgs = [];

      if (sub === "set") {
        action = "set";
        configArgs = positionals.slice(2);
      } else if (sub === "add-pane") {
        action = "add-pane";
        // Pass named flags as args array
        configArgs = [];
        if (values.row !== undefined) configArgs.push("--row", values.row);
        if (values.title !== undefined) configArgs.push("--title", values.title);
        if (values.command !== undefined) configArgs.push("--command", values.command);
        if (values.size !== undefined) configArgs.push("--size", values.size);
      } else if (sub === "remove-pane") {
        action = "remove-pane";
        configArgs = [];
        if (values.row !== undefined) configArgs.push("--row", values.row);
        if (values.pane !== undefined) configArgs.push("--pane", values.pane);
      } else if (sub === "add-row") {
        action = "add-row";
        configArgs = [];
        if (values.size !== undefined) configArgs.push("--size", values.size);
      } else if (sub === "enable-team") {
        action = "enable-team";
        configArgs = [];
        if (values.name !== undefined) configArgs.push("--name", values.name);
      } else if (sub === "disable-team") {
        action = "disable-team";
        configArgs = [];
      }

      await config(null, { json, action, args: configArgs });
      break;
    }

    case "help":
      printHelp();
      break;

    default:
      throw new IdeError(`Unknown command: ${command}\nRun "tmux-ide help" for usage.`, {
        code: "USAGE",
        exitCode: 1,
      });
  }
} catch (error) {
  if (error instanceof IdeError) {
    printCommandError(error, { json });
  } else {
    throw error;
  }
}
