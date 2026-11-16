import { compareProductVersions } from "./semver.ts";

/**
 * What `tmux-ide update --daemon` tells the user once a daemon is running.
 *
 * A CLI never replaces a NEWER daemon (canonical-daemon-bootstrap's
 * needsReplacement): clients of the newer version may depend on it. That is
 * by design. But after a rollback (a newer daemon, an older CLI) the command
 * used to report "Daemon ready" for the newer daemon and nothing else, so it
 * looked as if it had done nothing. It now says the daemon was left running
 * and how to run this version's daemon instead.
 */
export function daemonUpdateOutcome(
  running: { readonly productVersion: string; readonly pid: number; readonly supervised: boolean },
  cliVersion: string,
): { status: "ready" | "kept-newer"; message: string } {
  if (compareProductVersions(running.productVersion, cliVersion) !== 1)
    return { status: "ready", message: `Daemon ready: ${running.productVersion}` };
  const how = running.supervised
    ? "restart its service: tmux-ide daemon service restart"
    : `stop it (pid ${running.pid}), then run tmux-ide update --daemon again`;
  return {
    status: "kept-newer",
    message:
      `The running daemon is v${running.productVersion}, newer than this CLI (v${cliVersion}). ` +
      `It was left running: a CLI never replaces a newer daemon. ` +
      `To run v${cliVersion}'s daemon instead, ${how}.`,
  };
}
