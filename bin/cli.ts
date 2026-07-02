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
  ${cyan("tmux-ide restore")} [--dry-run] [--run-commands] [--json]
                              ${dim("Rebuild the fleet from the last snapshot after a tmux crash")}
  ${cyan("tmux-ide attach")}             ${dim("Reattach to a running session")}
  ${cyan("tmux-ide team")} [--json]      ${dim("TUI over all tmux sessions (--json prints fleet state)")}
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

// `tmux-ide team` runs the standalone full-screen cockpit (the OpenTUI app owns
// the whole terminal). The floating switcher popup (M-p on adopted sessions)
// supersedes the old nested `[ switcher | main ]` host shell.
function launchTeamCockpit(): void {
  execBunWidget(teamScriptPath, [], "team");
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
        launchTeamCockpit();
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
      launchTeamCockpit();
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
        const projects = listTeamProjects(createStatusTracker());
        console.log(buildStatusline(projects, values.active ?? null));
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
      if (!sub || (sub !== "status" && agent !== "claude")) {
        console.error(
          "Usage: tmux-ide integration <install|uninstall|status> claude\n" +
            "  install    hook Claude Code lifecycle events into tmux pane state\n" +
            "  uninstall  remove exactly the tmux-ide hook entries\n" +
            "  status     show whether the integration is installed",
        );
        process.exit(1);
      }
      const mod = await import("../packages/daemon/src/tui/integrations/claude.ts");
      if (sub === "install") {
        const { scriptPath, settingsPath } = mod.installClaudeIntegration();
        console.log(`hook script: ${scriptPath}`);
        console.log(`settings:    ${settingsPath} (backup written once as .tmux-ide.bak)`);
        console.log(
          "installed — NEW Claude Code sessions now report working/blocked/done " +
            "authoritatively into the tmux-ide chrome.",
        );
      } else if (sub === "uninstall") {
        const { wasInstalled } = mod.uninstallClaudeIntegration();
        console.log(wasInstalled ? "uninstalled — hook entries removed" : "was not installed");
      } else {
        const s = mod.claudeIntegrationStatus();
        console.log(`claude: ${s.installed ? "installed" : "not installed"}`);
        if (json) console.log(JSON.stringify(s));
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
