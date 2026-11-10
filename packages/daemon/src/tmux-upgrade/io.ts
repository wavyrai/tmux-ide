/**
 * The real io behind `tmux-ide servers upgrade` (#766). Every tmux call names
 * its server with `-S <socket>`; nothing here reaches a server by default.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { configureTmuxClientResolver } from "@tmux-ide/tmux-bridge";
import { restoreFleet } from "../restore.ts";
import {
  collectFleetSnapshot,
  readSnapshot,
  resolvePaneCommand,
  SNAPSHOT_PANE_FORMAT,
  SNAPSHOT_SESSION_FORMAT,
  type FleetSnapshot,
} from "../tui/chrome/snapshot.ts";
import { readProcessTable } from "../tui/detect/process-tree.ts";
import { isListableSession } from "../tui/team/sessions.ts";
import { resolveBundledTmux, withBundledTmuxResources } from "../lib/bundled-tmux.ts";
import { IdeError } from "../lib/errors.ts";
import { resolveRuntimeNamespace } from "../lib/runtime-namespace.ts";
import {
  nativeCommands,
  type ServerFeatures,
  type TmuxProbe,
} from "../lib/tmux-server-features.ts";
import { COVERAGE_PANE_FORMAT } from "./plan.ts";
import type { ServerFacts, UpgradeIo, UpgradeResult, WorkerState } from "./run.ts";

/** A hidden session that starts the new server before restore rebuilds into it. */
export const UPGRADE_HOLD_SESSION = "_tmux-ide-upgrade";

/** Which server the command targets, as the user named it. */
export interface UpgradeTarget {
  socketPath?: string;
  socketName?: string;
}

/**
 * The socket to upgrade: `--socket-path`, `--socket-name`, then the
 * TMUX_IDE_TMUX_SOCKET_PATH / _NAME environment (as doctor reads them), the
 * server this shell runs in, else tmux's default socket.
 */
export function targetSocket(
  target: UpgradeTarget,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (target.socketPath && target.socketName)
    throw new IdeError("Pass --socket-path or --socket-name, not both.", {
      code: "USAGE",
      exitCode: 2,
    });
  const directory = join(environment.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
  if (target.socketPath) return target.socketPath;
  if (target.socketName) return join(directory, target.socketName);
  const envPath = environment.TMUX_IDE_TMUX_SOCKET_PATH?.trim();
  if (envPath) return envPath;
  const envName = environment.TMUX_IDE_TMUX_SOCKET_NAME?.trim();
  if (envName) return join(directory, envName);
  const inside = environment.TMUX?.split(",")[0];
  if (inside) return inside;
  return join(directory, "default");
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function tmux(client: string, socket: string, args: readonly string[]): string {
  return execFileSync(client, ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    env: withBundledTmuxResources(client, process.env),
  });
}

function stderrOf(error: unknown): string {
  const failure = error as { stderr?: unknown; message?: string };
  return String(failure.stderr ?? failure.message ?? "");
}

const NO_SERVER = /no server running|error connecting|failed to connect|connection refused/u;

/**
 * PURE: the executable from `lsof -a -p PID -d txt -Fn` output. The first `n`
 * line of the txt descriptors is the program itself; dylibs follow.
 */
export function executableFromLsof(output: string): string {
  const line = output.split("\n").find((entry) => entry.startsWith("n/"));
  return line ? line.slice(1) : "";
}

/**
 * PURE: a `/proc/<pid>/exe` link as a path to run. After a package upgrade
 * replaced the file, Linux appends " (deleted)"; the path then names the new
 * binary, which is what a fallback restore should run.
 */
export function procExePath(link: string): string {
  return link.replace(/ \(deleted\)$/u, "");
}

/**
 * The binary a process runs, or "" when it can't be read. `ps -o comm=` gives
 * only "tmux" for a server started by its PATH name, so macOS asks lsof.
 */
export function processExecutable(pid: number): string {
  try {
    if (process.platform === "linux") return procExePath(readlinkSync(`/proc/${pid}/exe`));
    const lsof = executableFromLsof(
      execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }),
    );
    if (lsof) return lsof;
  } catch {
    // Fall through to ps.
  }
  try {
    const comm = execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return comm.startsWith("/") ? comm : "";
  } catch {
    return "";
  }
}

/** PURE: tmux ends the server only when both its pid and start time still match. */
export function killGuardArgs(server: { pid: number; startTime: number }): string[] {
  const guard = `#{&&:#{==:#{pid},${server.pid}},#{==:#{start_time},${server.startTime}}}`;
  return ["if-shell", "-F", guard, "kill-server", "display-message -p identity-mismatch"];
}

/** PURE: what the guarded kill's output means. */
export function killOutcome(
  result: { stdout: string } | { stderr: string },
): "ended" | "mismatch" | { error: string } {
  if ("stdout" in result) return result.stdout.includes("identity-mismatch") ? "mismatch" : "ended";
  // kill-server ends the server under the client; that is success.
  if (NO_SERVER.test(result.stderr) || /server exited|lost server/u.test(result.stderr))
    return "ended";
  return { error: result.stderr.trim() || "tmux refused" };
}

/** The pids of this process and its ancestors, nearest first. */
function ancestry(): number[] {
  const pids: number[] = [];
  let pid = process.pid;
  for (let step = 0; step < 64 && pid > 1; step++) {
    pids.push(pid);
    try {
      pid = Number(
        execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        }).trim(),
      );
    } catch {
      break;
    }
    if (!Number.isInteger(pid)) break;
  }
  return pids;
}

/**
 * PURE: the pane (`session:window.pane`) whose process is this process or one
 * of its ancestors, from `#{pane_pid}\t<target>` lines; null when none is.
 */
export function ownPaneFrom(ancestors: readonly number[], lines: readonly string[]): string | null {
  const panes = new Map(
    lines.map((line) => {
      const [pid = "", target = ""] = line.split("\t");
      return [Number(pid), target] as const;
    }),
  );
  const mine = ancestors.find((pid) => panes.has(pid));
  return mine === undefined ? null : (panes.get(mine) ?? null);
}

/** Ask at a terminal. No terminal, a failed read or anything but y/yes is No. */
export async function confirmAt(
  question: string,
  terminal: { isTTY: boolean; ask(text: string): Promise<string>; print(text: string): void },
): Promise<boolean> {
  if (!terminal.isTTY) {
    terminal.print("No terminal to ask in. Pass --yes to go ahead. Nothing was stopped.");
    return false;
  }
  try {
    return answerIsYes(await terminal.ask(question));
  } catch {
    return false;
  }
}

/** PURE: the prompt's answer. Anything but y or yes, including nothing, is No. */
export function answerIsYes(answer: string | null): boolean {
  return answer !== null && /^y(es)?$/iu.test(answer.trim());
}

/** Write a new file, fsync it and its folder. Never overwrites. */
function writeDurably(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Some filesystems refuse a directory fsync; the file itself is synced.
  }
}

/** `~/.tmux-ide/upgrades/<timestamp>`, unique per run. */
export function newUpgradeDirectory(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return join(resolveRuntimeNamespace().stateHome, "upgrades", stamp);
}

const ServerIdentitySchemaZ = z
  .object({
    host: z.string(),
    socketPath: z.string().min(1),
    pid: z.number().int().positive(),
    startTime: z.number().int().nonnegative(),
    version: z.string(),
    executable: z.string(),
    features: z.enum(["full", "stock", "older", "partial", "unknown"]),
  })
  .strict();
const WorkerStateSchemaZ = z
  .object({
    server: ServerIdentitySchemaZ,
    client: z.string().min(1),
    snapshotPath: z.string().min(1),
    resumeAgents: z.boolean(),
  })
  .strict();

export function parseWorkerState(text: string): WorkerState {
  return WorkerStateSchemaZ.parse(JSON.parse(text));
}

const WorkerResultSchemaZ = z.object({
  status: z.enum([
    "already-full",
    "preview",
    "declined",
    "refused",
    "handed-off",
    "upgraded",
    "failed",
  ]),
  message: z.string(),
  restored: z.array(z.string()).optional(),
  failed: z.array(z.string()).optional(),
});

/** The worker's result, written once at the end; null while it is still running. */
export function readWorkerResult(path: string): UpgradeResult | null {
  try {
    return WorkerResultSchemaZ.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Write the worker's result atomically, so the foreground never reads half a file. */
export function writeWorkerResult(path: string, result: UpgradeResult): void {
  const { status, message, restored, failed } = result;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ status, message, restored, failed }) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface UpgradeIoOptions {
  target: UpgradeTarget;
  /** The CLI entry the detached worker runs (`node <entry> servers upgrade --continue`). */
  cliEntry: string;
  /** Under `--json` the plan and notes go to stderr, so stdout stays one JSON value. */
  json: boolean;
}

export function createUpgradeIo(options: UpgradeIoOptions): UpgradeIo {
  const socket = targetSocket(options.target);
  let directory: string | null = null;
  const runDirectory = () => (directory ??= newUpgradeDirectory());
  const print = (text: string) => (options.json ? console.error(text) : console.log(text));
  return {
    host: () => hostname(),
    bundled() {
      let executable: string | null;
      try {
        executable = resolveBundledTmux();
      } catch (error) {
        throw new IdeError(
          `tmux-ide's own tmux is damaged (${(error as Error).message}). Reinstall tmux-ide. Nothing was stopped.`,
          { code: "BUNDLED_TMUX_INVALID", exitCode: 1 },
        );
      }
      if (!executable) return null;
      const version = execFileSync(executable, ["-V"], {
        encoding: "utf8",
        timeout: 3000,
        env: withBundledTmuxResources(executable, process.env),
      })
        .trim()
        .replace(/^tmux\s+/u, "");
      return { executable, version };
    },
    configuredBinary: () => process.env.TMUX_IDE_TMUX_BIN || undefined,
    identify(client): ServerFacts | null {
      let line: string;
      try {
        line =
          tmux(client, socket, [
            "list-sessions",
            "-F",
            "#{socket_path}\t#{pid}\t#{start_time}\t#{version}",
          ]).split("\n")[0] ?? "";
      } catch (error) {
        if (NO_SERVER.test(stderrOf(error))) return null;
        throw new IdeError(`Could not read the server at ${socket}: ${stderrOf(error).trim()}`, {
          code: "SERVER_UNREADABLE",
          exitCode: 1,
        });
      }
      const [socketPath = "", pid = "", startTime = "", version = ""] = line.split("\t");
      if (!/^\d+$/u.test(pid) || !/^\d+$/u.test(startTime)) return null;
      return {
        socketPath: socketPath || socket,
        pid: Number(pid),
        startTime: Number(startTime),
        version,
        executable: processExecutable(Number(pid)),
      };
    },
    features(client, at) {
      const probe: TmuxProbe = (args) => tmux(client, at, args);
      const answer = nativeCommands(probe);
      return answer === "no-server" ? "unknown" : answer;
    },
    scratchFeatures(client): ServerFeatures {
      const scratch = mkdtempSync(join(tmpdir(), "tmi-upgrade-"));
      const at = join(scratch, "s");
      const run = (args: readonly string[]) =>
        execFileSync(client, ["-S", at, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
          env: withBundledTmuxResources(client, process.env),
        });
      try {
        run(["new-session", "-d", "-s", "probe"]);
        const answer = nativeCommands(run);
        return answer === "no-server" ? "unknown" : answer;
      } catch {
        return "unknown";
      } finally {
        try {
          run(["kill-server"]);
        } catch {
          // Already gone.
        }
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    endingPanes(client, at) {
      const table = readProcessTable();
      return tmux(client, at, ["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT])
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const [
            session = "",
            window = "",
            ,
            ,
            ,
            pane = "",
            cwd = "",
            cmd = "",
            pid = "0",
            ,
            ,
            hint = "",
          ] = line.split("\t");
          // tmux-ide's own hidden sessions (updater, app host) hold no user work.
          if (isListableSession(session) || session.startsWith("_tmux-ide")) return [];
          const { agent, command } = resolvePaneCommand(cmd, Number(pid) || 0, hint, table);
          return [{ target: `${session}:${window}.${pane}`, cwd, agent, command }];
        });
    },
    listPanes: (client, at) =>
      tmux(client, at, ["list-panes", "-a", "-F", COVERAGE_PANE_FORMAT])
        .split("\n")
        .filter(Boolean),
    collect: (client, at): FleetSnapshot =>
      // Strict: any tmux error throws, so a partial listing never becomes the snapshot.
      collectFleetSnapshot({
        listPanes: () => tmux(client, at, ["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]),
        listSessions: () => tmux(client, at, ["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]),
        processTable: () => readProcessTable(),
      }),
    saveSnapshot(snapshot) {
      const path = join(runDirectory(), "snapshot.json");
      writeDurably(path, JSON.stringify(snapshot, null, 2) + "\n");
      return path;
    },
    loadSnapshot: (path) => readSnapshot(path),
    ownPane(client, at) {
      let lines: string[];
      try {
        lines = tmux(client, at, [
          "list-panes",
          "-a",
          "-F",
          "#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}",
        ])
          .split("\n")
          .filter(Boolean);
      } catch {
        return null;
      }
      return ownPaneFrom(ancestry(), lines);
    },
    insideTarget(client, at) {
      const inside = process.env.TMUX?.split(",")[0];
      if (inside && sameFile(inside, at)) return true;
      // $TMUX can be unset or wrong; the process tree can't.
      return this.ownPane(client, at) !== null;
    },
    confirm: (question) =>
      confirmAt(question, {
        isTTY: Boolean(process.stdin.isTTY),
        print,
        ask: async (text) => {
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await prompt.question(text);
          } finally {
            prompt.close();
          }
        },
      }),
    startWorker(work) {
      const folder = runDirectory();
      const statePath = join(folder, "worker.json");
      writeDurably(statePath, JSON.stringify(work, null, 2) + "\n");
      const log = join(folder, "log");
      const resultPath = join(folder, "result.json");
      const fd = openSync(log, "a", 0o600);
      let pid: number;
      try {
        const child = spawn(
          process.execPath,
          [options.cliEntry, "servers", "upgrade", "--continue", statePath],
          // A session of its own and no terminal: a closing pane, a hangup or
          // Ctrl-C in the foreground does not reach it.
          { detached: true, stdio: ["ignore", fd, fd], env: process.env },
        );
        child.unref();
        if (!child.pid) throw new Error("the background worker did not start");
        pid = child.pid;
      } finally {
        closeSync(fd);
      }
      return { log, resultPath, pid };
    },
    async waitForWorker(handle) {
      const note = () => print(`\nThe restart continues in the background. Log: ${handle.log}`);
      const onSignal = () => {
        note();
        process.exit(130);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
          const result = readWorkerResult(handle.resultPath);
          if (result) return result;
          if (!processAlive(handle.pid) || Date.now() > deadline) {
            // One last look: it may have written the result just before it exited.
            return readWorkerResult(handle.resultPath);
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    },
    kill(client, server) {
      // tmux checks the identity itself, so a newer server on the socket is never ended.
      let outcome: ReturnType<typeof killOutcome>;
      try {
        outcome = killOutcome({ stdout: tmux(client, server.socketPath, killGuardArgs(server)) });
      } catch (error) {
        outcome = killOutcome({ stderr: stderrOf(error) });
      }
      if (outcome === "mismatch") throw new Error("another server now answers on that socket");
      if (typeof outcome === "object") throw new Error(outcome.error);
    },
    serverGone(client, at) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          tmux(client, at, ["list-sessions", "-F", "#{pid}"]);
        } catch (error) {
          if (NO_SERVER.test(stderrOf(error))) return true;
        }
        if (Date.now() > deadline) return false;
        execFileSync("/bin/sleep", ["0.1"]);
      }
    },
    async restore({ client, socket: at, snapshotPath, resumeAgents }) {
      const environment = withBundledTmuxResources(client, process.env);
      // Every runTmux in restore goes to this binary and this socket.
      const release = configureTmuxClientResolver(() => ({
        executable: client,
        environment,
        globalArgs: ["-S", at],
      }));
      try {
        // Start the server explicitly, so a binary that can't start one throws here
        // instead of failing each session one by one.
        tmux(client, at, ["new-session", "-d", "-s", UPGRADE_HOLD_SESSION]);
        const outcome = await restoreFleet({
          from: snapshotPath,
          snapshotOnly: true,
          resumeAgents,
          resumeFromConfig: false,
        });
        return { restored: outcome.restored, failed: outcome.failed };
      } finally {
        release();
        try {
          tmux(client, at, ["kill-session", "-t", `=${UPGRADE_HOLD_SESSION}`]);
        } catch {
          // Never started, or already gone.
        }
      }
    },
    print,
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}
