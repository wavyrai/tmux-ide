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
  readlinkSync,
  realpathSync,
  rmSync,
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
  SNAPSHOT_PANE_FORMAT,
  SNAPSHOT_SESSION_FORMAT,
  type FleetSnapshot,
} from "../tui/chrome/snapshot.ts";
import { readProcessTable } from "../tui/detect/process-tree.ts";
import { resolveBundledTmux, withBundledTmuxResources } from "../lib/bundled-tmux.ts";
import { IdeError } from "../lib/errors.ts";
import { resolveRuntimeNamespace } from "../lib/runtime-namespace.ts";
import {
  nativeCommands,
  type ServerFeatures,
  type TmuxProbe,
} from "../lib/tmux-server-features.ts";
import { COVERAGE_PANE_FORMAT } from "./plan.ts";
import type { ServerFacts, UpgradeIo, WorkerState } from "./run.ts";

/** A hidden session that starts the new server before restore rebuilds into it. */
export const UPGRADE_HOLD_SESSION = "_tmux-ide-upgrade";

/** Which server the command targets, as the user named it. */
export interface UpgradeTarget {
  socketPath?: string;
  socketName?: string;
}

/**
 * The socket to upgrade: `--socket-path`, `--socket-name`, the server this
 * shell runs in, else tmux's default socket.
 */
export function targetSocket(
  target: UpgradeTarget,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (target.socketPath) return target.socketPath;
  const directory = join(environment.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`);
  if (target.socketName) return join(directory, target.socketName);
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

/** The binary a process runs, or "" when it can't be read. */
function processExecutable(pid: number): string {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`);
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
    insideTarget(at) {
      const inside = process.env.TMUX?.split(",")[0];
      return Boolean(inside) && sameFile(inside!, at);
    },
    async confirm(question) {
      if (!process.stdin.isTTY) {
        print("No terminal to ask in. Pass --yes to go ahead. Nothing was stopped.");
        return false;
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/iu.test((await prompt.question(question)).trim());
      } finally {
        prompt.close();
      }
    },
    startWorker(work) {
      const folder = runDirectory();
      const statePath = join(folder, "worker.json");
      writeDurably(statePath, JSON.stringify(work, null, 2) + "\n");
      const log = join(folder, "log");
      const fd = openSync(log, "a", 0o600);
      try {
        const child = spawn(
          process.execPath,
          [options.cliEntry, "servers", "upgrade", "--continue", statePath],
          // A new session of its own: the pane closing must not take it down.
          { detached: true, stdio: ["ignore", fd, fd], env: process.env },
        );
        child.unref();
      } finally {
        closeSync(fd);
      }
      return log;
    },
    kill(client, server) {
      // tmux checks the identity itself, so a newer server on the socket is never ended.
      const guard = `#{&&:#{==:#{pid},${server.pid}},#{==:#{start_time},${server.startTime}}}`;
      let out: string;
      try {
        out = tmux(client, server.socketPath, [
          "if-shell",
          "-F",
          guard,
          "kill-server",
          "display-message -p identity-mismatch",
        ]);
      } catch (error) {
        // kill-server ends the server under the client; that is success.
        const text = stderrOf(error);
        if (NO_SERVER.test(text) || /server exited|lost server/u.test(text)) return;
        throw new Error(text.trim() || "tmux refused", { cause: error });
      }
      if (out.includes("identity-mismatch"))
        throw new Error("another server now answers on that socket");
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
