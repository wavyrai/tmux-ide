#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { launch } from "../src/launch.ts";
import { init } from "../src/init.ts";
import { stop } from "../src/stop.ts";
import { attach } from "../src/attach.ts";
import { ls } from "../src/ls.ts";
import { doctor } from "../src/doctor.ts";
import { status } from "../src/status.ts";
import { inspect } from "../src/inspect.ts";
import { validate } from "../src/validate.ts";
import { detect } from "../src/detect.ts";
import { config } from "../src/config.ts";
import { restart } from "../src/restart.ts";
import { taskCommand } from "../src/task.ts";
import { send } from "../src/send.ts";
import { IdeError } from "../src/lib/errors.ts";
import { printCommandError } from "../src/lib/output.ts";

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
    proof: { type: "string" },
    depends: { type: "string" },
    pr: { type: "boolean" },
    specialty: { type: "string" },
    milestone: { type: "string" },
    fulfills: { type: "string" },
    summary: { type: "string" },
    sequence: { type: "string" },
    evidence: { type: "string" },
    port: { type: "string" },
    // tunnel command flags
    provider: { type: "string" },
    domain: { type: "string" },
    authtoken: { type: "string" },
    // setup command flags
    edit: { type: "boolean" },
    wizard: { type: "boolean" },
    // remote command flags
    url: { type: "string" },
    "hq-url": { type: "string" },
    // send command flags
    to: { type: "string" },
    "no-enter": { type: "boolean" },
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
  "milestone",
  "goal",
  "task",
  "plan",
  "skill",
  "setup",
  "send",
  "dispatch",
  "notify",
  "orchestrator",
  "settings",
  "command-center",
  "tunnel",
  "remote",
  "help",
]);

// --version / -v
if (values.version) {
  const pkg = await import("../package.json");
  console.log(`tmux-ide v${pkg.version}`);
  process.exit(0);
}

if (values.verbose) {
  globalThis.__tmuxIdeVerbose = true;
}

const ALIASES: Record<string, string> = {
  t: "task",
  g: "goal",
  m: "mission",
  ms: "milestone",
  orch: "orchestrator",
  o: "orchestrator",
};
const firstPositional = positionals[0];
const resolved = ALIASES[firstPositional] ?? firstPositional;
const hasKnownCommand = resolved ? knownCommands.has(resolved) : false;
const command = hasKnownCommand ? resolved : "start";
const startTargetDir = hasKnownCommand ? positionals[1] : firstPositional;
const json = values.json ?? false;

const noColor = "NO_COLOR" in process.env;
const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
const cyan = (s: string) => (noColor ? s : `\x1b[36m${s}\x1b[39m`);
const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);

if (values.help) {
  printHelp();
  process.exit(0);
}

function printHelp() {
  console.log(`${bold("tmux-ide")} — Terminal IDE powered by tmux

${bold("Usage:")}
  ${cyan("tmux-ide")}                    ${dim("Launch IDE from ide.yml")}
  ${cyan("tmux-ide <path>")}             ${dim("Launch from a specific directory")}
  ${cyan("tmux-ide setup")}              ${dim("Interactive TUI setup wizard")}
  ${cyan("tmux-ide setup --edit")}       ${dim("Open config tree editor")}
  ${cyan("tmux-ide settings")}           ${dim("Interactive TUI config manager")}
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

${bold("Pane Messaging:")}
  ${cyan("tmux-ide send")} <target> <message>     ${dim("Send message to a pane")}
  ${cyan("tmux-ide send")} --to <name> <message>   ${dim("Target by name, title, role, or ID")}
  ${cyan("tmux-ide send")} <target> --no-enter msg  ${dim("Send text without pressing Enter")}

${bold("Dispatch:")}
  ${cyan("tmux-ide dispatch")} <id> [--json]        ${dim("Print task context to stdout")}
  ${cyan("tmux-ide notify")} <message> [--json]     ${dim("Send notification to lead pane")}

${bold("Orchestrator:")}
  ${cyan("tmux-ide orchestrator")} [--json]         ${dim("Show orchestrator status")}
  ${cyan("tmux-ide orch")}                          ${dim("Alias for orchestrator")}

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

    case "validate": {
      const valSub = positionals[1];
      if (valSub === "assert" || valSub === "show" || valSub === "report" || valSub === "coverage" || valSub === "help") {
        await taskCommand(null, {
          json,
          action: "validate",
          sub: valSub,
          args: positionals.slice(2),
          values: {
            status: values.status,
            evidence: values.evidence,
            assign: values.assign,
          },
        });
      } else {
        await validate(valSub, { json });
      }
      break;
    }

    case "detect":
      await detect(positionals[1], { json, write: values.write });
      break;

    case "config": {
      const sub = positionals[1];
      let action = "dump";
      let configArgs: string[] = [];

      if (sub === "set") {
        action = "set";
        configArgs = positionals.slice(2);
      } else if (sub === "add-pane") {
        action = "add-pane";
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
      } else if (sub === "edit") {
        const scriptPath = resolve(__dirname, "../src/widgets/setup/index.tsx");
        execFileSync("bun", [scriptPath, "--dir=" + resolve(startTargetDir || "."), "--edit"], {
          stdio: "inherit",
        });
        break;
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

    case "milestone": {
      const sub = positionals[1];
      await taskCommand(null, {
        json,
        action: "milestone",
        sub,
        args: positionals.slice(2),
        values: {
          description: values.description,
          status: values.status,
          sequence: values.sequence,
        },
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
          proof: values.proof,
          depends: values.depends,
          pr: values.pr,
          specialty: values.specialty,
          milestone: values.milestone,
          fulfills: values.fulfills,
          summary: values.summary,
        },
      });
      break;
    }

    case "plan": {
      const { planCommand } = await import("../src/plan.ts");
      await planCommand(null, {
        json,
        sub: positionals[1],
        args: positionals.slice(2),
        values: { status: values.status },
      });
      break;
    }

    case "skill": {
      const { skillCommand } = await import("../src/skill.ts");
      await skillCommand(null, {
        json,
        sub: positionals[1],
        args: positionals.slice(2),
      });
      break;
    }

    case "setup": {
      const scriptPath = resolve(__dirname, "../src/widgets/setup/index.tsx");
      const setupArgs = [scriptPath, "--dir=" + resolve(startTargetDir || ".")];
      if (positionals[1] === "--edit" || values.edit) setupArgs.push("--edit");
      if (positionals[1] === "--wizard" || values.wizard) setupArgs.push("--wizard");
      execFileSync("bun", setupArgs, { stdio: "inherit" });
      break;
    }

    case "send": {
      const target = values.to ?? positionals[1];
      const messageStart = values.to ? 1 : 2;
      let message = positionals.slice(messageStart).join(" ");
      if (!message && !process.stdin.isTTY) {
        const { readFileSync } = await import("node:fs");
        message = readFileSync(0, "utf-8").trim();
      }
      await send(null, { json, to: target, message, noEnter: values["no-enter"] });
      break;
    }

    case "dispatch": {
      const { dispatch: dispatchCmd } = await import("../src/dispatch.ts");
      const taskId = positionals[1];
      await dispatchCmd(null, { taskId, json });
      break;
    }

    case "notify": {
      const { notify: notifyCmd } = await import("../src/notify.ts");
      const notifyMessage = positionals.slice(1).join(" ");
      await notifyCmd(null, { message: notifyMessage || undefined, json });
      break;
    }

    case "orchestrator": {
      const { orchestratorStatus } = await import("../src/orchestrator-status.ts");
      await orchestratorStatus(positionals[1], { json });
      break;
    }

    case "settings": {
      const scriptPath = resolve(__dirname, "../src/widgets/config/index.tsx");
      execFileSync("bun", [scriptPath, "--dir=" + resolve(startTargetDir || ".")], {
        stdio: "inherit",
      });
      break;
    }

    case "tunnel": {
      const { tunnelCommand } = await import("../src/tunnel.ts");
      await tunnelCommand(null, {
        json,
        sub: positionals[1],
        args: positionals.slice(2),
        values: {
          provider: values.provider,
          port: values.port,
          domain: values.domain,
          authtoken: values.authtoken,
        },
      });
      break;
    }

    case "remote": {
      const { remoteCommand } = await import("../src/remote.ts");
      await remoteCommand(null, {
        json,
        sub: positionals[1],
        args: positionals.slice(2),
        values: {
          url: values.url,
          "hq-url": values["hq-url"],
        },
      });
      break;
    }

    case "command-center": {
      const { startCommandCenter } = await import("../src/command-center/index.ts");
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
