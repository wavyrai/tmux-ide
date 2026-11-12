import {
  installTmuxGuard,
  redirectedTmuxCalls,
  refusedTmuxCalls,
  removeTmuxGuard,
  tmuxGuardFailureMessage,
  undeclaredTmuxCalls,
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
    const undeclared = undeclaredTmuxCalls(guard);
    const declared = redirectedTmuxCalls(guard).length;
    // CI sets this and uploads the directory: the run's complete list.
    saveTmuxGuardReport(guard, process.env.TMUX_IDE_TEST_TMUX_GUARD_REPORT);
    removeTmuxGuard(guard);
    if (declared > 0)
      console.log(
        `[tmux guard] ${declared} tmux call(s) of tests that declared a daemon without a server ran in the private namespace.`,
      );
    if (refused.length + undeclared.length > 0) {
      // Vitest reports an error thrown here ("error during close") but still
      // exits 0, so the exit code is set as well: the run must fail.
      process.exitCode = 1;
      throw new Error(tmuxGuardFailureMessage(refused, undeclared));
    }
  };
}
