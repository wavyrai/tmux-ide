# NR04 quiet GPUI bridge divider

Source HEAD f75b10ea, installed2.9.7 CLI SHA7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c, Node24.21.0, stock tmux3.8. Only private scratch resources; no builds, product edits or GUI.

Run from isolated worktree:
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-divider/gpui-divider.mjs > .tasks/native-reliability-mission/nr04-divider/gpui-divider.stdout 2>&1
```

Final advertised token-based resize-gesture session91583 exited0. Prior lower-level resize-pane session34677 also passed and is retained separately. Exact source left width66→69→75→66; corresponding right left67→70→76→67 and width65→62→56→65. Both panes retain top1/height40 in window132x41. Original pane IDs/shell PIDs unchanged, initial geometry restored exactly. Coherent published grid includes both markers at each stage; fresh bridge input appears in published grid and selected source pane. All five owned PIDs exited, cleanup errors empty, protected bin/cli.js unchanged.

Final run uses the native advertised token-based resize-gesture path: begin with fresh token/semantic left pane, move69 and verify dragging plus source width69 before release, move72/release75 and verify settled, then new gesture restoring66. Lower-level resize-pane evidence remains separate. Quiet only; no physical rendering or performance claim. The daemon is installed CLI, while browser is source bridge.

Canonical begin/move/release attempt failed before sending begin because no split target was advertised. Session94983 and diagnostic87469 exited1 with successful cleanup; receipts preserved as gpui-divider-first.* and gpui-divider-canonical-diagnostic.*, original harness as gpui-canonical-attempt.mjs. Diagnostic splitLayout is null despite inputReady and coherent132x41. WindowSplitAuthority capture requires nonzero nativePaneBirthId (packages/daemon/src/terminal/mirror/window-split-authority.ts:72), unavailable on stock3.8. Correction: resizeGestureSupported:true is the advertised token-based pane gesture; canonical split handles are a separate path. Fallback uses existing offered resize token; no direct tmux resize or fabricated capability. The lower-level release command pass is retained separately as gpui-release-command.*; advertised token-based gesture validation passed. Canonical split-handle absence must not be interpreted as absence of continuous token-based pane resize support.
