import { execFile } from "node:child_process";
import { logger } from "./log.ts";

/**
 * A daemon that dies without running its stop (SIGKILL, a crash) leaves its
 * tmux control clients attached. Such a client cannot leave by itself: its
 * reader is gone, tmux waits for its control output to drain, and a later
 * `kill-server` then never finishes. The socket keeps a server with no
 * sessions, and no new server can take its place. The next owner of that
 * server therefore ends the control clients a dead daemon left behind.
 */
export interface OrphanedControlClientIo {
  /** `list-clients -F '#{client_pid}\t#{client_control_mode}'` on the owner's server. */
  readonly listClients: () => Promise<string>;
  /** Parent pid and full command of a process, or null when it is gone. */
  readonly describe: (pid: number) => Promise<{ ppid: number; command: string } | null>;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly isAlive: (pid: number) => boolean;
  readonly delay: (ms: number) => Promise<void>;
}

export const ORPHAN_KILL_GRACE_MS = 500;

/** The attach flags only this daemon's control client uses (mirrorControlAttachArgs). */
export function isTmuxIdeControlClientCommand(command: string): boolean {
  return (
    /(?:^|\s)-C(?:\s|$)/u.test(command) &&
    /ignore-size,pause-after=[0-9]+,active-pane/u.test(command)
  );
}

/** init, or a service manager that adopts orphans in its place. */
function adoptsOrphans(pid: number, command: string | null): boolean {
  if (pid === 1) return true;
  return command !== null && /(?:^|\/)(?:systemd|launchd|init)(?:\s|$)/u.test(command);
}

/**
 * Ends tmux-ide control clients on this server whose daemon is gone. Never
 * this daemon's own clients, another live daemon's, or any other program's.
 * Returns the pids it ended. Failures end the pass; they never throw.
 */
export async function evictOrphanedControlClients(
  io: OrphanedControlClientIo,
  ownPid: number,
): Promise<number[]> {
  let listing: string;
  try {
    listing = await io.listClients();
  } catch {
    return [];
  }
  const evicted: number[] = [];
  for (const row of listing.split("\n")) {
    const [pidText, controlMode] = row.split("\t");
    const pid = Number(pidText);
    if (controlMode !== "1" || !Number.isSafeInteger(pid) || pid <= 1 || pid === ownPid) continue;
    try {
      const client = await io.describe(pid);
      if (!client || client.ppid === ownPid || !isTmuxIdeControlClientCommand(client.command))
        continue;
      const parent = client.ppid === 1 ? null : await io.describe(client.ppid);
      if (!adoptsOrphans(client.ppid, parent?.command ?? null)) continue;
      io.kill(pid, "SIGTERM");
      await io.delay(ORPHAN_KILL_GRACE_MS);
      if (io.isAlive(pid)) io.kill(pid, "SIGKILL");
      evicted.push(pid);
    } catch {
      // One client that cannot be judged or signalled does not stop the pass.
    }
  }
  return evicted;
}

/** The real process lookups; tmux access is the owner's own runner. */
export function orphanedControlClientIo(
  listClients: () => Promise<string>,
): OrphanedControlClientIo {
  return {
    listClients,
    describe: (pid) =>
      new Promise((resolve) => {
        execFile(
          "/bin/ps",
          ["-ww", "-o", "ppid=,command=", "-p", String(pid)],
          { encoding: "utf8", timeout: 2_000, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } },
          (error, stdout) => {
            const match = /^\s*([0-9]+)\s+(.+)$/mu.exec(error ? "" : stdout);
            resolve(match ? { ppid: Number(match[1]), command: match[2]!.trim() } : null);
          },
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

/**
 * Run once when a daemon takes ownership of a tmux server. Not awaited: it
 * never delays or fails the owner. One warning names what it ended.
 */
export function evictOrphanedControlClientsOnOwnership(
  runTmux: (args: readonly string[]) => Promise<string>,
  serverId: string | null,
  io: (listClients: () => Promise<string>) => OrphanedControlClientIo = orphanedControlClientIo,
): Promise<void> {
  return evictOrphanedControlClients(
    io(() => runTmux(["list-clients", "-F", "#{client_pid}\t#{client_control_mode}"])),
    process.pid,
  )
    .then((pids) => {
      if (pids.length > 0)
        logger.warn("tmux-server-owners", "ended control clients a dead daemon left attached", {
          ...(serverId ? { serverId } : {}),
          pids,
        });
    })
    .catch(() => undefined);
}
