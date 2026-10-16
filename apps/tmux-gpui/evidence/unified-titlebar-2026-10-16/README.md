# Unified titlebar — October 16

Home and retained sessions now share the native titlebar. Removed the redundant visible Terminals toggle and second retained-session strip. Tmux window tabs remain inside the inset terminal workspace. Inactive tabs are ghost controls. Plus opens existing session picker. Existing request/revision capability guards retained.

Base: 9fe59d99. Native SHA256: 5c8f9d30620ddac9731e6c08aeb126aec042747b3537d6f62509f5a5c5b40fbe. Unsigned local preview, not a release.

Independent source review: np01_review; main implementation remaining_parity_audit. Narrow layouts and nested close regression tests added. Initial full suite found stale second-row height assertion, corrected to actual titlebar geometry and real scroll-wheel input.

Native windowed run passed: native-windowed.log. Two private sessions, first split into two panes. Typed markers reached their correct panes/session, Home showed ghost retained tabs, activating a tab restored the first session, closing second tab preserved its tmux session, quitting app preserved all source markers before fixture-owned cleanup. Screenshots home-unified.png and tab-closed-session-preserved.png.

Native fullscreen run failed: native.log and fullscreen-input-mismatch.png. Following fullscreen transition a click intended for left pane did not change selection and input reached previous right pane. Root cause not established. Existing terminal click early-return/paint-frame readiness mismatch is a plausible mechanism, unchanged by this titlebar patch. Do not claim fullscreen input qualified or bug fixed. Requires a separate narrow runtime trace/reproducer.

User preview: Tmux IDE Unified Tabs Preview.app, bundle com.tmuxide.preview.unified-tabs-20261016. Own private HOME/tmux socket/daemon/two sessions; closes and cleans only its own resources when app quits. Log user-preview.log. Not connected to production fleet. Existing production preview preserved.

Validation: formatting, 1000-line file-size gate, Clippy all-targets/all-features and no-default-features passed. Default and all-feature workspace tests passed; default GPUI passed 2,788 with 7 ignored; all-features GPUI passed 2,819 with 8 ignored. Full local log: .tasks/unified-titlebar-20261016/full-check-complete.log; condensed checked results in checks.log. Headless narrow layout and public scroll-wheel regression passed; narrow native resizing and IME remain unverified in this slice.
