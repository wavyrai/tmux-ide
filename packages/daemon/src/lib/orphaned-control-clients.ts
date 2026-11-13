import { execFile } from "node:child_process";
import { logger } from "./log.ts";

/**
 * A daemon that dies without running its stop (SIGKILL, a crash) can leave a
 * tmux control client behind. Measured on a private server: with pane output
 * flowing and the daemon stopped for a few seconds before the kill, the
 * client stays alive with init as its parent. tmux no longer lists it as a
 * client, yet a later `kill-server` never finishes while it lives: the socket
 * keeps a server with no sessions and no new server can take its place.
 * A daemon therefore ends the control clients a dead daemon left on a server
 * it owns: when it takes ownership, and when that server answers a catalog
 * read with no sessions or does not answer it at all.
 */
export type TmuxServerSelector =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "name"; readonly name: string };

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

export interface OrphanedControlClientIo {
  /** Every process of this user: tmux does not list a client that is leaving. */
  readonly listProcesses: () => Promise<readonly ProcessRow[]>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly isAlive: (pid: number) => boolean;
  readonly delay: (ms: number) => Promise<void>;
}

export const ORPHAN_KILL_GRACE_MS = 500;

/** PURE. `ps -o pid=,ppid=,command=` output, one process per line. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/u.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! });
  }
  return rows;
}

/** The attach flags only this daemon's control client uses (mirrorControlAttachArgs). */
export function isTmuxIdeControlClientCommand(command: string): boolean {
  return (
    /(?:^|\s)-C(?:\s|$)/u.test(command) &&
    /ignore-size,pause-after=[0-9]+,active-pane/u.test(command)
  );
}

const withoutPrivate = (path: string): string => path.replace(/^\/private(?=\/)/u, "");

/** PURE. Does this tmux command line address the given server? */
export function commandTargetsServer(command: string, selector: TmuxServerSelector): boolean {
  const words = command.split(/\s+/u);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "-C") return false;
    const flag = selector.kind === "path" ? "-S" : "-L";
    const value = word === flag ? words[index + 1] : word.startsWith(flag) ? word.slice(2) : null;
    if (value === null || value === undefined || value === "") continue;
    return selector.kind === "path"
      ? withoutPrivate(value) === withoutPrivate(selector.path)
      : value === selector.name;
  }
  return false;
}

/** init, or a service manager that adopts orphans in its place. */
function adoptsOrphans(pid: number, command: string | null): boolean {
  if (pid === 1) return true;
  return command !== null && /(?:^|\/)(?:systemd|launchd|init)(?:\s|$)/u.test(command);
}

/**
 * Ends tmux-ide control clients of this server whose daemon is gone. Never
 * this daemon's own clients, another live daemon's, another server's, or any
 * other program's. Returns the pids it ended. Failures end the pass; they
 * never throw.
 */
export async function evictOrphanedControlClients(
  io: OrphanedControlClientIo,
  ownPid: number,
  selector: TmuxServerSelector,
): Promise<number[]> {
  let processes: readonly ProcessRow[];
  try {
    processes = await io.listProcesses();
  } catch {
    return [];
  }
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  const evicted: number[] = [];
  for (const client of processes) {
    if (
      client.pid <= 1 ||
      client.pid === ownPid ||
      client.ppid === ownPid ||
      !isTmuxIdeControlClientCommand(client.command) ||
      !commandTargetsServer(client.command, selector) ||
      !adoptsOrphans(client.ppid, byPid.get(client.ppid)?.command ?? null)
    )
      continue;
    try {
      io.kill(client.pid, "SIGTERM");
      await io.delay(ORPHAN_KILL_GRACE_MS);
      if (io.isAlive(client.pid)) io.kill(client.pid, "SIGKILL");
      evicted.push(client.pid);
    } catch {
      // One client that cannot be signalled does not stop the pass.
    }
  }
  return evicted;
}

/** The real process table and signals. */
export function orphanedControlClientIo(): OrphanedControlClientIo {
  return {
    listProcesses: () =>
      new Promise((resolve, reject) => {
        execFile(
          "/bin/ps",
          ["-xww", "-o", "pid=,ppid=,command="],
          {
            encoding: "utf8",
            timeout: 3_000,
            maxBuffer: 16 * 1024 * 1024,
            env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
          },
          (error, stdout) => (error ? reject(error) : resolve(parseProcessTable(stdout))),
        );
      }),
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** What a catalog read found: an answer without sessions, or no answer. */
export type TmuxServerTrouble = "no-sessions" | "unanswered";

export const EMPTY_SERVER_PASS_INTERVAL_MS = 10_000;
export const EMPTY_SERVER_LOG_INTERVAL_MS = 60_000;

/**
 * One per owned server. Neither call is awaited by the owner, delays it or
 * fails it.
 * - `onOwnership`: one pass when the daemon takes the server.
 * - `onTrouble`: a catalog read found the server with no sessions, or got no
 *   answer from a server whose socket is still there. A tmux server normally
 *   exits with its last session, so either it is configured to stay or it
 *   cannot exit. At most one pass per 10 s, and one warning per minute that
 *   names the state: scoped reads fail in it, and nothing else says why.
 */
export function createOrphanedControlClientWatch(options: {
  readonly selector: TmuxServerSelector;
  readonly serverId: string | null;
  readonly io?: OrphanedControlClientIo;
  readonly now?: () => number;
}): { onOwnership(): Promise<void>; onTrouble(kind: TmuxServerTrouble): Promise<void> } {
  const io = options.io ?? orphanedControlClientIo();
  const now = options.now ?? Date.now;
  const fields = options.serverId ? { serverId: options.serverId } : {};
  let lastPassAt = Number.NEGATIVE_INFINITY;
  let lastLogAt = Number.NEGATIVE_INFINITY;
  let running: Promise<number[]> | null = null;
  const pass = (): Promise<number[]> => {
    if (running) return running;
    lastPassAt = now();
    const current = evictOrphanedControlClients(io, process.pid, options.selector)
      .catch((): number[] => [])
      .then((pids) => {
        if (pids.length > 0)
          logger.warn("tmux-server-owners", "ended control clients a dead daemon left attached", {
            ...fields,
            pids,
          });
        return pids;
      })
      .finally(() => {
        if (running === current) running = null;
      });
    running = current;
    return current;
  };
  return {
    onOwnership: () => pass().then(() => undefined),
    async onTrouble(kind) {
      if (now() - lastPassAt < EMPTY_SERVER_PASS_INTERVAL_MS) return;
      const pids = await pass();
      if (now() - lastLogAt < EMPTY_SERVER_LOG_INTERVAL_MS) return;
      lastLogAt = now();
      logger.warn(
        "tmux-server-owners",
        kind === "no-sessions"
          ? "tmux server answers with no sessions"
          : "tmux server does not answer its catalog",
        { ...fields, endedControlClients: pids.length },
      );
    },
  };
}
