# NR04 matched plain reference

Run from worktree root:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node .tasks/native-reliability-mission/nr04/plain-resize.mjs
```

Latest `plain-resize.json` passes against stock tmux 3.8. Explicit private socket accompanies every tmux operation. The fixture sets `pane-border-status top` to reproduce TUI-adopted geometry: pane top 1, heights40/44 (window41/45). Without that option the plain baseline has pane top0 and heights41/45; its receipt is retained as `plain-no-header-pass.json` and is not the matched baseline.

Initial/expanded/restored left/top/width/height/window dimensions and zoom state match the actual TUI receipt exactly, excluding intentionally different pane PID values between isolated fixtures. Both use the same deterministic left/right output markers and interactive shell producer. Original pane IDs/PIDs survive, content persists, and a fresh explicit input command produces a standalone marker line. Pane birth IDs are unavailable on stock3.8. Three owned PIDs (server and two shells) have exited after cleanup, exact socket no longer accepts sessions, temporary root removed, protected repository CLI bytes unchanged.

The first failure is retained: `set-option -t =nr04` was not admitted by tmux; the corrected harness uses fixture-unique session `nr04` inside its exact isolated socket. No production access occurred in the plain lane.

This compares resize correctness of plain tmux with an actual source TUI. GPUI lane, native physical GUI, divider drag and other actions remain unqualified. No performance claims.

Harness SHA256: `07e9082a00591d3e6d339f3fcdd01ee537680a440e9228d9569e276f8a680111`

Historical lane-local scope above predates the aggregate comparison. The sibling README.md now records the completed bounded three-lane resize calibration. Native physical GUI, divider drag and broader parity remain unqualified.
