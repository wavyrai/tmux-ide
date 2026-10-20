# NR04 mouse press/release

Plain actual stocktmux client and compiledTUI both PASS exact SGR press/release and disabled negative; GPUI semantic press/release path is unavailable in current source, so no fabricated bridge text/bytes lane was run. This is not a complete three-client parity pass or nativeGUI failure claim.

Private raw Node receiver enablesDEC1000+1006; at source pane zero-based(10,6), expected application bytes ESC[<0;11;7M thenESC[<0;11;7m. Receiver commandd disables bothmodes; repeatedclick must emit noapplication bytes; freshf emits finalmarker. Exact final file equals press+release+df. Receiver never evaluates input; timeout60s andbytecap256, harness bounded30swaits.

Plain session18061 exited0. An owned node-pty spawned real stocktmux attach-session with private mouseon; host SGR(11,8 onebased) accounts for topheader1. It did NOT write SGR directly tosourcepane. CompiledTUI31202 exited0. Actual testdrive application-mouse click at hostzero-based(38,9) maps sidebar28+top3 to source(10,6). CompiledTUI/sourcecaptures show received/disabled/freshmarkers, source mouse_standard_flag andmouse_sgr_flag1|1→0|0. Source132x41window/132x40content, identity/geometry stable, exactbytes afterfresh confirmdisabledclickdidnotleak. EveryownedPID exited, noerrors, artifacts/protectedCLIunchanged. No failures this slice. No nativephysicalGUI/performanceclaim.

## GPUI gap and bounded next action

apps/tmux-gpui/bridge/browser.ts:227 inputunion contains previewtext/key/bytes/paste, resize, scroll, wheel; no semanticmousepress/release. bridge/wheel.ts:31–39 handles applicationmousewheel modepolicy. Native upstream/crates/herdr-gpui/src/tmux_snapshot/browser_ui.rs:93–109 click choosespane or starts localselection; :169–190 release finalizesdivider/selection, with no applicationmouse dispatch. Generic text/bytes could carry SGR but bypass the missing mode/coordinate/gesture owner, so would be misleading evidence.

Smallest product slice: add bounded semanticmouse input with action/row/col/button/modifiers; route only from the matching selected live request, coherent frame/currentpane geometry and mode-supported target. Preserve preview/history/stale-generation denial, existing local-selection/shift behavior, divider/menu guards. Hold press target through release and cancel onselection/generation/focus loss; do not retarget delayed release. Reuse renderer-neutral terminalMouseActionSupported/terminalMouseInput instead of secondencoder. Then run this receiver oracle through newbridgecommand and headless/nativeevent admission tests; physicalGUI remains separate. Wheel has an existing supported path and can be a separate matched three-lane slice.

Run (exclusive lane outputdirectories):
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-mouse-reporting/run.mjs plain
# repeat tui; gpui intentionally rejected
```
