# NR04 GPUI bridge resize calibration

Run from the isolated gpui-main-release worktree:

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04/gpui-resize.mjs > .tasks/native-reliability-mission/nr04/gpui-resize.stdout 2>&1
```

Final session 21632 exited 0. `gpui-resize.json` records passing checks with Node24.21.0, stock tmux3.8, and the genuine private installed2.9.7 CLI hash. This runs the current source browser bridge, not a packaged native application.

All three resize commands travel through the actual bridge input resize path. Observed window and published snapshot grids are132x41 →152x45 →132x41. Exact source pane offsets/content dimensions match the passing TUI calibration whose receipt hash is recorded: initial left(0,1,66,40), right(67,1,65,40); expanded left(0,1,76,44), right(77,1,75,44); restored exact initial. No border-option adjustment or direct tmux resize was used. Direct tmux split is setup only.

Each coherent published grid includes both fixture markers; fresh bridge input appears in both the published grid and the owned source pane. Pane physical IDs and shell PIDs remain unchanged. Stock3.8 supplies no pane_birth_id, explicitly recorded unsupported. This is no native physical-rendering, frame-timing, performance or general-parity claim.

Cleanup verifies all five captured owned process IDs (server, two pane shells, daemon, bridge helper) have exited; no cleanup errors or remaining IDs. Protected tracked bin/cli.js hash is unchanged. No production resources, GUI or builds were used. The first successful run is retained as gpui-resize-first.* but had weaker cleanup verification and should not be the acceptance receipt. Final grid text files and bounded stderr/stdout accompany the receipt.
