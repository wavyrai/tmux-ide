# NR04 alternate-screen enter/exit

All3private lanes passed: plain stocktmux3.8, actual compiledTUI e0f813bd with fresh ignore-scripts+ownpostinstall installed2.9.7daemon, and current sourceGPUIbridge with same daemon. TUI71882/GPUI53722 exited0; plain final returned0. No productchanges/builds/nativeGUI/performanceclaim.

Raw Node receiver writes only fixed escape sequences and markers; exact received input `rabc` is checked. `r` initializes main screen AFTER matched132x41window/132x40content geometry through each lane's actualinput path; `a` entersDEC1049 alternate, `b` exits, `c` writesfreshmarker. Plain literalkeys, compiledTUI testdrive text throughhostPTY, GPUIadvertised input text withselectedrequest. No shell evaluation. Receiver60s/harness30s bounded.

Source alternateflag0→1→0, cursor(8,4)→(12,7)→(8,4). Source initial/main text equals savednormal capture-pane-a duringalt and restoredmain; mainmarker absent fromalt, altmarker absent restoredmain; historysize stable, cursorvisibility restored, identity/geometry stable. Capture comparisons use trimmed capture-pane text; they do not prove full cell attributes or trailingwhitespace byte equality. ActualTUI checks capturedmarker visibility only, not hostcursor parity. GPUI checks coherentgridmarkers plus selectedsnapshot alternate mode and cursor with source topheader+1offset. Freshinput marker independently appears in source and clientobservation.

First plain setupcursor assumption failure is retained under plain-setup-cursor-failure: resizing initial80columns to132resetcursorx before test, so initializing beforegeometry was invalid fixture ordering. Final explicitr initialization corrects setup without changingproduct. No hidden retry or directscreenmutation bypass: initialization goes throughsameadmitted inputpath.

Runtime receipt labels corrected after reviewer note to name eachlane accurately (metadataonly, no behaviorchange). AllownedPIDs gone, cleanup/errors checks passed, protectedCLI and exactCLI/TUI artifact hashes unchanged. No activeprocesses.

Reproduce (exclusive outputdirectories must be preserved before rerun):
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-alternate-screen/run.mjs plain
# repeat tui or gpui
```

Current GPUI history unit checks also passed (5 tests). Artifact build and installer lifecycle provenance are retained in sibling nr04-compiled-paste-2026-10-18 and nr07-installer-lifecycle-2026-10-18. This is one local stock3.8 DEC1049 workflow, not mouse/copy-mode/SSH/platform or full application parity.
