# NR04 actual OpenTUI divider: quiet bounded case

Run from the worktree root:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-divider/tui-divider.mjs > .tasks/native-reliability-mission/nr04-divider/tui-divider.stdout 2> .tasks/native-reliability-mission/nr04-divider/tui-divider.stderr
```

Uses actual source OpenTUI in the existing private testdrive host, genuine installed2.9.7 daemon, stock tmux3.8 and deterministic interactive-shell left/right markers. This is terminal mouse protocol injection through the actual TUI, not native macOS GUI qualification or an installed-TUI claim. TUI launcher internally references the repository CLI, but the tested canonical daemon was already started explicitly from the genuine installed2.9.7 artifact.

Host160×44 renders source132×41 (top pane headers reserve source row0). From captured left-marker origin x28 and source left width66, divider is host x94. Existing testdrive coordinates are zero-based; its SGR encoder adds1. Three actual `mouse drag` calls at y12: x94→97,97→103,103→94. Exact source widths are66/65→69/62→75/56→66/65; right origin follows divider+1, heights40 and window132×41 remain unchanged. Original pane IDs/PIDs survive each step and adoption, both source markers persist after every step, restored geometry matches exactly, fresh input via TUI produces an exact source output line.

Six captured owned PIDs (source server/shells, daemon, host server/renderer) are observed exited after scoped cleanup. No cleanup errors; protected repository CLI hash unchanged. Stock3.8 has no pane_birth_id so this is explicitly unavailable. First pass retained separately; latest stricter run additionally asserts right width/origin and both source markers each step. No failed drag attempts.

No bounded-output producer, GPUI lane, smoothness/performance comparison, or native physical GUI claim. Remaining broader cases stay open.

Worktree HEAD: `f75b10eadddd5c57755ac22f5ab7341e0294ce4e`.

- `.tasks/native-reliability-mission/nr04-divider/tui-divider.mjs`: SHA256 `670bd3540978e1800d5dacf0391393194a9acd81ebd4518db9a93be8ebd6b6c1`
- `.tasks/tmux38-compat/tmux-3.8/tmux`: SHA256 `8b97ea85e10c6e9a6966451259f15d1041981fb313715e510c14c430d294af96`
- `.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node`: SHA256 `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`
- `.tasks/nr07/package-297-f7rol0nn/installed/lib/node_modules/tmux-ide/bin/cli.js`: SHA256 `7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c`
- `scripts/tui-testdrive.mjs`: SHA256 `d19f33533eef72dd6242a02d9ad0f7b7491ec498e881a0a748268b2fbbb6c2a4`
- `packages/daemon/src/tui/mirror/app.tsx`: SHA256 `1be7c4bf70cff8991f7129c7f05cc9516abcbf4538e886ef6ca782bca01ee603`

Matched-width rerun uses +3,+9,restore to match root plain/GPUI source widths. Earlier +6,+12 receipt retained as `tui-divider-plus6-plus12-pass.json`. Each TUI testdrive `mouse drag` is a complete down/interpolated-move/up gesture. This differs from GPUI continuous move/release grouping; results establish matching committed geometry, not identical gesture event streams.
