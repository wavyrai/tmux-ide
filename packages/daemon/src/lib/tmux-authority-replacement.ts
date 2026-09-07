import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "./unix-socket-authority.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { createNamedSocketFence } from "./tmux-named-socket-fence.ts";

const execFileAsync = promisify(execFile);
// tmux replaces a tab in display-message output under a minimal C locale.
const SERVER_FORMAT = "#{socket_path}|#{pid}";

function serverBaseline(raw: string) {
  const separator = raw.lastIndexOf("|");
  const path = raw.slice(0, separator);
  const pid = Number(raw.slice(separator + 1).trim());
  if (separator < 1 || !Number.isSafeInteger(pid) || pid < 1) return null;
  const identity = captureUnixSocketIdentity(path);
  return {
    identity,
    initial: lstatSync(identity.path),
    parent: lstatSync(dirname(identity.path)),
    pid,
  };
}

/** A replacement is evidence for retiring a generation, never permission for
 * an existing mutation runner to cross its socket identity fence. */
export function createTmuxAuthorityReplacementProbe(
  authority: WorkspacePaneTmuxAuthority,
  runPinned: (args: readonly string[]) => string,
): () => Promise<boolean> {
  const namedFence =
    authority.socketSelector.kind === "name"
      ? createNamedSocketFence(authority, authority.executablePath, { TERM: "xterm-256color" })
      : null;
  const selector =
    authority.socketSelector.kind === "path"
      ? ["-S", authority.socketSelector.path]
      : ["-L", authority.socketSelector.name];
  const readServer = async (args: string[]) =>
    (
      await execFileAsync(
        authority.executablePath,
        [...args, "-N", "display-message", "-p", SERVER_FORMAT],
        { encoding: "utf8", timeout: 1_000, maxBuffer: 8_192, env: { TERM: "xterm-256color" } },
      )
    ).stdout.trimEnd();
  let baseline: ReturnType<typeof serverBaseline> = null;
  try {
    const raw = runPinned(["-N", "display-message", "-p", SERVER_FORMAT]);
    const candidate = serverBaseline(raw);
    if (candidate && runPinned(["-N", "display-message", "-p", SERVER_FORMAT]) === raw) {
      revalidateUnixSocketIdentity(candidate.identity);
      namedFence?.observe(candidate.identity);
      baseline = candidate;
    }
  } catch {
    // The named server may not exist yet. Establish the first baseline only
    // when that exact selector has a live server; -N never creates one.
  }
  return async () => {
    if (!baseline) {
      try {
        const raw = await readServer(selector);
        const candidate = serverBaseline(raw);
        if (candidate && (await readServer(["-S", candidate.identity.path])) === raw) {
          revalidateUnixSocketIdentity(candidate.identity);
          namedFence?.observe(candidate.identity);
          baseline = candidate;
        }
      } catch {
        /* Absence is not replacement evidence. */
      }
      return false;
    }
    const { identity, initial, parent, pid: originalPid } = baseline;
    let originalAlive = true;
    try {
      revalidateUnixSocketIdentity(identity);
      return false;
    } catch {
      try {
        process.kill(originalPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        originalAlive = false;
      }
    }
    try {
      const next = captureUnixSocketIdentity(identity.path);
      const nextStat = lstatSync(next.path);
      const nextParent = lstatSync(dirname(next.path));
      if (
        nextStat.uid !== initial.uid ||
        nextParent.dev !== parent.dev ||
        nextParent.ino !== parent.ino
      )
        return false;
      const { stdout } = await execFileAsync(
        authority.executablePath,
        ["-S", next.path, "display-message", "-p", "#{pid}"],
        { encoding: "utf8", timeout: 1_000, maxBuffer: 1024, env: { TERM: "xterm-256color" } },
      );
      revalidateUnixSocketIdentity(next);
      const nextPid = Number(stdout.trim());
      if (!Number.isSafeInteger(nextPid) || nextPid < 1) return false;
      // SIGUSR1 recreates the listening socket while tmux and all its panes
      // survive. Accept that same server, but never substitute a different
      // server while the original is still alive.
      return originalAlive ? nextPid === originalPid : nextPid !== originalPid;
    } catch {
      return false;
    }
  };
}
