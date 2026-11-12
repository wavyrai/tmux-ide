import { beforeEach } from "bun:test";
import {
  assertTmuxGuarded,
  installTmuxGuard,
  refusedTmuxCalls,
  removeTmuxGuard,
} from "./tmux-isolation.ts";

// `bun test --preload`: the same guard for the Bun lanes. Bun has no global
// teardown, so the process exit reports refused calls and removes the guard.
const guard = installTmuxGuard();
assertTmuxGuarded();
beforeEach(() => assertTmuxGuarded());
process.on("exit", () => {
  const refused = refusedTmuxCalls(guard);
  removeTmuxGuard(guard);
  if (refused.length > 0) {
    console.error(
      `${refused.length} tmux call(s) from this test run would have reached a live tmux server and were refused:\n${refused.slice(0, 40).join("\n")}`,
    );
    process.exitCode = 1;
  }
});
