# NR04 Unicode/bracketed paste — real private lanes

Current source d0348e83, installed CLI2.9.7, Node24.21.0, stocktmux3.8. Raw receiver enables or disables DEC2004 explicitly. Exact independent expected file is created before input; the receiver only appends bytes, never evaluates payload, and emits DONE only after exact equality.8192byte cap,60s receiver deadline and30s harness waits. Every successful lane rereads exact bytes after final marker and geometry verification. No physical GPUI or performance claim.

Payload2138UTF8 bytes/2127UTF16 codeunits includes CJK, emoji, combining/precomposed accents,3newlines and inert shell-looking text. The supplementary emoji starts at framed UTF16offset1023, crossing a naive1024 chunk boundary. Modeon expected2150bytes includes one bracket pair. Modeoff expected2138raw bytes, unchanged to accommodate no client.

Final results: modeon plain/TUI/GPUI all pass; modeoff plain and GPUI pass, TUI fails with exactly2150bytes: framingESC[200~ andESC[201~ added to the2138byte payload despite source bracket_paste_flag0. Final TUI failure session20423 and initial equivalent failure11308 both retained. This is an actual byte mismatch, not a screenshot inference. Modeoff TUI produces no accepted DONE; no success claimed. See summary.json for exact file hashes and cleanup.

Paths: plain uses private load-buffer/paste-buffer -p -r; TUI uses actual testdrive v1 paste through hostPTY/OpenTUI parser; GPUI uses advertised input kind:paste after selected inputReady and published snapshot modes.bracketedPaste matches requested mode. Source window132x41/content132x40 with topheader across lanes; exact original pane identity/geometry unchanged on successful runs. Source finalmarker is verified plus actualTUI captured frame / GPUI coherent published grid. Plain source capture is its observation. These are not interchangeable physicalGUI evidence.

Reproduce from isolated worktree (output dirs intentionally exclusive):
```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-unicode-paste/run.mjs plain
# replace plain with tui or gpui; append off for modeoff
```
Preserve/rename existing lane directories before explicit rerun. plain-first is earlier less-targeted payload; *-before-final-read preserve prereview runs before final byte reread assertion/conditional claimlabel. Final plain/tui/gpui and corresponding -off dirs are acceptance/failure records. Session18408 finalplain+TUI pass;83767GPUIonpass;20423TUIofffail;28268GPUIoffpass. All final lanes cleanup true, no remaining ownedPIDs, protectedbin/cli.js unchanged. Setup respawns only private pane receiver; no builds/product edits/GUI/production/personalSSH.

Follow-up card: https://www.sfora.ai/org/wavyr/projects/nx7esp8s8ftgdfrv7m1av67zah89nd0d/board?detail=card:kn71bd5tenv59w3mshy8g6j0m58ggdec

Additional current scoped checks: bridge input.test.ts 4 passed; TUI terminal-input-adapter.test.ts 8 passed. These existing tests did not reject the mode-off mismatch. No full terminal release or native GUI gate claimed.
