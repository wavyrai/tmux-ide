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
// teardown, so the process exit reports and removes the guard. Bun does not
// expose the running file here, so a call cannot be attributed to its test and
// a test cannot declare itself. A call to the default server is therefore
// redirected and listed (lane.log in the CI artifact) without
// failing the lane; a call to a shared socket path is refused and fails it.
const guard = installTmuxGuard();
assertTmuxGuarded();
registerCurrentTest("bun test lane");
beforeEach(() => assertTmuxGuarded());
process.on("exit", () => {
  const refused = refusedTmuxCalls(guard);
  const undeclared = undeclaredTmuxCalls(guard);
  saveTmuxGuardReport(guard, process.env.TMUX_IDE_TEST_TMUX_GUARD_REPORT, {
    undeclaredAs: "lane.log",
  });
  removeTmuxGuard(guard);
  if (undeclared.length > 0)
    console.error(
      `[tmux guard] ${undeclared.length} tmux call(s) of this Bun lane named no server and ran in the private namespace.`,
    );
  if (refused.length > 0) {
    console.error(tmuxGuardFailureMessage(refused, []));
    process.exitCode = 1;
  }
});
