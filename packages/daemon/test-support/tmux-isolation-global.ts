import {
  installTmuxGuard,
  redirectedTmuxCalls,
  refusedTmuxCalls,
  removeTmuxGuard,
  saveTmuxGuardReport,
} from "./tmux-isolation.ts";

/**
 * Vitest globalSetup: one tmux guard for the whole run, inherited by every
 * worker. A run in which the guard had to refuse a call fails at the end with
 * the refused calls listed, even if every test passed.
 */
export default function setup(): () => void {
  const guard = installTmuxGuard();
  return () => {
    const refused = refusedTmuxCalls(guard);
    // CI sets this and uploads the directory: the run's complete list.
    saveTmuxGuardReport(guard, process.env.TMUX_IDE_TEST_TMUX_GUARD_REPORT);
    const redirected = redirectedTmuxCalls(guard).length;
    if (redirected > 0)
      console.log(
        `[tmux guard] ${redirected} tmux call(s) named no private socket and ran in a private namespace instead of the default server.`,
      );
    removeTmuxGuard(guard);
    if (refused.length > 0)
      throw new Error(
        `${refused.length} tmux call(s) from this test run would have reached a live tmux server and were refused:\n` +
          refused.slice(0, 40).join("\n") +
          "\nA test addressed a tmux socket by a path outside a private temp dir. Use a socket under mkdtemp().",
      );
  };
}
