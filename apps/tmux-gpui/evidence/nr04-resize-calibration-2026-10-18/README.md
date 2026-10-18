# NR04 matched resize calibration — 2026-10-18

All three isolated lanes pass the same stock tmux 3.8 window round-trip: **132×41 → 152×45 → 132×41**. This qualifies a quiet, horizontal two-pane window resize only. It does not close NR04 or establish full native or performance parity.

| Lane | Action and observed result | Cleanup |
| --- | --- | --- |
| Plain tmux | Direct resize-window, canonical source content/geometry and fresh input | 3 observed owned PIDs exited |
| Actual source OpenTUI | Host terminal resize160×44→180×48→160×44, actual rendered host captures and source input | 6 observed owned PIDs exited |
| Source GPUI bridge | Actual bridge resize messages, coherent published grids and source input | 5 observed owned PIDs exited |

The daemon lanes use the genuine installed2.9.7 CLI SHA7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c. They use current source clients; this is not installed native-app qualification. Plain explicitly sets pane-border-status top to match the daemon clients' adopted header policy. Its default-policy receipt is retained separately. Equal window size alone would not have established equal content areas.

The final JSON receipts match exact pane left/top/width/height/window-size/zoom fields at all three stages. Initial/restored panes are(0,1,66,40) and(67,1,65,40); expanded panes are(0,1,76,44) and(77,1,75,44). Each lane preserves its own original pane IDs/PIDs, both deterministic marker strings and fresh input. Cross-fixture PIDs are intentionally different. Stock3.8 pane_birth_id is empty and is explicitly unavailable. Arbitrary terminal bytes/cursor/modes are not compared by this slice.

Root independently checked the three receipts' pass, cleanup and protected-CLI fields, empty remaining PID lists, exact shape equality and the GPUI receipt's TUI-receipt hash. Full source/receipt SHA256 inventory is in artifact-sha256.json. Earlier failures and weaker-cleanup receipts are retained but are not the acceptance results. The TUI first fixture failure read default session names before rejecting a missing explicit target; it sent no default-server input or mutations. Final harnesses use explicit private source and host sockets.

## Reproduction and limits

Per-lane recipes/provenance are in tui-README.md, plain-README.md and gpui-resize-README.md. Retained harnesses can be invoked from the worktree root using their path in this directory instead of the ignored .tasks path. They write to .tasks/native-reliability-mission/nr04; run TUI before GPUI, which verifies the TUI receipt. Recipes depend on the recorded local Node/Bun/tmux and installed-package artifacts; they are not portable CI entrypoints. No tracked CLI rebuild, production resource changes or native GUI input occurred.

Remaining: divider dragging, busy-output workloads, switch/split/zoom/close sequences, scroll/mouse/alternate-screen/Unicode/paste/links, replacement negatives, bundled tmux and owned SSH lanes, and native physical GUI acceptance. No speed, smoothness or broad equivalence claim follows from these captures. Nothing in this slice is signed, merged or released.
