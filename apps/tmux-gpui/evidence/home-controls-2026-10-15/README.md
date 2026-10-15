# NP04: shared Home actions, first slice

Home Browse, Theme and Refresh now use the same native control foundation with primary, quiet and secondary emphasis. Existing quiet callers, command owners and guards are unchanged. No new upstream code was copied in this slice.

## Verification

- cargo fmt --all -- --check: passed.
- bash scripts/check-file-size.sh: passed.
- cargo clippy --locked --workspace --all-targets --all-features -- -D warnings: passed.
- cargo clippy --locked --workspace --all-targets --no-default-features -- -D warnings: passed.
- cargo test --locked --workspace: passed; opt-in ignored tests remain unproven.
- cargo test --locked --workspace --all-features: passed; opt-in ignored tests remain unproven.
- cargo build --locked -p herdr-gpui --bin tmux-ide-gpui: passed.
- Independent final diff review: no blockers; original quiet styling and Home action guards preserved.
- Native light/dark inspection at 1000 x 650 logical pixels: consistent heights, readable icons and labels, no action-row clipping.
- Native Browse click opened Sessions and panes; Escape dismissed it. Theme click opened Appearance.
- Native Refresh click emitted exactly `{"type":"refresh","request":1}` on the isolated browser wire. This verifies native click routing, not daemon completion.

Screenshots use the repository browser-fleet fixture, isolated HOME and unique ad-hoc QA app identities; no production daemon connection. Baseline is native alpha 2026101410. New source binary SHA-256: `cac19b6ba405d4574e404c6cf73ef7f83e5c1481d6f1a05af6ca1f1130e7f3ac`.

## Remaining acceptance

Narrow native geometry has not been verified: attempted edge drags did not resize the QA window. Refresh end-to-end daemon behavior was not exercised by this static fixture. This is only the first NP04 slice, not completion of the design system or a release qualification. Wider control migration and disabled/pending/destructive states remain outstanding.

## Before and after

| Theme | Before                            | After                           |
| ----- | --------------------------------- | ------------------------------- |
| Light | ![Before light](before-light.png) | ![After light](after-light.png) |
| Dark  | ![Before dark](before-dark.png)   | ![After dark](after-dark.png)   |

![Browse action opens picker](browse-light.png)

## Accessibility follow-up

The shared action control now exposes Button role, a stable accessibility identifier and a visible-label-or-tooltip accessible name. Pressed feedback follows Herdr `titlebar/navigation.rs`'s stronger foreground wash (reference commit f75df59eb53d69a11322f092eb3e45706b72db87).

Both workspace test configurations passed the new public Element/AccessKit metadata test. The full formatting/file-size, both Clippy configurations, workspace suites and native build completed successfully for the semantic change. Tests confirm metadata and registered Click action, not platform AX dispatch.

A fresh private QA app exposed Browse sessions, Theme, Refresh sessions and the sidebar control in the real macOS accessibility tree (retained in accessibility-tree.txt). Activating Refresh by its named element emitted one refresh request. The automation API may implement this using pointer input; this is not a VoiceOver/AXPress certification.

Home keyboard traversal is a separate in-progress change. Native Tab/Enter opened the picker, but two new headless activation tests currently fail; no keyboard qualification is claimed. The initial light-theme focus ring is too faint and is being revised.
