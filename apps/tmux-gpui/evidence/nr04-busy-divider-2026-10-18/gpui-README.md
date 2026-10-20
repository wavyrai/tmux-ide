# NR04 busy GPUI bridge divider

Run from isolated gpui-main-release worktree:
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-busy/gpui-busy.mjs > .tasks/native-reliability-mission/nr04-busy/gpui-divider.stdout 2>&1
```

Session13136 exited0 on source5b92f4f4. Installed2.9.7 CLI, Node24.21.0 and stocktmux3.8 hashes/versions are in receipt. Immutable shared producer SHA b7a22be828914370e1b35dd079a0b16a06a69ec6abfd27d963de32176c118617 copied byte-for-byte into private fleet/busy.sh; direct tmux setup starts it only in left pane. It repaints row8 for200 ticks with50ms sleeps then DONE on row9. This is finite load, not performance measurement.

Advertised token-based resize-gesture begin/move/release changed left widths66→69 before release→75 settled→66 restored. Source tick samples progressed1→3 during move,4→6 during release,6→8 during restore; each stage remained below200 and without DONE. Exact window132x41, pane offsets and heights, original IDs/PIDs and both published grid markers checked at every stage. Right pane receives no producer or input mutation (its width changes with divider). Final tick200 and DONE verified in canonical source and published grid, followed by fresh bridge input verified in both. Captured output is coherent published content, not native physical rendering.

Cleanup observed all6 captured owned PIDs gone (server,2pane shells,daemon,bridge,producer shell), no cleanup errors, protected bin/cli.js unchanged. Stock pane_birth_id unsupported explicitly. No product changes, builds, GUI, production daemon or personal SSH. No failed runs in this slice. This does not establish physical drag behavior, frame rate or broad parity.
