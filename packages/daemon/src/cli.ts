import { parseArgs } from "node:util";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { init } from "./init.ts";
import { ls } from "./ls.ts";
import { doctor } from "./doctor.ts";
import { status } from "./status.ts";
import { inspect } from "./inspect.ts";
import { validate } from "./validate.ts";
import { detect } from "./detect.ts";
import { migrate } from "./migrate.ts";
import { config } from "./config.ts";
import { send } from "./send.ts";
import { IdeError, TmuxError } from "./lib/errors.ts";
import { printCommandError } from "./lib/output.ts";
import { resolveProjectConfigContext } from "./lib/config-context.ts";
import { attachSession } from "@tmux-ide/tmux-bridge";
import { tryDispatchAction } from "./lib/cli-action-bridge.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "./index.ts";
import type { ActionResult } from "./command-center/actions/contract.ts";

/**
 * Typed view of parseArgs values. parseArgs runs with `strict: false` so its
 * declared return type widens every option to `string | boolean | undefined`,
 * losing the per-option type that's already declared in the `options` config
 * below. Cast `values` to this interface so call sites get the intended
 * shape without sprinkling assertions everywhere.
 */
interface CliFlags {
  json?: boolean;
  headless?: boolean;
  tasks?: boolean;
  fix?: boolean;
  row?: string;
  pane?: string;
  title?: string;
  command?: string;
  size?: string;
  write?: boolean;
  "dry-run"?: boolean;
  template?: string;
  name?: string;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
  description?: string;
  acceptance?: string;
  priority?: string;
  status?: string;
  assign?: string;
  goal?: string;
  tags?: string;
  proof?: string;
  depends?: string;
  pr?: boolean;
  specialty?: string;
  milestone?: string;
  fulfills?: string;
  summary?: string;
  sequence?: string;
  evidence?: string;
  port?: string;
  provider?: string;
  domain?: string;
  authtoken?: string;
  edit?: boolean;
  wizard?: boolean;
  url?: string;
  "hq-url"?: string;
  to?: string;
  "no-enter"?: boolean;
}

export async function main(): Promise<void> {
  const { positionals, values: rawValues } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: "boolean" },
      headless: { type: "boolean" },
      tasks: { type: "boolean" },
      fix: { type: "boolean" },
      row: { type: "string" },
      pane: { type: "string" },
      title: { type: "string" },
      command: { type: "string" },
      size: { type: "string" },
      write: { type: "boolean" },
      "dry-run": { type: "boolean" },
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
  const values = rawValues as CliFlags;

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
    "migrate",
    "config",
    "setup",
    "send",
    "settings",
    "command-center",
    "server",
    "help",
  ]);

  // --version / -v
  if (values.version) {
    const pkg = await import("../../../package.json");
    console.log(`tmux-ide v${pkg.default.version}`);
    process.exit(0);
  }

  if (values.verbose) {
    globalThis.__tmuxIdeVerbose = true;
  }

  const ALIASES: Record<string, string> = {};
  const firstPositional = positionals[0];
  const resolved = firstPositional ? (ALIASES[firstPositional] ?? firstPositional) : undefined;
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
  ${cyan("tmux-ide")}                    ${dim("Launch IDE from workspace config")}
  ${cyan("tmux-ide --headless")}         ${dim("Start the canonical daemon without the app")}
  ${cyan("tmux-ide <path>")}             ${dim("Launch from a specific directory")}
  ${cyan("tmux-ide setup")}              ${dim("Interactive TUI setup wizard")}
  ${cyan("tmux-ide setup --edit")}       ${dim("Open config tree editor")}
  ${cyan("tmux-ide settings")}           ${dim("Interactive TUI config manager")}
  ${cyan("tmux-ide init")} [--template]  ${dim("Scaffold .tmux-ide/workspace.yml (auto-detects stack)")}
  ${cyan("tmux-ide stop")}               ${dim("Kill the current IDE session")}
  ${cyan("tmux-ide restart")}            ${dim("Stop and relaunch the IDE session")}
  ${cyan("tmux-ide attach")}             ${dim("Reattach to a running session")}
  ${cyan("tmux-ide ls")}                 ${dim("List all tmux sessions")}
  ${cyan("tmux-ide status")} [--json]    ${dim("Show session status")}
  ${cyan("tmux-ide inspect")} [--json]   ${dim("Show effective config and runtime state")}
  ${cyan("tmux-ide doctor")}             ${dim("Check system requirements")}
  ${cyan("tmux-ide validate")} [--json]  ${dim("Validate workspace config")}
  ${cyan("tmux-ide detect")} [--json]    ${dim("Detect project stack")}
  ${cyan("tmux-ide detect --write")}     ${dim("Detect and write .tmux-ide/workspace.yml")}
  ${cyan("tmux-ide migrate --dry-run")} [--json]  ${dim("Preview ide.yml migration")}
  ${cyan("tmux-ide migrate --write")} [--json]    ${dim("Create .tmux-ide/workspace.yml")}
  ${cyan("tmux-ide config")} [--json]    ${dim("Dump config as JSON")}
  ${cyan("tmux-ide config set")} <path> <value>
  ${cyan("tmux-ide config add-pane")} --row <N> --title <T> [--command <C>]
  ${cyan("tmux-ide config remove-pane")} --row <N> --pane <M>
  ${cyan("tmux-ide config add-row")} [--size <percent>]

${bold("Pane Messaging:")}
  ${cyan("tmux-ide send")} <target> <message>     ${dim("Send message to a pane")}
  ${cyan("tmux-ide send")} --to <name> <message>   ${dim("Target by name, title, role, or ID")}
  ${cyan("tmux-ide send")} <target> --no-enter msg  ${dim("Send text without pressing Enter")}

${bold("Server:")}
  ${cyan("tmux-ide command-center")} [--port N]    ${dim("Start the command-center HTTP API")}
  ${cyan("tmux-ide server")} [--port N]            ${dim("Start HTTP + PTY WebSocket server")}

${bold("Flags:")}
  ${cyan("--json")}                      ${dim("Output as JSON (all commands)")}
  ${cyan("--headless")}                  ${dim("Run the canonical daemon in this process")}
  ${cyan("--template <name>")}           ${dim("Use specific template for init")}
  ${cyan("--write")}                     ${dim("Write detected config to .tmux-ide/workspace.yml")}
  ${cyan("--dry-run")}                   ${dim("Preview migration without writing")}
  ${cyan("--verbose")}                   ${dim("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan("-h, --help")}                  ${dim("Show usage")}
      ${cyan("-v, --version")}               ${dim("Show version number")}`);
  }

  async function resolveProjectName(targetDir: string | undefined): Promise<string> {
    const dir = resolve(targetDir ?? ".");
    return (await resolveProjectConfigContext(dir)).sessionName;
  }

  async function dispatchProjectLaunch(
    projectName: string,
    cwd: string,
  ): Promise<ActionResult<"project.launch">> {
    const result = await tryDispatchAction("project.launch", { name: projectName }, { cwd });
    if (!result) {
      throw new IdeError("Canonical daemon is not available", {
        code: "DAEMON_UNAVAILABLE",
        exitCode: 1,
      });
    }
    return result;
  }

  async function dispatchProjectOpenTerminal(
    projectName: string,
    cwd: string,
  ): Promise<ActionResult<"project.openTerminal">> {
    const result = await tryDispatchAction("project.openTerminal", { name: projectName }, { cwd });
    if (!result) {
      throw new IdeError("Canonical daemon is not available", {
        code: "DAEMON_UNAVAILABLE",
        exitCode: 1,
      });
    }
    return result;
  }

  async function dispatchProjectStop(
    projectName: string,
    cwd: string,
  ): Promise<ActionResult<"project.stop">> {
    const result = await tryDispatchAction("project.stop", { name: projectName }, { cwd });
    if (!result) {
      throw new IdeError("Canonical daemon is not available", {
        code: "DAEMON_UNAVAILABLE",
        exitCode: 1,
      });
    }
    return result;
  }

  async function dispatchProjectRestart(
    projectName: string,
    cwd: string,
  ): Promise<ActionResult<"project.restart">> {
    const result = await tryDispatchAction("project.restart", { name: projectName }, { cwd });
    if (!result) {
      throw new IdeError("Canonical daemon is not available", {
        code: "DAEMON_UNAVAILABLE",
        exitCode: 1,
      });
    }
    return result;
  }

  async function runHeadlessDaemon(): Promise<void> {
    let handle: EmbeddedDaemonHandle | null = null;
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (handle) await handle.stop();
    };
    process.on("SIGINT", () => {
      void stop().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void stop().finally(() => process.exit(0));
    });

    handle = await startEmbeddedDaemon({ bindHostname: "127.0.0.1" });
    console.log(`Canonical daemon: ${handle.apiBaseUrl}`);
    await new Promise<void>(() => undefined);
  }

  try {
    if (values.headless) {
      await runHeadlessDaemon();
    } else
      switch (command) {
        case "start":
          {
            const cwd = resolve(startTargetDir ?? ".");
            const projectName = await resolveProjectName(startTargetDir);
            const result = await dispatchProjectLaunch(projectName, cwd);
            if (json) {
              console.log(JSON.stringify(result));
            } else if (result.started) {
              console.log(`Started "${result.sessionName}".`);
            } else {
              console.log(`Session "${result.sessionName}" is already running. Attaching...`);
            }
            attachSession(result.sessionName);
          }
          break;

        case "init":
          await init({ template: values.template, json });
          break;

        case "stop":
          {
            const cwd = resolve(positionals[1] ?? ".");
            const projectName = await resolveProjectName(positionals[1]);
            const result = await dispatchProjectStop(projectName, cwd);
            if (json) console.log(JSON.stringify(result));
            else
              console.log(
                result.stopped ? `Stopped "${result.sessionName}".` : "No session running.",
              );
          }
          break;

        case "attach":
          {
            const cwd = resolve(positionals[1] ?? ".");
            const projectName = await resolveProjectName(positionals[1]);
            const result = await dispatchProjectOpenTerminal(projectName, cwd);
            if (json) console.log(JSON.stringify(result));
            attachSession(result.sessionName);
          }
          break;

        case "restart":
          {
            const cwd = resolve(positionals[1] ?? ".");
            const projectName = await resolveProjectName(positionals[1]);
            const result = await dispatchProjectRestart(projectName, cwd);
            if (json) console.log(JSON.stringify(result));
            else console.log(`Restarted "${result.sessionName}".`);
            attachSession(result.sessionName);
          }
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

        case "migrate":
          await migrate(positionals[1], { json, dryRun: values["dry-run"], write: values.write });
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
            const scriptPath = resolve(__dirname, "./widgets/setup/index.tsx");
            execFileSync("bun", [scriptPath, "--dir=" + resolve(startTargetDir || "."), "--edit"], {
              stdio: "inherit",
            });
            break;
          }

          await config(null, { json, action, args: configArgs });
          break;
        }

        case "setup": {
          const scriptPath = resolve(__dirname, "./widgets/setup/index.tsx");
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
          await send(undefined, { json, to: target, message, noEnter: values["no-enter"] });
          break;
        }

        case "settings": {
          const scriptPath = resolve(__dirname, "./widgets/config/index.tsx");
          execFileSync("bun", [scriptPath, "--dir=" + resolve(startTargetDir || ".")], {
            stdio: "inherit",
          });
          break;
        }

        case "command-center": {
          const { startCommandCenter } = await import("./command-center/index.ts");
          await startCommandCenter({ port: parseInt(values.port ?? "4000") });
          break;
        }

        case "server": {
          if ("bun" in process.versions) {
            const scriptPath = resolve(__dirname, "./server/standalone.ts");
            const serverArgs = ["--experimental-strip-types", scriptPath];
            if (values.port) serverArgs.push("--port", values.port);
            execFileSync("node", serverArgs, { stdio: "inherit" });
          } else {
            const { start } = await import("./server/index.ts");
            await start(values.port ? parseInt(values.port, 10) : undefined);
          }
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
    if (error instanceof IdeError || error instanceof TmuxError) {
      printCommandError(error, { json });
    } else {
      throw error;
    }
  }
}
