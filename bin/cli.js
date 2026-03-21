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
import { taskCommand } from "../dist/task.js";
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
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    // task command flags
    description: { type: "string", short: "d" },
    acceptance: { type: "string" },
    priority: { type: "string", short: "p" },
    status: { type: "string", short: "s" },
    assign: { type: "string", short: "a" },
    goal: { type: "string", short: "g" },
    tags: { type: "string", short: "t" },
    branch: { type: "string", short: "b" },
    proof: { type: "string" },
    depends: { type: "string" },
    pr: { type: "boolean" },
    specialty: { type: "string" },
    port: { type: "string" },
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
  "mission",
  "goal",
  "task",
  "plan",
  "command-center",
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

const ALIASES = { t: "task", g: "goal", m: "mission" };
const firstPositional = positionals[0];
const resolved = ALIASES[firstPositional] ?? firstPositional;
const hasKnownCommand = resolved ? knownCommands.has(resolved) : false;
const command = hasKnownCommand ? resolved : "start";
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

${bold("Task Management:")}
  ${cyan("tmux-ide mission set")} "title"              ${dim("Set the project mission")}
  ${cyan("tmux-ide mission show")}                     ${dim("Show current mission")}
  ${cyan("tmux-ide goal list")}                        ${dim("List goals")}
  ${cyan("tmux-ide goal create")} "title"              ${dim("Create a goal")}
  ${cyan("tmux-ide goal show")} <id>                   ${dim("Show goal with tasks")}
  ${cyan("tmux-ide task list")} [--status X --goal Y]  ${dim("List tasks")}
  ${cyan("tmux-ide task create")} "title" [--goal id]  ${dim("Create a task")}
  ${cyan("tmux-ide task claim")} <id> [--assign name]  ${dim("Claim a task")}
  ${cyan("tmux-ide task done")} <id> [--proof "..."]   ${dim("Complete a task")}
  ${cyan("tmux-ide task show")} <id>                   ${dim("Show task with full context")}

${bold("Flags:")}
  ${cyan("--json")}                      ${dim("Output as JSON (all commands)")}
  ${cyan("--template <name>")}           ${dim("Use specific template for init")}
  ${cyan("--write")}                     ${dim("Write detected config to ide.yml")}
  ${cyan("--verbose")}                   ${dim("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan("-h, --help")}                  ${dim("Show usage")}
  ${cyan("-v, --version")}               ${dim("Show version number")}`);
}

try {
  switch (command) {
    case "start":
      await launch(startTargetDir, { json });
      break;

    case "init":
      await init({ template: values.template, json });
      break;

    case "stop":
      await stop(positionals[1], { json });
      break;

    case "attach":
      await attach(positionals[1], { json });
      break;

    case "restart":
      await restart(positionals[1], { json });
      break;

    case "ls":
      await ls({ json });
      break;

    case "doctor":
      await doctor({ json });
      break;

    case "status":
      await status(positionals[1], { json });
      break;

    case "inspect":
      await inspect(positionals[1], { json });
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

    case "mission": {
      const sub = positionals[1];
      await taskCommand(null, {
        json,
        action: "mission",
        sub,
        args: positionals.slice(2),
        values: { description: values.description },
      });
      break;
    }

    case "goal": {
      const sub = positionals[1];
      await taskCommand(null, {
        json,
        action: "goal",
        sub,
        args: positionals.slice(2),
        values: {
          description: values.description,
          acceptance: values.acceptance,
          priority: values.priority,
          status: values.status,
          specialty: values.specialty,
        },
      });
      break;
    }

    case "task": {
      const sub = positionals[1];
      await taskCommand(null, {
        json,
        action: "task",
        sub,
        args: positionals.slice(2),
        values: {
          title: values.title,
          description: values.description,
          priority: values.priority,
          status: values.status,
          assign: values.assign,
          goal: values.goal,
          tags: values.tags,
          branch: values.branch,
          proof: values.proof,
          depends: values.depends,
          pr: values.pr,
        },
      });
      break;
    }

    case "plan": {
      const { planCommand } = await import("../dist/plan.js");
      await planCommand(null, {
        json,
        sub: positionals[1],
        args: positionals.slice(2),
        values: { status: values.status },
      });
      break;
    }

    case "command-center": {
      const { startCommandCenter } = await import("../dist/command-center/index.js");
      await startCommandCenter({ port: parseInt(values.port ?? "4000") });
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
