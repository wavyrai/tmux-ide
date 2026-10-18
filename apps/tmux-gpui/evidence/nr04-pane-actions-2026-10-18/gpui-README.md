# NR04 GPUI bridge actions

Final session90762 exited0 on e5b85427. Run from isolated worktree:
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-actions/gpui-actions.mjs > .tasks/native-reliability-mission/nr04-actions/gpui-actions.stdout 2>&1
```

Installed2.9.7 CLI hash and stocktmux3.8/Node24 versions recorded in receipt. One initial private pane; all tested split/zoom/restore/close actions use actual pane-action messages and offered tokens, no direct tmux mutation. Explicit pane selections are followed by bridge resize132x41, reproducing native viewport admission before measuring calibrated geometry.

Results: initial original132x40 at top1; split right original66x40 + new65x40 at left67; original zoom132x40 with zoom flag1; restore exact split geometry; close new returns exact original132x40 geometry. Original physical ID/PID retained, new PID observed exited before success. Both markers verified in composed published grid; marker commands sent by bridge and exact output lines checked in selected source pane. Fresh original input after close verified likewise. Close is bridge action execution, not native confirmation-dialog acceptance. No physical GUI/rendering or performance claim; pane_birth_id unavailable on stock3.8 explicitly.

All5 owned PIDs gone after cleanup, no cleanup errors, protected bin/cli.js unchanged. Private fixtures only, no product changes/builds.

Preserved failures: gpui-first.* incorrectly expected split to auto-select new pane (supported behavior preserves original); gpui-selection-grid.* measured newly selected viewer before native-equivalent resize (80x24); gpui-grid-marker.* incorrectly expected right-pane output alone on an entire composed-grid line. Final assertion requires exact source-pane output plus published-grid inclusion, not a synthetic marker or direct input bypass. These are harness corrections, not evidence of product fixes.

Reviewer strengthening: exact zoomed original identity and geometry (row fields0–8) must equal initial; only zoom flag differs. Rerun90762 passed this assertion. Earlier passing20675 receipt preserved as gpui-before-zoom-assert.*.
