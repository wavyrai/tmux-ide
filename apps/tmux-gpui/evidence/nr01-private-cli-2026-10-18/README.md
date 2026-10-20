# Private CLI lifecycle qualification

The shared daemon fixture accepts an explicit, absolute, readable regular-file CLI path. Only the three GPUI smoke callers opt into TMUX_GPUI_TEST_CLI; the shared fixture never silently reads that environment variable. Default callers retain the tracked-bundle rebuild behavior. Replacement startup reuses the same private CLI.

Independent source review passed. Changed-file ESLint and Prettier passed after making pre-existing Node global usage explicit with builtin imports in browser-smoke.mjs. Two focused tests check invalid paths, explicit builder bypass and preserved default routing with process execution fenced. The real local lifecycle gate passed on macOS ARM64, Node 24.21.0 and stock tmux 3.8: private CLI build, browser resize/presence, discovery recovery, pane split, pane replacement and browser history. The tracked bin/cli.js SHA256 is identical before and after; see integrity.json. This is headless lifecycle evidence, not native GUI or full runner qualification.

The first test mock inherited execFile's custom promisifier and unexpectedly rebuilt the initially clean tracked CLI. That generated diff was retained under .tasks/nr05-quiet-status/unintended-fixture-cli-build.patch and the file restored from HEAD. The corrected mock uses a fresh callback function to fence the real build boundary. No production server or session was touched. Failed-attempt notes and passing tests remain under .tasks/nr01-private-cli/.

NR01 remains open: reviewed persistent runner packaging, source integrity receipts, Linux source-lane memory qualification and remaining platform gates are not established by this slice. Nothing newly merged or published.
