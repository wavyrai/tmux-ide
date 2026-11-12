import { beforeEach } from "bun:test";
import {
  assertTmuxGuarded,
  installTmuxGuard,
  refusedTmuxCalls,
  registerCurrentTest,
  removeTmuxGuard,
  saveTmuxGuardReport,
  tmuxGuardFailureMessage,
  undeclaredTmuxCalls,
} from "./tmux-isolation.ts";

// `bun test --preload`: the same guard for the Bun lanes. Bun has no global
// teardown, so the process exit reports the calls that named no private
// server and removes the guard. Bun does not expose the running file here,
// so calls are attributed to the lane.
const guard = installTmuxGuard();
assertTmuxGuarded();
registerCurrentTest("bun test lane");
beforeEach(() => assertTmuxGuarded());
process.on("exit", () => {
  const refused = refusedTmuxCalls(guard);
  const undeclared = undeclaredTmuxCalls(guard);
  saveTmuxGuardReport(guard, process.env.TMUX_IDE_TEST_TMUX_GUARD_REPORT);
  removeTmuxGuard(guard);
  if (refused.length + undeclared.length > 0) {
    console.error(tmuxGuardFailureMessage(refused, undeclared));
    process.exitCode = 1;
  }
});
