# Split session-count correction — 2026-10-10

Before: native split correctly created panes but session metadata stayed at1. The real source regression failed with actual1/expected2; preserved before.log. Cause: split refreshed pane inventory but never refreshed session choices.

Fix reads canonical session metadata and commits under the same captured request/session/catalog/presence guard. Unknown counts remain omitted; totals include every window instead of visible pane inference. Independent review approved exact four source hashes in freeze.json.

Validation: focused13pass; TypeScript/lint/format pass; full bridge260pass/0fail/5optional skips. Same real source and packaged split journey passes1→2→3 with identity/name preservation plus prior stale/duplicate/no-space assertions and cleanup. Package artifact/compatibility5pass. No Rust source changed; existing native executable31792088… was verified by build receipt and reused.

Physical qualification used a separate bundle com.tmux-ide.gpui.split-count-qa, maintained native-pane-split-smoke and CUA. Observed sidebar1→2→3 after native right/down actions, coherent2/3pane layout and original node selection. SourcePID96635 survived clean Cmd-Q, original raw PTY received zero bytes; all3panes alive before successful fixture cleanup. Screenshots observed in chat, not persistedPNG. Controller96608 was absent afterward; user demo controllers93795/54706 remained live and untouched. Artifact hashes bind physical proof to packaged bridge.

Initial Home catalog appeared after a titlebar click without Refresh; earlier quick Refresh clicks did not establish a startup bug. No speculative startup change made. This is a scoped local pre-signing preview pass, not public release/signing/all-platform or full parity qualification.
