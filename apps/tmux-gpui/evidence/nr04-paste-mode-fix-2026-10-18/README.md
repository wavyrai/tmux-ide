# Paste mode fix — prepared same-path rerun

Runtime completed after source-owner stability confirmation; results below. Baseline evidence is committed in c513c772 at apps/tmux-gpui/evidence/nr04-unicode-paste-2026-10-18. Harness copied from that retained final source; only output root changed. Original matrix remains untouched.

Saved current HEAD and exact dirty source diff/hash before running. Run each of plain,tui,gpui with modeon (no extra argument), then modeoff (`off`). Every lane directory is exclusive and will reject accidental overwriting. Preserve failures before any explicit rerun.

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-paste-mode-fix/run.mjs plain
# repeat tui and gpui; append off for modeoff
```

Unchanged assertions: DEC2004 source mode (and GPUI published mode), independent exact byte oracle, supplementary Unicode at framed UTF16offset1023, combining/wide/multiline payload, final marker and byte reread, matched132x41 sourcewindow/132x40 content, pane identity, cleanup observed PIDs and protectedCLI hash. Raw receiver does not evaluate pasted shell-looking text. ActualTUI and sourceGPUIbridge are distinct paths, no physicalGPUI claim. Record final six-lane summary and verify source diff did not change during run.

## Completed same-path verification

All6 lanes passed after the source fix, including TUI modeoff receiving2138raw bytes instead of the prior2150framed bytes. Modeon remains2150exact bytes in all3lanes. Each final byte reread, marker, identity/geometry, observedPIDcleanup and protectedCLI check passed. SourceHEADc513c772 plus saved diffSHA8018af9f20fe1a6c4195981c257bd0fe60a0177f82f93e3bed8eb7476942e9dc remained unchanged throughout. Sessions68270(plain/TUIon),17336(GPUIon),59804(plain/TUIoff),3557(GPUIoff) exited0. Original before evidence untouched; no failures in this afterfix run. No physicalGPUI claim.

Focused regression failed before the correction; 37 adapter/ingress tests and 50 pending/controller ownership tests pass after it. Scoped ESLint and the OpenTUI typecheck pass. Independent source review found no weakened admission or replay guards. This evidence uses source TUI with the retained genuine 2.9.7 daemon; it is not qualification of a newly packed TUI or a native clipboard/GUI build. Full terminal release, platform and installer acceptance remain open. Follow-up: Sfora #619, parent NR04 #613. No merge, push or publication.
