# NR04 matched quiet divider calibration — 2026-10-18

Reviewed source HEAD f75b10ea. Plain tmux, actual source OpenTUI, and source GPUI bridge reach the same committed horizontal pane geometry on stock tmux3.8: left width **66 →69 →75 →66**, right width **65 →62 →56 →65**, window132×41 and pane content height40/top1 throughout. Per-lane source IDs/shell PIDs, both markers and fresh input survive. Root independently compared final receipts, exact shape fields, cleanup and protected CLI assertions.

## Action paths and capability distinction

- Plain: direct private resize-pane commands. The moved/released labels name comparison stages, not pointer events. Top pane headers are explicitly matched to the daemon clients’ policy.
- Actual TUI: three complete SGR mouse drags through the real testdrive host terminal: x94→97→103→94 at y12. Each call sends down/move/up. This is actual TUI event handling, not native macOS automation.
- GPUI bridge: advertised token-based resize-gesture begin at66, move69 verified in source and publication while still dragging before release, release75 settled, then fresh gesture restores66. Native Rust chooses this protocol when canonical splitLayout is absent and resizeGestureSupported is true. This validates its bridge/daemon path, not native hit-testing/paint.

The first GPUI harness incorrectly required canonical split authority on stock3.8 and timed out before sending begin. Canonical authority requires native pane birth IDs, unavailable here. Diagnostic and failed receipts are retained. The existing token-based gesture remains supported; **stock3.8 is not limited to release-only resizing**. A lower-level resize-pane success was retained separately, but is not the final gesture acceptance. No product fix was needed for this fixture correction.

Both daemon lanes use genuine installed CLI2.9.7 SHA7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c with current source clients. All3/6/5 observed owned PIDs exited respectively; cleanup errors absent and protected repository CLI unchanged. No production resources were changed. Pane birth identity remains unavailable, not inferred from PID continuity.

## Reproduction and remaining acceptance

Retained mjs scripts run from worktree root; per-lane README files provide local toolchain commands. They write ignored nr04-divider artifacts. The harnesses depend on the recorded local binaries/installed package and are not portable CI entrypoints. artifact-sha256.json binds all retained files other than itself.

This is one quiet horizontal two-pane case. Event grouping differs between adapters, so it proves matched committed geometry and GPUI pre-release progress, not identical event streams or smoothness. Busy-output, vertical/nested layouts, source mutation negatives, bundled tmux/SSH, native GUI and performance qualification remain open. Initial captures, intermediate captures and earlier attempts are retained. No release, merge, signing or publication occurred.
