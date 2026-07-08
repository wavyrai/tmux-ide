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
// The node-runnable CLI path that spawned TUI surfaces shell back to (the app's
// async fleet poll + `detect --write`). When we're the published `bin/cli.js`
// this file IS it; under dev (`bun bin/cli.ts`) it's the built sibling
// `bin/cli.js`. Forwarded to surfaces as TMUX_IDE_CLI so the COMPILED TUI binary
// — whose own `import.meta.url` is a virtual bunfs path with no real cli.js next
// to it — can still find the CLI to run its subprocesses.
const selfPath = fileURLToPath(import.meta.url);
const nodeCliPath = selfPath.endsWith(".js") ? selfPath : resolve(__dirname, "cli.js");
import { launch } from "../packages/daemon/src/launch.ts";
import { resolveEntry } from "../packages/daemon/src/tui/team/entry.ts";
import { loadAppConfig } from "../packages/daemon/src/lib/app-config.ts";
import {
  resolveTuiLaunch,
  findCompiledTui,
  isBunAvailable,
} from "../packages/daemon/src/tui/compiled.ts";
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
import { restore } from "../packages/daemon/src/restore.ts";
import { send } from "../packages/daemon/src/send.ts";
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
    match: { type: "string" },
    // events command flag
    follow: { type: "boolean" },
    // force the team cockpit instead of launching a project
    team: { type: "boolean" },
    // adopt every live (non-internal) session at once
    all: { type: "boolean" },
    // restore: print the plan without touching tmux
    "dry-run": { type: "boolean" },
    // restore: replay recorded pane commands (off by default for safety)
    "run-commands": { type: "boolean" },
    // restore: revive agent conversations via `claude --resume <id>`
    "resume-agents": { type: "boolean" },
    // statusline: the session whose bar is being rendered
    active: { type: "string" },
    // switcher: the tmux client the popup was invoked on (see `switcher` case)
    client: { type: "string" },
    // team --popup: run the home cockpit as a popup over a tmux client (M-h)
    popup: { type: "boolean" },
    // sidebar-toggle: the session whose nav column is toggled (see `sidebar-toggle`)
    session: { type: "string" },
    // menu: the click position (mouse binds forward #{mouse_x}/#{mouse_y}) so the
    // actions menu opens at the pointer instead of centered (see `menu` case)
    x: { type: "string" },
    y: { type: "string" },
    // worktree: base ref for a new branch, the worktree checkout dir override,
    // skip creating a session, and force-remove a dirty worktree (see `worktree`)
    from: { type: "string" },
    dir: { type: "string" },
    "no-session": { type: "boolean" },
    force: { type: "boolean" },
  },
});

const knownCommands = new Set([
  "start",
  "init",
  "stop",
  "attach",
  "restart",
  "restore",
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
  "app",
  "switcher",
  "wait",
  "events",
  "statusline",
  "adopt",
  "unadopt",
  "agent",
  "integration",
  "chrome-updater",
  "cheatsheet",
  "welcome",
  "menu",
  "popup",
  "sidebar-toggle",
  "worktree",
  "update",
  "skill-sync",
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
  ${cyan("tmux-ide restore")} [--dry-run] [--run-commands] [--resume-agents] [--json]
                              ${dim("Rebuild the fleet from the last snapshot after a tmux crash")}
                              ${dim("(--resume-agents revives claude conversations via claude --resume)")}
  ${cyan("tmux-ide attach")}             ${dim("Reattach to a running session")}
  ${cyan("tmux-ide team")} [--json]      ${dim("TUI over all tmux sessions (--json prints fleet state)")}
  ${cyan("tmux-ide app")} [session]      ${dim("Unified app: fleet home + live session mirror (bare = home)")}
  ${cyan("tmux-ide switcher")}           ${dim("Compact session picker (opens in the M-p popup on adopted sessions)")}
  ${cyan("tmux-ide wait agent-status")} <session> --status <s> [--timeout <ms>]
                              ${dim("Block until a session reaches a status (exit 0 match / 1 timeout)")}
  ${cyan("tmux-ide wait output")} <pane|session> --match <regex> [--timeout <ms>]
                              ${dim("Block until a pane's output matches a regex (exit 0 match / 1 timeout)")}
  ${cyan("tmux-ide events")} [--follow] [--json]  ${dim("Stream agent-status transitions (needs an adopted session)")}
  ${cyan("tmux-ide adopt")} <session>    ${dim("Add the live tmux-ide status bar to a session")}
  ${cyan("tmux-ide adopt --all")}        ${dim("Adopt every live (non-internal) session")}
  ${cyan("tmux-ide unadopt")} <session>  ${dim("Remove the status bar")}
  ${cyan("tmux-ide integration install claude")}  ${dim("Authoritative agent status via Claude Code hooks")}
  ${cyan("tmux-ide agent explain")} <pane> [--json]  ${dim("Debug how a pane's agent state is detected")}
  ${cyan("tmux-ide cheatsheet")}         ${dim("Print the key cheat sheet (⌥k / [ ? keys ] popup)")}
  ${cyan("tmux-ide menu")} [--client N]  ${dim("Open the right-click actions menu (⌥m / right-click any pane or the bar)")}
  ${cyan("tmux-ide popup")} <widget>     ${dim("Open a widget as a floating panel (explorer/changes/config; ⌥e/⌥g/⌥,)")}
  ${cyan("tmux-ide sidebar-toggle")} [--session S]  ${dim("Toggle the app nav column (⌥b on adopted sessions)")}
  ${cyan("tmux-ide worktree create")} <branch> [--from <ref>] [--dir <path>] [--no-session]
                              ${dim("Add a git worktree (new branch) + open a session in it")}
  ${cyan("tmux-ide worktree open")} <branch>    ${dim("Open (or switch to) the session for an existing worktree")}
  ${cyan("tmux-ide worktree list")} [--json]    ${dim("List worktrees joined with their session status")}
  ${cyan("tmux-ide worktree remove")} <branch> [--force]  ${dim("Kill the worktree's session + remove the worktree")}
  ${cyan("tmux-ide ls")}                 ${dim("List all tmux sessions")}
  ${cyan("tmux-ide status")} [--json]    ${dim("Show session status")}
  ${cyan("tmux-ide inspect")} [--json]   ${dim("Show effective config and runtime state")}
  ${cyan("tmux-ide doctor")}             ${dim("Check system requirements")}
  ${cyan("tmux-ide update")} [--dry-run] ${dim("Update tmux-ide (detects dev checkout vs npm/pnpm/bun global)")}
  ${cyan("tmux-ide skill-sync")}         ${dim("Refresh the bundled Claude Code skill in ~/.claude/skills/tmux-ide")}
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

${bold("Discover (in the TUI):")}
  ${dim("Bare")} ${cyan("tmux-ide")} ${dim("with no ide.yml opens the HOME cockpit — the fleet home screen.")}
  ${dim("Once a session is adopted, the whole UI is one keystroke away:")}
  ${cyan("⌥h")}  ${dim("home cockpit from anywhere    ")}${cyan("⌥p")}  ${dim("switch session")}
  ${cyan("⌥k")}  ${dim("cheat sheet (all keys)        ")}${cyan("⌥m")}  ${dim("actions menu (or right-click any pane / the bar)")}
  ${cyan("⌥e ⌥g ⌥,")}  ${dim("file / changes / config panels   ")}${cyan("⌥b")}  ${dim("sidebar")}
  ${dim("A first-run welcome card names these keys once. Run")} ${cyan("tmux-ide cheatsheet")} ${dim("to see the full sheet.")}

${bold("Flags:")}
  ${cyan("--json")}                      ${dim("Output as JSON (all commands)")}
  ${cyan("--template <name>")}           ${dim("Use specific template for init")}
  ${cyan("--write")}                     ${dim("Write detected config to ide.yml")}
  ${cyan("--verbose")}                   ${dim("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan("-h, --help")}                  ${dim("Show usage")}
  ${cyan("-v, --version")}               ${dim("Show version number")}`);
}

// The TUI surfaces are OpenTUI/Solid `.tsx` that need the `bun` runtime and the
// checkout sources. On a clean `npm i -g tmux-ide` neither is present, so we
// fall back to the compiled `tmux-ide-tui` binary (see scripts/build-tui.mjs).
// `resolveTuiLaunch` encodes the "checkout first, binary second" order; when
// nothing is available it hands back an actionable reason set for an IdeError.
function execBunWidget(
  surface: string,
  scriptPath: string,
  args: string[],
  commandLabel: string,
  extraEnv: Record<string, string> = {},
): void {
  const launch = resolveTuiLaunch({
    surface,
    scriptPath,
    args,
    checkoutExists: existsSync(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui(),
  });

  if (launch.mode === "unavailable") {
    throw new IdeError(
      `\`tmux-ide ${commandLabel}\` is unavailable because ${launch.reasons.join(" and ")}.\n` +
        `Install bun (https://bun.sh) — the TUI surfaces run on it. Sources ship with the npm package since v2.6.1.`,
      { code: "USAGE", exitCode: 1 },
    );
  }

  const env = {
    ...process.env,
    TMUX_IDE_CWD: process.cwd(),
    TMUX_IDE_CLI: nodeCliPath,
    ...extraEnv,
  };
  if (launch.mode === "bun") {
    // Spawn from the repo root so bun finds `bunfig.toml` (the @opentui/solid
    // JSX preload). Without this, running from any other cwd — e.g. bare
    // `tmux-ide` in a project dir — falls back to the React JSX runtime and the
    // widget fails to load. The real invocation dir rides in env so in-widget
    // prompts (register / new session) still default to where the user is.
    execFileSync(launch.bin, launch.argv, {
      stdio: "inherit",
      cwd: resolve(__dirname, ".."),
      env,
    });
    return;
  }

  // Compiled binary: the JSX transform and native dylib are already baked in,
  // so there is no bunfig to find — run from the user's actual cwd (also avoids
  // a stray repo-root bunfig.toml preload the standalone binary can't resolve).
  execFileSync(launch.bin, launch.argv, { stdio: "inherit", env });
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
const appScriptPath = resolve(__dirname, "../packages/daemon/src/tui/mirror/app.tsx");

// `tmux-ide team` runs the standalone full-screen cockpit (the OpenTUI app owns
// the whole terminal). The floating switcher popup (M-p on adopted sessions)
// supersedes the old nested `[ switcher | main ]` host shell.
function launchTeamCockpit(): void {
  execBunWidget("team", teamScriptPath, [], "team");
}

// The unified app as the front door (M22.6): bare `tmux-ide` opens `tmux-ide
// app`'s HOME panel when `app.frontDoor` is on and there's nothing else to
// launch. Same entry as the explicit `app` command with no session positional.
function launchApp(): void {
  execBunWidget("app", appScriptPath, [], "app");
}

try {
  switch (command) {
    case "start": {
      // npm-style staleness nudge: one dim stderr line when a newer version is
      // cached (never on --json, never blocking — best-effort, and stderr so it
      // can't corrupt piped stdout). The dock is the primary surface; this is the
      // hint for the moment you actually run the command.
      if (!json) {
        try {
          const { getUpdateStatus } = await import("../packages/daemon/src/lib/update-check.ts");
          const { latest, updateAvailable } = getUpdateStatus();
          if (updateAvailable && latest) {
            process.stderr.write(
              dim(`⬆ tmux-ide v${latest} available — run \`tmux-ide update\`\n`),
            );
          }
        } catch {
          // never let the update hint interfere with launching
        }
      }
      const targetDir = resolve(startTargetDir || ".");
      const hasIdeYml = existsSync(join(targetDir, "ide.yml"));
      // M22.6 — the front-door decision. `--team` always means the classic
      // cockpit; a present ide.yml still auto-launches the project; otherwise
      // `app.frontDoor` flips the default no-project entry to the unified app.
      const entry = resolveEntry({
        hasIdeYml,
        teamFlag: values.team === true,
        frontDoor: loadAppConfig().app.frontDoor,
      });
      if (entry !== "project") {
        // No project to launch here. `--json` is a scripting surface — it always
        // prints the fleet, whichever interactive front door is configured.
        if (json) {
          await printFleetJson();
          break;
        }
        if (entry === "app") launchApp();
        else launchTeamCockpit();
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

    case "restore":
      await restore({
        json,
        dryRun: values["dry-run"] === true,
        runCommands: values["run-commands"] === true,
        resumeAgents: values["resume-agents"] === true,
      });
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
          "setup",
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
      execBunWidget("setup", scriptPath, setupArgs, "setup");
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
      execBunWidget("config", scriptPath, ["--dir=" + resolve(startTargetDir || ".")], "settings");
      break;
    }

    case "team": {
      // `--json` is the scriptable control surface: print the fleet state and
      // exit without spawning the (bun/OpenTUI) TUI.
      if (json) {
        await printFleetJson();
        break;
      }
      // `--popup` runs the FULL home cockpit inside a tmux `display-popup` (bound
      // to `M-h` on adopt / the dock's `[ ⌂ home ⌥h ]` trigger). Like the
      // switcher, `TMUX_IDE_POPUP_CLIENT` flips popup mode (Enter switch-clients
      // the invoking client + closes) and carries an optional explicit client;
      // empty means "resolve it yourself from inside the popup". Unlike the
      // switcher it keeps the full two-column layout, not the compact picker.
      if (values.popup === true) {
        const clientArg = typeof values.client === "string" ? values.client : "";
        execBunWidget("team", teamScriptPath, [], "team --popup", {
          TMUX_IDE_POPUP_CLIENT: clientArg,
        });
        break;
      }
      launchTeamCockpit();
      break;
    }

    case "app": {
      // The unified app (M18.1): sidebar fleet + a live tmux-session mirror.
      // Bare `tmux-ide app` opens the HOME panel (fleet cards); an optional
      // session positional boots straight into that session's mirror.
      const session = positionals[1];
      const appArgs = session ? [`--target=${session}`] : [];
      execBunWidget("app", appScriptPath, appArgs, "app");
      break;
    }

    case "switcher": {
      // Runs the team app in PICKER mode inside a tmux `display-popup` (bound to
      // `M-p` on adopt). Picking a session `switch-client`s the invoking client
      // there and the app exits, closing the popup. `TMUX_IDE_PICKER_CLIENT`
      // both flips the app into picker mode and carries an optional explicit
      // client name; empty means "resolve it yourself from inside the popup".
      const clientArg = typeof values.client === "string" ? values.client : "";
      execBunWidget("team", teamScriptPath, [], "switcher", { TMUX_IDE_PICKER_CLIENT: clientArg });
      break;
    }

    case "wait": {
      const sub = positionals[1];

      // `wait output <pane|session> --match <regex>` — block until a pane's
      // captured text matches. The target may be a pane id (%N) or a session
      // name; tmux resolves both (a session targets its active pane).
      if (sub === "output") {
        const target = positionals[2];
        const pattern = values.match;
        if (!target || typeof pattern !== "string" || pattern.length === 0) {
          console.error(
            "Usage: tmux-ide wait output <pane|session> --match <regex> [--timeout <ms>]",
          );
          process.exit(1);
        }
        try {
          new RegExp(pattern!); // validate up front; a bad pattern is a usage error
        } catch (err) {
          console.error(`Invalid --match regex: ${(err as Error).message}`);
          process.exit(1);
        }
        const { capturePane } = await import("../packages/tmux-bridge/src/index.ts");
        const outTimeout = Number(values.timeout ?? "60000");
        const outStart = Date.now();
        const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
        while (true) {
          let text = "";
          try {
            text = capturePane(target!, { lines: 200 });
          } catch {
            // pane/session not (yet) available — keep polling until timeout
          }
          const lines = text.split("\n");
          // Fresh regex per test so a user-supplied /g flag can't carry lastIndex
          // between calls. Report the specific matching line when we can.
          let hit: string | null = null;
          for (const line of lines) {
            if (new RegExp(pattern!).test(line)) {
              hit = line;
              break;
            }
          }
          if (hit === null && new RegExp(pattern!).test(text)) hit = lines[lines.length - 1] ?? "";
          if (hit !== null) {
            if (json) console.log(JSON.stringify({ matched: hit }));
            else console.log(hit);
            process.exit(0);
          }
          if (Date.now() - outStart >= outTimeout) {
            console.error(
              `Timed out after ${outTimeout}ms waiting for ${target} output to match /${pattern}/`,
            );
            process.exit(1);
          }
          await nap(500);
        }
      }

      const { createStatusTracker } = await import("../packages/daemon/src/tui/detect/classify.ts");
      const { listTeamSessions } = await import("../packages/daemon/src/tui/team/sessions.ts");
      const { findSessionStatus } = await import("../packages/daemon/src/tui/team/report.ts");

      const VALID = new Set(["blocked", "working", "done", "idle", "unknown"]);
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

    case "events": {
      // Stream agent-status transitions from the log the chrome updater writes.
      const { readFileSync, existsSync, statSync, openSync, readSync, closeSync } =
        await import("node:fs");
      const { eventsPath, formatEventLine } =
        await import("../packages/daemon/src/tui/chrome/events.ts");
      type Status = "blocked" | "working" | "done" | "idle" | "unknown";
      type EventLike = { ts: string; session: string; from: Status | null; to: Status };

      const path = eventsPath();
      if (!existsSync(path)) {
        console.log("no events yet — is a session adopted? (the chrome updater writes events)");
        break;
      }

      // Status → ANSI color, matching the chrome bar's palette in spirit.
      const paintStatus = (status: Status | null, text: string): string => {
        if (noColor || status === null) return text;
        const code =
          status === "blocked"
            ? "203"
            : status === "working"
              ? "221"
              : status === "done"
                ? "111"
                : status === "idle"
                  ? "114"
                  : "244";
        return `\x1b[38;5;${code}m${text}\x1b[39m`;
      };
      const printLine = (raw: string): void => {
        if (json) {
          console.log(raw);
          return;
        }
        try {
          const ev = JSON.parse(raw) as EventLike;
          console.log(formatEventLine(ev, paintStatus));
        } catch {
          // skip malformed line
        }
      };

      const allLines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      for (const line of allLines.slice(-50)) printLine(line);

      if (!values.follow) break;

      // Follow: poll the file for appended bytes and stream complete new lines.
      let offset = statSync(path).size;
      let leftover = "";
      const timer = setInterval(() => {
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          return;
        }
        if (size < offset) {
          // rotated/truncated — restart from the top of the new file
          offset = 0;
          leftover = "";
        }
        if (size <= offset) return;
        const fd = openSync(path, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          const parts = (leftover + buf.toString("utf8")).split("\n");
          leftover = parts.pop() ?? "";
          for (const line of parts) if (line.trim().length > 0) printLine(line);
        } finally {
          closeSync(fd);
        }
      }, 500);
      process.on("SIGINT", () => {
        clearInterval(timer);
        process.exit(0);
      });
      // Keep the process alive; the interval + SIGINT handler own the lifecycle.
      await new Promise(() => {});
      break;
    }

    case "statusline": {
      // Called by tmux via #() every status-interval — keep it lean and never
      // let an error corrupt the bar (print a minimal brand instead).
      try {
        const { createStatusTracker } =
          await import("../packages/daemon/src/tui/detect/classify.ts");
        const { listTeamProjects } = await import("../packages/daemon/src/tui/team/projects.ts");
        const { buildStatusline } = await import("../packages/daemon/src/tui/chrome/statusline.ts");
        const { getAppConfig } = await import("../packages/daemon/src/lib/app-config.ts");
        const projects = listTeamProjects(createStatusTracker());
        console.log(buildStatusline(projects, values.active ?? null, 12, getAppConfig().theme));
      } catch {
        console.log("#[fg=colour75,bold] tmux-ide #[default]");
      }
      break;
    }

    case "adopt": {
      const { adoptSession, adoptableSessionNames } =
        await import("../packages/daemon/src/tui/chrome/statusline.ts");
      if (values.all) {
        // Adopt every live session that isn't internal (`_`-prefixed plumbing).
        const raw = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const targets = raw ? adoptableSessionNames(raw.split("\n")) : [];
        if (targets.length === 0) {
          console.log("no adoptable sessions");
          break;
        }
        for (const name of targets) {
          adoptSession(name);
          console.log(`adopted ${name}`);
        }
        break;
      }
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide adopt <session> | tmux-ide adopt --all");
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

    case "agent": {
      const sub = positionals[1];
      const target = positionals[2];
      if (sub !== "explain" || !target) {
        console.error(
          "Usage: tmux-ide agent explain <pane> [--json]\n" +
            "  <pane>  a pane id (%N) or a session name (uses its active pane)\n" +
            "  Prints how the fleet detector classifies the pane: authority,\n" +
            "  hint, resolved manifest, per-state rule results, and the snapshot.",
        );
        process.exit(1);
      }
      const { agentExplain } = await import("../packages/daemon/src/agent-explain.ts");
      agentExplain(target, { json });
      break;
    }

    case "integration": {
      const sub = positionals[1];
      const agent = positionals[2];
      // `status` and `offer` need no agent arg; install/uninstall are claude-only.
      const needsClaude = sub === "install" || sub === "uninstall";
      if (!sub || (needsClaude && agent !== "claude")) {
        console.error(
          "Usage: tmux-ide integration <install|uninstall|status|offer> [claude]\n" +
            "  install    hook Claude Code lifecycle events into tmux pane state\n" +
            "  uninstall  remove exactly the tmux-ide hook entries\n" +
            "  status     list discovered agents + integration state\n" +
            "  offer      one-time first-adopt install prompt (used by the popup)",
        );
        process.exit(1);
      }
      const mod = await import("../packages/daemon/src/tui/integrations/claude.ts");
      if (sub === "install") {
        const { scriptPath, settingsPath } = mod.installClaudeIntegration();
        // Hooks + skill = the complete agent setup, so one command does both:
        // the lifecycle hooks (authoritative status) AND a fresh copy of the
        // skill that tells the agent how to drive tmux-ide.
        const { syncSkill } = await import("../packages/daemon/src/lib/skill-sync.ts");
        const skill = syncSkill();
        console.log(`hook script: ${scriptPath}`);
        console.log(`settings:    ${settingsPath} (backup written once as .tmux-ide.bak)`);
        console.log(`skill:       ${skill.action} → ${skill.path} (v${skill.to})`);
        console.log(
          "installed — NEW Claude Code sessions now report working/blocked/done " +
            "authoritatively into the tmux-ide chrome.",
        );
      } else if (sub === "uninstall") {
        const { wasInstalled } = mod.uninstallClaudeIntegration();
        console.log(wasInstalled ? "uninstalled — hook entries removed" : "was not installed");
      } else if (sub === "offer") {
        // The one-time first-adopt prompt, run inside a `display-popup` by
        // adoptSession (see ../packages/daemon/src/tui/integrations/offer.ts). It
        // reads ONE key: `y` installs, anything else skips — and writes the
        // marker either way so it never asks twice. Must never throw or hang.
        const offerMod = await import("../packages/daemon/src/tui/integrations/offer.ts");
        try {
          console.log(offerMod.buildOfferText());
        } catch {
          console.log("Claude Code detected — install the tmux-ide integration? [y/N]");
        }
        const act = (key: string): void => {
          offerMod.markIntegrationOffered();
          if (key === "y" || key === "Y") {
            try {
              mod.installClaudeIntegration();
              console.log("\ninstalled — new Claude Code sessions now report state to tmux-ide.");
            } catch (e) {
              console.log(`\ninstall failed: ${(e as Error).message}`);
            }
          } else {
            console.log("\nskipped — run `tmux-ide integration install claude` anytime.");
          }
        };
        // Test/automation hook: a forced key exits immediately, no stdin — lets
        // the offer flow be exercised deterministically without a live keypress.
        const forced = process.env.TMUX_IDE_OFFER_KEY;
        if (forced !== undefined) {
          act(forced);
          process.exit(0);
        }
        const closeOffer = () => process.exit(0);
        const offerTimer = setTimeout(closeOffer, 60_000);
        offerTimer.unref?.();
        try {
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.once("data", (data) => {
            act(data.toString());
            console.log("\n[ press any key to close ]");
            process.stdin.once("data", closeOffer);
            process.stdin.once("end", closeOffer);
          });
          process.stdin.once("end", closeOffer);
        } catch {
          closeOffer();
        }
      } else {
        // status — the discovery table: every known agent, whether it's on PATH,
        // and (for agents we integrate) whether the integration is installed.
        const { discoverAgents } = await import("../packages/daemon/src/lib/agent-discovery.ts");
        const agents = discoverAgents();
        if (json) {
          console.log(JSON.stringify({ agents }, null, 2));
          break;
        }
        for (const a of agents) {
          let state: string;
          if (a.path === null) state = "not found";
          else if (a.integration)
            state = a.installed ? "integration installed ✓" : "on PATH — integration not installed";
          else state = "detected (no integration)";
          console.log(`  ${a.id.padEnd(10)} ${state}`);
        }
      }
      break;
    }

    case "chrome-updater": {
      // The background loop that keeps every adopted session's status var fresh.
      // Hosted in the hidden `_tmux-ide-chrome` tmux session (started on adopt);
      // blocks forever. Never let a boot error crash it — a dead updater just
      // means stale bars, not broken sessions.
      try {
        const { runUpdaterLoop } = await import("../packages/daemon/src/tui/chrome/updater.ts");
        runUpdaterLoop();
      } catch {
        process.exit(0);
      }
      break;
    }

    case "cheatsheet": {
      // Renders the static key cheat sheet, then blocks until ANY key closes it
      // (the popup exits). Runs inside a tmux `display-popup` (bound to M-k on
      // adopt / the `[ ? keys ]` bar trigger), so it must never throw — a broken
      // render should still print something and still close on a keypress.
      try {
        const { buildCheatsheet } = await import("../packages/daemon/src/tui/chrome/cheatsheet.ts");
        const { getAppConfig } = await import("../packages/daemon/src/lib/app-config.ts");
        const cfg = getAppConfig();
        console.log(
          buildCheatsheet({
            width: process.stdout.columns ?? 100,
            keys: cfg.keys,
            theme: cfg.theme,
          }),
        );
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

    case "welcome": {
      // Prints the one-time first-run welcome card, then blocks until ANY key
      // closes it (the popup exits). Floated by `adoptSession` via a
      // `display-popup -E "tmux-ide welcome"` on first adopt (see
      // ./chrome/welcome.ts). Mirrors the cheatsheet case — must never throw, and
      // must close on a key / EOF / a 60s fallback so the popup can't hang.
      try {
        const { buildWelcomeText } = await import("../packages/daemon/src/tui/chrome/welcome.ts");
        const { getAppConfig } = await import("../packages/daemon/src/lib/app-config.ts");
        console.log(buildWelcomeText(getAppConfig().keys));
      } catch {
        console.log(
          "Welcome to tmux-ide. Right-click for the menu · ⌥h home · ⌥p switch · ⌥k all keys.",
        );
      }
      const closeWelcome = () => process.exit(0);
      const welcomeTimer = setTimeout(closeWelcome, 60_000);
      welcomeTimer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", closeWelcome);
        process.stdin.once("end", closeWelcome);
      } catch {
        closeWelcome();
      }
      break;
    }

    case "menu": {
      // Build the native tmux actions menu at CLICK TIME (the session list is
      // live) and display it on the invoking client. Bound via `run-shell -b` so
      // `#{client_name}` format-expands into `--client` (verified live on tmux
      // 3.6 — it resolves to the triggering / most-recently-active client). Runs
      // inside tmux's key/mouse dispatch, so it must never throw or HANG — every
      // tmux call below is capped at 2s and a missing client degrades to a no-op.
      try {
        // Every tmux shell-out gets a hard 2s cap: the old fallback
        // (`display-message -p '#{client_name}'` from outside a client) could
        // block indefinitely and wedge the bind. `timeout` throws on expiry,
        // caught below → silent no-op.
        const tmuxCap = {
          encoding: "utf8" as const,
          stdio: ["ignore", "pipe", "ignore"] as const,
          timeout: 2000,
        };
        // Resolve the target client. Prefer the `--client` the bind expanded; if
        // it's empty or an unexpanded `#{…}` literal, fall back to the
        // most-recently-active attached client (list-clients sorted by
        // client_activity desc). No clients at all → exit 0 silently (fired from
        // tmux dispatch, a no-op beats an error).
        const rawClient = typeof values.client === "string" ? values.client : "";
        let client = rawClient && !rawClient.includes("#{") ? rawClient : "";
        if (!client) {
          const raw = execFileSync(
            "tmux",
            ["list-clients", "-F", "#{client_activity} #{client_name}"],
            tmuxCap,
          ).trim();
          const newest = raw
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const sp = line.indexOf(" ");
              return { activity: Number(line.slice(0, sp)), name: line.slice(sp + 1) };
            })
            .sort((a, b) => b.activity - a.activity)[0];
          client = newest?.name ?? "";
        }
        if (!client) break; // no attached clients — nothing to show
        const { createStatusTracker } =
          await import("../packages/daemon/src/tui/detect/classify.ts");
        const { listTeamSessions } = await import("../packages/daemon/src/tui/team/sessions.ts");
        const { buildMenu, menuPositionArgs } =
          await import("../packages/daemon/src/tui/chrome/menu.ts");
        const { getAppConfig } = await import("../packages/daemon/src/lib/app-config.ts");
        const { getUpdateStatus } = await import("../packages/daemon/src/lib/update-check.ts");
        // listTeamSessions already drops internal `_`-prefixed plumbing.
        const sessions = listTeamSessions(createStatusTracker()).map((s) => ({
          name: s.name,
          status: s.status,
        }));
        // Position flags from a mouse bind's forwarded coords; empty (→ centered)
        // for the keyboard path or unexpanded #{mouse_*} literals. Must precede
        // the menu spec (buildMenu opens with -T), so they slot in right after -c.
        const position = menuPositionArgs(
          typeof values.x === "string" ? values.x : undefined,
          typeof values.y === "string" ? values.y : undefined,
        );
        const args = [
          "display-menu",
          "-c",
          client,
          ...position,
          ...buildMenu(sessions, getAppConfig().theme, getUpdateStatus()),
        ];
        execFileSync("tmux", args, { stdio: "ignore", timeout: 2000 });
      } catch {
        // no client / tmux unavailable / a call timed out — nothing to show
      }
      break;
    }

    case "popup": {
      // Open a widget as a floating panel. This CLI invocation IS the popup
      // process (a root-table key or a menu row ran `display-popup -E "tmux-ide
      // popup <widget>"`), so we exec the bun widget SYNCHRONOUSLY into the
      // popup's PTY; when the widget exits (esc/q) the popup closes.
      const { POPUP_WIDGETS } = await import("../packages/daemon/src/tui/chrome/panels.ts");
      const widget = positionals[1];
      if (!widget || !POPUP_WIDGETS.includes(widget)) {
        throw new IdeError(
          `Usage: tmux-ide popup <widget>\nKnown panels: ${POPUP_WIDGETS.join(", ")}.`,
          { code: "USAGE", exitCode: 1 },
        );
      }
      // Resolve the widget entry from THIS file's dir (bin/), mirroring the
      // setup/config cases — the bundler rewrites `import.meta.url` to the bin/
      // bundle, so a `resolve.ts`-relative path would miss the sources.
      const scriptPath = resolve(__dirname, "../packages/daemon/src/widgets", widget, "index.tsx");
      // The popup opened with `-d '#{pane_current_path}'`, so our cwd IS the
      // pane's project dir — forward it as `--dir`. Resolve the session so the
      // widget's tmux side-channels (preview file, "send to claude") target it;
      // best-effort — an empty session just disables those (the widget still
      // renders and browses).
      let popupSession = "";
      try {
        popupSession = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        }).trim();
      } catch {
        // not inside a tmux client — leave session empty
      }
      const popupArgs = [`--dir=${process.cwd()}`];
      if (popupSession) popupArgs.push(`--session=${popupSession}`);
      execBunWidget(widget, scriptPath, popupArgs, `popup ${widget}`);
      break;
    }

    case "sidebar-toggle": {
      // Toggle the app nav column in a session (bound to `keys.sidebar`, default
      // M-b, via `run-shell` which expands `--session '#{session_name}'`). If a
      // sidebar pane already exists → close it; else split a full-height left
      // column running the sidebar widget. Runs inside tmux key dispatch, so it
      // stays best-effort — a failure is a silent no-op, never a wedged bind.
      try {
        const {
          findSidebarPane,
          openSidebarPane,
          closeSidebarPane,
          resolveSidebarConfig,
          DEFAULT_SIDEBAR_WIDTH,
        } = await import("../packages/daemon/src/tui/chrome/sidebar.ts");
        // Resolve the target session: the explicit --session, else the invoking
        // client's session via display-message.
        let session = typeof values.session === "string" ? values.session.trim() : "";
        if (!session || session.includes("#{")) {
          try {
            session = execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 2000,
            }).trim();
          } catch {
            session = "";
          }
        }
        if (!session) break; // no session context — nothing to toggle
        const existing = findSidebarPane(session);
        if (existing) {
          closeSidebarPane(existing);
          break;
        }
        // Opening: resolve the session's cwd + best-effort sidebar width/theme
        // from an ide.yml there (any adopted session may have none → defaults).
        const { getSessionCwd } = await import("../packages/tmux-bridge/src/index.ts");
        let dir = process.cwd();
        try {
          dir = getSessionCwd(session) ?? dir;
        } catch {
          // no cwd — fall back to the CLI's cwd
        }
        let width = DEFAULT_SIDEBAR_WIDTH;
        let theme = null;
        try {
          const { readConfig } = await import("../packages/daemon/src/lib/yaml-io.ts");
          const { config } = readConfig(dir);
          theme = config.theme ?? null;
          const sb = resolveSidebarConfig(config.sidebar);
          if (sb.enabled) width = sb.width;
        } catch {
          // no/invalid ide.yml — defaults are fine
        }
        openSidebarPane(session, dir, width, theme);
      } catch {
        // tmux unavailable / widget missing — silent no-op (fired from a bind)
      }
      break;
    }

    case "worktree": {
      const sub = positionals[1];
      const KNOWN_SUBS = new Set(["create", "open", "list", "remove"]);
      if (!sub || !KNOWN_SUBS.has(sub)) {
        throw new IdeError(
          "Usage: tmux-ide worktree <create|open|list|remove> <branch> [flags]\n" +
            "  create <branch> [--from <ref>] [--dir <path>] [--no-session]\n" +
            "  open <branch>\n" +
            "  list [--json]\n" +
            "  remove <branch> [--force]",
          { code: "USAGE", exitCode: 1 },
        );
      }

      const {
        worktreeSessionName,
        worktreePath,
        listWorktrees,
        createWorktree,
        removeWorktree,
        WorktreeError,
      } = await import("../packages/daemon/src/lib/worktree.ts");
      const { getSessionName } = await import("../packages/daemon/src/lib/yaml-io.ts");
      const { getSessionCwd, hasSession, killSession, createDetachedSession } =
        await import("../packages/tmux-bridge/src/index.ts");

      // The repo the command targets: the --session's cwd when invoked from the
      // menu (run-shell's own cwd is the tmux server's, not the pane's — verified
      // live), else the CLI's cwd.
      let repoDir = process.cwd();
      const sessionArg = typeof values.session === "string" ? values.session.trim() : "";
      if (sessionArg && !sessionArg.includes("#{")) {
        try {
          const cwd = getSessionCwd(sessionArg);
          if (cwd) repoDir = cwd;
        } catch {
          // fall back to the CLI cwd
        }
      }

      // The project identity for session names: the MAIN worktree's ide.yml name
      // (or its dir basename). `git worktree list` returns the main checkout first.
      const worktrees = listWorktrees(repoDir);
      const mainPath = worktrees[0]?.path ?? repoDir;
      const projectName = getSessionName(mainPath).name;

      // Start a session in a worktree checkout: full IDE layout when it has an
      // ide.yml (launch under the worktree's own session name so it never
      // collides with the parent repo's session), else a plain adopted session.
      // Never auto-attaches — the caller may be inside tmux (the menu) — it prints
      // how to switch instead.
      async function openWorktreeSession(wtPath: string, name: string): Promise<void> {
        if (existsSync(join(wtPath, "ide.yml"))) {
          await launch(wtPath, { attach: false, sessionName: name });
        } else {
          if (!hasSession(name)) createDetachedSession(name, wtPath);
          const { adoptSession } = await import("../packages/daemon/src/tui/chrome/statusline.ts");
          adoptSession(name);
        }
      }

      function printSwitchHint(name: string, wtPath: string): void {
        console.log(`Worktree ready: ${wtPath}`);
        console.log(`Session: ${name}`);
        if (process.env.TMUX) {
          console.log(`Switch to it:  tmux switch-client -t '${name}'`);
        } else {
          console.log(`Attach to it:  tmux attach -t '${name}'`);
        }
      }

      if (sub === "create") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError(
            "Usage: tmux-ide worktree create <branch> [--from <ref>] [--dir <path>] [--no-session]",
            { code: "USAGE", exitCode: 1 },
          );
        }
        const { getAppConfig } = await import("../packages/daemon/src/lib/app-config.ts");
        const dirOverride =
          typeof values.dir === "string" && values.dir.length > 0
            ? values.dir
            : getAppConfig().worktrees.dir || null;
        const wtPath = worktreePath(repoDir, branch, dirOverride);
        const from = typeof values.from === "string" ? values.from : null;

        // Default: create a NEW branch off `from` (HEAD when absent). If the
        // branch already exists and no explicit base was given, fall back to
        // checking it out into the worktree instead of failing.
        try {
          createWorktree(repoDir, branch, wtPath, { newBranch: true, from });
        } catch (err) {
          if (err instanceof WorktreeError && err.code === "BRANCH_EXISTS" && !from) {
            createWorktree(repoDir, branch, wtPath, { newBranch: false });
          } else {
            throw err;
          }
        }

        const sessionName = worktreeSessionName(projectName, branch);
        if (!values["no-session"]) {
          await openWorktreeSession(wtPath, sessionName);
        }

        if (json) {
          console.log(
            JSON.stringify({
              branch,
              path: wtPath,
              session: values["no-session"] ? null : sessionName,
            }),
          );
        } else if (values["no-session"]) {
          console.log(`Worktree ready: ${wtPath}`);
          console.log(`Open a session later:  tmux-ide worktree open '${branch}'`);
        } else {
          printSwitchHint(sessionName, wtPath);
        }
        break;
      }

      if (sub === "open") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree open <branch>", {
            code: "USAGE",
            exitCode: 1,
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(
            `No worktree for branch "${branch}". Create one with: tmux-ide worktree create '${branch}'`,
            { code: "USAGE", exitCode: 1 },
          );
        }
        const sessionName = worktreeSessionName(projectName, branch);
        const already = hasSession(sessionName);
        if (!already) await openWorktreeSession(entry.path, sessionName);
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, session: sessionName, created: !already }),
          );
        } else {
          if (already) console.log(`Session already running.`);
          printSwitchHint(sessionName, entry.path);
        }
        break;
      }

      if (sub === "remove") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree remove <branch> [--force]", {
            code: "USAGE",
            exitCode: 1,
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(`No worktree for branch "${branch}".`, {
            code: "USAGE",
            exitCode: 1,
          });
        }
        // Remove the worktree FIRST so a failed removal (e.g. dirty without
        // --force, which throws here) never orphan-kills the still-usable
        // session. Only after a clean removal do we kill ONLY this worktree's
        // own session (never the parent repo's or a user session — the name is
        // fully derived from the worktree's branch).
        removeWorktree(repoDir, entry.path, { force: values.force === true });
        const sessionName = worktreeSessionName(projectName, branch);
        const killed = hasSession(sessionName) ? killSession(sessionName).stopped : false;
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, sessionKilled: killed, removed: true }),
          );
        } else {
          console.log(`Removed worktree ${entry.path}${killed ? ` (killed ${sessionName})` : ""}.`);
        }
        break;
      }

      // sub === "list"
      const { createStatusTracker } = await import("../packages/daemon/src/tui/detect/classify.ts");
      const { listTeamSessions } = await import("../packages/daemon/src/tui/team/sessions.ts");
      const sessions = listTeamSessions(createStatusTracker());
      const rows = worktrees.map((wt) => {
        const isPrimary = wt.path === mainPath;
        const candidates: string[] = [];
        if (isPrimary) candidates.push(projectName);
        if (wt.branch) candidates.push(worktreeSessionName(projectName, wt.branch));
        const match = sessions.find((s) => candidates.includes(s.name)) ?? null;
        return {
          path: wt.path,
          branch: wt.branch,
          primary: isPrimary,
          session: match?.name ?? null,
          running: match !== null,
          status: match?.status ?? null,
        };
      });
      if (json) {
        console.log(JSON.stringify({ repo: mainPath, worktrees: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log("No worktrees.");
      } else {
        for (const r of rows) {
          const tag = r.primary ? " (primary)" : "";
          const state = r.running ? `${r.status} · ${r.session}` : "no session";
          console.log(`${r.branch ?? "(detached)"}${tag}  ${state}\n    ${r.path}`);
        }
      }
      break;
    }

    case "update": {
      // `--tui-binary`: download the per-platform TUI binary (the fallback that
      // lets an npm install with no bun run the full cockpit). Explicit opt-in —
      // never auto-fetched on install (it's ~70MB). See lib/tui-binary.ts.
      if (values["tui-binary"] === true) {
        const { downloadTuiBinary } = await import("../packages/daemon/src/lib/tui-binary.ts");
        const { path } = await downloadTuiBinary({ log: (m) => console.error(m) });
        if (json) {
          console.log(JSON.stringify({ ok: true, path }, null, 2));
        } else {
          console.log(`TUI binary ready: ${path}`);
        }
        break;
      }
      // Detect how tmux-ide was installed and act on the pending update: a dev
      // checkout prints the `git pull` hint; a global install prints (with
      // --dry-run) or runs its package manager's update command. `__dirname` is
      // this CLI's own directory — the anchor for the git-checkout probe + the
      // package-manager path heuristic (see lib/update.ts).
      const { runUpdate } = await import("../packages/daemon/src/lib/update.ts");
      const dryRun = values["dry-run"] === true;
      const plan = runUpdate({ cliDir: __dirname, dryRun });
      if (!dryRun) {
        // The managed skill copy has to track the CLI. A global install refreshes
        // it via the package's own postinstall (which just ran); a dev checkout
        // has no postinstall, so `tmux-ide update` IS the checkout's refresh path
        // — sync the skill directly here.
        const { syncSkill } = await import("../packages/daemon/src/lib/skill-sync.ts");
        if (plan.method === "dev") {
          const result = syncSkill();
          console.log("");
          console.log(`skill: ${result.action} → ${result.path} (v${result.to})`);
        } else {
          console.log("");
          console.log("skill: refreshed by the package postinstall (~/.claude/skills/tmux-ide)");
        }
      }
      break;
    }

    case "skill-sync": {
      // The universal manual refresh of the managed Claude Code skill copy.
      // Fully-managed dir: overwrite is correct; version-equal is a no-op.
      const { syncSkill } = await import("../packages/daemon/src/lib/skill-sync.ts");
      const result = syncSkill();
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const detail =
          result.action === "updated" && result.from
            ? ` (v${result.from} → v${result.to})`
            : ` (v${result.to})`;
        console.log(`skill ${result.action}${detail}: ${result.path}`);
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
