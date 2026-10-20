# tmux 3.8 release qualification — 2026-10-18

Candidate: native 0.1.3 build 2026101801; daemon 2.9.7. Source fix 86bf371b; release metadata ee2da382.

- Local terminal release gate passed each boundary through package contents. The final installed journey initially failed because npm was absent beside the selected standalone Node runtime. After adding npm to that private tool directory, `pnpm test:pack-installed` passed with 2.9.7, including daemon replacement, input, split, resize, windows, installed automation and hosted return. Full logs remain in .tasks/tmux38-release-20261018.
- Native build and assembly succeeded. Ten candidate package tests passed.
- Packaged browser on stock tmux 3.8 recovered the same pane with input after private daemon replacement.
- Physical GUI: uniquely identified `Tmux IDE 1801 Split QA`, opened the sole private stock-3.8 session; used pane menu Split right then Split down. Observed coherent two/three-pane layouts, original node pane selected, Keyboard ready after both. Cmd-Q closed only QA. Harness confirmed no terminal input leaked, original PID survived, exactly three panes and cleanup. Screenshots retained in chat.
- QA copy changes only bundle display identity for targeting; native and bridge payload copied from candidate.
- Signing reached notarization but saved `tmux-ide-notary` profile was inaccessible. No signed release artifact or publication claimed.

Pending: current PR checks and merge, platform release qualification, npm publication, notarization, signed install journey and native installer update. Production tmux sessions untouched.

## Follow-up parity audit

Observed source behavior: session-tab navigation clears snapshot/layout/input readiness, retires the active helper, then selects the retained target (bridge/browser.ts). This is a candidate explanation for visible switching gaps, not a measured latency result.

Compare plain tmux, TUI and GPUI against identical private workloads on bundled tmux and stock 3.8, locally and through owned SSH. Record selected pane, process continuity, cursor/content, input delivery and terminal modes after each operation. Cover rapid session/window switching, quiet/busy panes, split/close/zoom, resize, alternate-screen scrolling, paste and daemon/SSH interruptions. Separate correctness failures from visual blanking and timing; retain failed traces and passing reruns. Prioritize preserving visible tab content while authority refreshes without enabling input against stale state. No connection pooling or rewrite is justified until this is measured.
