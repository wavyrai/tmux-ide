import { beforeEach } from "vitest";
import { assertTmuxGuarded, installTmuxGuard } from "./tmux-isolation.ts";

// Vitest setupFiles: runs in every worker before each test file. The global
// setup normally installed the guard already; a worker that did not inherit
// it gets its own. Every test is then checked, so a test that drops the guard
// from PATH or points TMUX_IDE_TMUX_BIN past it fails itself before it runs.
installTmuxGuard();
assertTmuxGuarded();
beforeEach(() => assertTmuxGuarded());
