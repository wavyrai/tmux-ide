// No shebang in source. The published bin is the compiled `bin/cli.js`
// (see scripts/build-cli.mjs) which adds `#!/usr/bin/env node` via the
// esbuild banner. Dev iteration uses `bun bin/cli.ts` directly, which
// doesn't need a shebang.
import { parseArgs } from "node:util";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { launch } from "../packages/daemon/src/launch.ts";
import { shouldOpenCockpit } from "../packages/daemon/src/tui/team/entry.ts";
import { init } from "../packages/daemon/src/init.ts";
import { stop } from "../packages/daemon/src/stop.ts";
import { attach } from "../packages/daemon/src/attach.ts";
import { ls } from "../packages/daemon/src/ls.ts";
import { doctor } from "../packages/daemon/src/doctor.ts";
import { status } from "../packages/daemon/src/status.ts";
import { inspect } from "../packages/daemon/src/inspect.ts";
import { validate } from "../packages/daemon/src/validate.ts";
import { detect } from "../packages/daemon/src/detect.ts";
import { config } from "../packages/daemon/src/config.ts";
import { restart } from "../packages/daemon/src/restart.ts";
import { send } from "../packages/daemon/src/send.ts";
import { launchHostShell } from "../packages/daemon/src/tui/team/host.ts";
import { IdeError } from "../packages/daemon/src/lib/errors.ts";
import { printCommandError } from "../packages/daemon/src/lib/output.ts";

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
    port: { type: "string" },
    // setup command flags
    edit: { type: "boolean" },
    wizard: { type: "boolean" },
    // send command flags
    to: { type: "string" },
    "no-enter": { type: "boolean" },
    // wait command flags
    status: { type: "string" },
    timeout: { type: "string" },
    // force the team cockpit instead of launching a project
    team: { type: "boolean" },
    // statusline: the session whose bar is being rendered
    active: { type: "string" },
    // switcher: the tmux client the popup was invoked on (see `switcher` case)
    client: { type: "string" },
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
  "setup",
  "send",
  "settings",
  "team",
  "switcher",
  "wait",
  "statusline",
  "adopt",
  "unadopt",
  "cheatsheet",
  "command-center",
  "server",
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

const firstPositional = positionals[0];
const resolved = firstPositional;
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
  ${cyan("tmux-ide")}                    ${dim("Launch ide.yml, or open the team cockpit if none")}
  ${cyan("tmux-ide <path>")}             ${dim("Launch from a specific directory (cockpit if no ide.yml)")}
  ${cyan("tmux-ide setup")}              ${dim("Interactive TUI setup wizard")}
  ${cyan("tmux-ide setup --edit")}       ${dim("Open config tree editor")}
  ${cyan("tmux-ide settings")}           ${dim("Interactive TUI config manager")}
  ${cyan("tmux-ide init")} [--template]  ${dim("Scaffold a new ide.yml (auto-detects stack)")}
  ${cyan("tmux-ide stop")}               ${dim("Kill the current IDE session")}
  ${cyan("tmux-ide restart")}            ${dim("Stop and relaunch the IDE session")}
  ${cyan("tmux-ide attach")}             ${dim("Reattach to a running session")}
  ${cyan("tmux-ide team")} [--json]      ${dim("TUI over all tmux sessions (--json prints fleet state)")}
  ${cyan("tmux-ide switcher")}           ${dim("Compact session picker (opens in the M-p popup on adopted sessions)")}
  ${cyan("tmux-ide wait agent-status")} <session> --status <s> [--timeout <ms>]
                              ${dim("Block until a session reaches a status (exit 0 match / 1 timeout)")}
  ${cyan("tmux-ide adopt")} <session>    ${dim("Add the live tmux-ide status bar to a session")}
  ${cyan("tmux-ide unadopt")} <session>  ${dim("Remove the status bar")}
  ${cyan("tmux-ide cheatsheet")}         ${dim("Print the key cheat sheet (⌥k / [ ? keys ] popup)")}
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

${bold("Server:")}
  ${cyan("tmux-ide command-center")} [--port N]    ${dim("Start the command-center HTTP API")}
  ${cyan("tmux-ide server")} [--port N]            ${dim("Start HTTP + PTY WebSocket server")}

${bold("Flags:")}
  ${cyan("--json")}                      ${dim("Output as JSON (all commands)")}
  ${cyan("--template <name>")}           ${dim("Use specific template for init")}
  ${cyan("--write")}                     ${dim("Write detected config to ide.yml")}
  ${cyan("--verbose")}                   ${dim("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan("-h, --help")}                  ${dim("Show usage")}
  ${cyan("-v, --version")}               ${dim("Show version number")}`);
}

// The TUI widgets are `.tsx` files that ship only in a dev checkout and
// require the `bun` runtime. On a clean `npm i -g tmux-ide` neither is
// present, so execFileSync("bun", ...) would throw a raw ENOENT. Guard
// first and surface an actionable IdeError instead.
function assertBunWidgetAvailable(scriptPath: string, commandLabel: string): void {
  const widgetMissing = !existsSync(scriptPath);
  let bunMissing = false;
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
  } catch {
    bunMissing = true;
  }
  if (widgetMissing || bunMissing) {
    const reasons: string[] = [];
    if (bunMissing) reasons.push("the `bun` runtime is not installed (https://bun.sh)");
    if (widgetMissing)
      reasons.push(
        "the TUI widget sources are absent (they ship only in a cloned tmux-ide checkout, not the npm package)",
      );
    throw new IdeError(
      `\`tmux-ide ${commandLabel}\` is unavailable because ${reasons.join(" and ")}.\n` +
        `Run it from a cloned tmux-ide checkout with bun installed.`,
      { code: "USAGE", exitCode: 1 },
    );
  }
}

function execBunWidget(
  scriptPath: string,
  args: string[],
  commandLabel: string,
  extraEnv: Record<string, string> = {},
): void {
  assertBunWidgetAvailable(scriptPath, commandLabel);
  // Spawn from the repo root so bun finds `bunfig.toml` (the @opentui/solid
  // JSX preload). Without this, running from any other cwd — e.g. bare
  // `tmux-ide` in a project dir — falls back to the React JSX runtime and the
  // widget fails to load. The real invocation dir is forwarded via env so
  // in-widget prompts (register / new session) still default to where the user
  // actually is. `extraEnv` layers on top for widget-specific flags (e.g. the
  // switcher's picker-client hint).
  const bunfigRoot = resolve(__dirname, "..");
  execFileSync("bun", [scriptPath, ...args], {
    stdio: "inherit",
    cwd: bunfigRoot,
    env: { ...process.env, TMUX_IDE_CWD: process.cwd(), ...extraEnv },
  });
}

// The scriptable control surface for the cockpit: print the fleet state as JSON
// and exit without spawning the (bun/OpenTUI) TUI. Shared by `tmux-ide team
// --json` and bare `tmux-ide --json` when there's no ide.yml to launch. Dynamic
// imports keep the interactive path free of the data-layer modules.
async function printFleetJson(): Promise<void> {
  const { createStatusTracker } = await import("../packages/daemon/src/tui/detect/classify.ts");
  const { listTeamProjects } = await import("../packages/daemon/src/tui/team/projects.ts");
  const { toFleetJson } = await import("../packages/daemon/src/tui/team/report.ts");
  console.log(JSON.stringify(toFleetJson(listTeamProjects(createStatusTracker())), null, 2));
}

const teamScriptPath = resolve(__dirname, "../packages/daemon/src/tui/team/index.tsx");

// `tmux-ide team` HOSTS tmux: it opens a dedicated `[ switcher | main ]`
// session with the OpenTUI switcher on the left. Guard bun/widget availability
// just like a bun widget (the switcher pane runs bun), then create-or-attach.
function launchTeamHost(): void {
  assertBunWidgetAvailable(teamScriptPath, "team");
  launchHostShell({
    repoRoot: resolve(__dirname, ".."),
    switcherScript: teamScriptPath,
    userCwd: process.cwd(),
  });
}

try {
  switch (command) {
    case "start": {
      const targetDir = resolve(startTargetDir || ".");
      const hasIdeYml = existsSync(join(targetDir, "ide.yml"));
      if (shouldOpenCockpit(hasIdeYml, values.team === true)) {
        // No project here (or --team): the cockpit is the front door.
        if (json) {
          await printFleetJson();
          break;
        }
        launchTeamHost();
        break;
      }
      await launch(startTargetDir, { json });
      break;
    }

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
        const scriptPath = resolve(__dirname, "../packages/daemon/src/widgets/setup/index.tsx");
        execBunWidget(
          scriptPath,
          ["--dir=" + resolve(startTargetDir || "."), "--edit"],
          "config edit",
        );
        break;
      }

      await config(null, { json, action, args: configArgs });
      break;
    }

    case "setup": {
      const scriptPath = resolve(__dirname, "../packages/daemon/src/widgets/setup/index.tsx");
      const setupArgs = ["--dir=" + resolve(startTargetDir || ".")];
      if (positionals[1] === "--edit" || values.edit) setupArgs.push("--edit");
      if (positionals[1] === "--wizard" || values.wizard) setupArgs.push("--wizard");
      execBunWidget(scriptPath, setupArgs, "setup");
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

    case "settings": {
      const scriptPath = resolve(__dirname, "../packages/daemon/src/widgets/config/index.tsx");
      execBunWidget(scriptPath, ["--dir=" + resolve(startTargetDir || ".")], "settings");
      break;
    }

    case "team": {
      // `--json` is the scriptable control surface: print the fleet state and
      // exit without spawning the (bun/OpenTUI) TUI.
      if (json) {
        await printFleetJson();
        break;
      }
      launchTeamHost();
      break;
    }

    case "switcher": {
      // Runs the team app in PICKER mode inside a tmux `display-popup` (bound to
      // `M-p` on adopt). Picking a session `switch-client`s the invoking client
      // there and the app exits, closing the popup. `TMUX_IDE_PICKER_CLIENT`
      // both flips the app into picker mode and carries an optional explicit
      // client name; empty means "resolve it yourself from inside the popup".
      const clientArg = typeof values.client === "string" ? values.client : "";
      execBunWidget(teamScriptPath, [], "switcher", { TMUX_IDE_PICKER_CLIENT: clientArg });
      break;
    }

    case "wait": {
      const { createStatusTracker } = await import("../packages/daemon/src/tui/detect/classify.ts");
      const { listTeamSessions } = await import("../packages/daemon/src/tui/team/sessions.ts");
      const { findSessionStatus } = await import("../packages/daemon/src/tui/team/report.ts");

      const VALID = new Set(["blocked", "working", "done", "idle", "unknown"]);
      const sub = positionals[1];
      const sessionName = positionals[2];
      const want = values.status;

      if (sub !== "agent-status" || !sessionName || typeof want !== "string" || !VALID.has(want)) {
        console.error(
          "Usage: tmux-ide wait agent-status <session> --status <blocked|working|done|idle|unknown> [--timeout <ms>]",
        );
        process.exit(1);
      }

      const timeout = Number(values.timeout ?? "60000");
      const started = Date.now();
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // One tracker persists across polls so the working→idle `done` transition
      // can be observed (it's inherently cross-tick).
      const tracker = createStatusTracker();

      while (true) {
        const sessions = listTeamSessions(tracker);
        const status = findSessionStatus(sessions, sessionName!);
        if (status === want) {
          if (json) {
            console.log(JSON.stringify({ session: sessionName, status, ok: true }));
          } else {
            console.log(`${sessionName} reached status: ${status}`);
          }
          process.exit(0);
        }
        if (Date.now() - started >= timeout) {
          console.error(
            `Timed out after ${timeout}ms waiting for ${sessionName} to reach status "${want}" (last: ${status ?? "absent"})`,
          );
          process.exit(1);
        }
        await sleep(750);
      }
    }

    case "statusline": {
      // Called by tmux via #() every status-interval — keep it lean and never
      // let an error corrupt the bar (print a minimal brand instead).
      try {
        const { createStatusTracker } =
          await import("../packages/daemon/src/tui/detect/classify.ts");
        const { listTeamProjects } = await import("../packages/daemon/src/tui/team/projects.ts");
        const { buildStatusline } = await import("../packages/daemon/src/tui/chrome/statusline.ts");
        const projects = listTeamProjects(createStatusTracker());
        console.log(buildStatusline(projects, values.active ?? null));
      } catch {
        console.log("#[fg=colour75,bold] tmux-ide #[default]");
      }
      break;
    }

    case "adopt": {
      const { adoptSession } = await import("../packages/daemon/src/tui/chrome/statusline.ts");
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide adopt <session>");
        process.exit(1);
      }
      adoptSession(target);
      console.log(`adopted ${target} — chrome row active (unadopt to remove)`);
      break;
    }

    case "unadopt": {
      const { unadoptSession } = await import("../packages/daemon/src/tui/chrome/statusline.ts");
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide unadopt <session>");
        process.exit(1);
      }
      unadoptSession(target);
      console.log(`unadopted ${target}`);
      break;
    }

    case "cheatsheet": {
      // Renders the static key cheat sheet, then blocks until ANY key closes it
      // (the popup exits). Runs inside a tmux `display-popup` (bound to M-k on
      // adopt / the `[ ? keys ]` bar trigger), so it must never throw — a broken
      // render should still print something and still close on a keypress.
      try {
        const { buildCheatsheet } = await import("../packages/daemon/src/tui/chrome/cheatsheet.ts");
        console.log(buildCheatsheet({ width: process.stdout.columns ?? 100 }));
      } catch {
        console.log("tmux-ide — press ⌥p for the switcher, ⌥k for this sheet. Any key closes.");
      }
      // Wait for a single keypress, then exit 0 so the popup closes. Fall back to
      // an auto-close after 60s if stdin never delivers (e.g. no raw mode).
      const close = () => process.exit(0);
      const timer = setTimeout(close, 60_000);
      timer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", close);
        // A closed/redirected stdin (`</dev/null`, piped) hits EOF instead of
        // ever delivering a key — close on that too so the command can't hang.
        process.stdin.once("end", close);
      } catch {
        close();
      }
      break;
    }

    case "command-center": {
      const { startCommandCenter } = await import("../packages/daemon/src/command-center/index.ts");
      await startCommandCenter({ port: parseInt(values.port ?? "4000") });
      break;
    }

    case "server": {
      if ("bun" in process.versions) {
        const scriptPath = resolve(__dirname, "../packages/daemon/src/server/standalone.ts");
        const serverArgs = ["--experimental-strip-types", scriptPath];
        if (values.port) serverArgs.push("--port", values.port);
        execFileSync("node", serverArgs, { stdio: "inherit" });
      } else {
        const { start } = await import("../packages/daemon/src/server/index.ts");
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
  if (error instanceof IdeError) {
    printCommandError(error, { json });
  } else {
    throw error;
  }
}
