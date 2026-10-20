# Real canonical link publication and native headless adapter

First capture35329 failed expected canonical geometry; cleanup/hashes passed. Its latest publication was not retained, so the precise cause is unproven. Corrected fixture records source pane IDs/active/width/height before explicitly selecting owned left pane. Final capture58258 passed: source rightpane active65 columns before setup selection; left66 columns then advertised preferredPane selected via actual bridge. This supports the fixture-selection explanation for the successful corrected run, not retroactive proof of the first failure.

Final gpui-final/publication.json is exact source bridge output, SHA256 2f8604edb312375ebcd7cf43a88cf704f37346a8563f3b61b29b246a78d5f4ae. It has selected copyRegion left0/top1/66x40, raw composed132x41 frame, canonical wrapped continuation row4, inputReadytrue, request2/presence1. Installed CLI2.9.7 and source bridge hashes, private identity/geometry, zero application bytes and observed PID cleanup are retained in receipt. No URL opened, no GUI. Historical compiledTUI artifact fields are unused in this capture (the runner copied prior isolation scaffold).

Native test proposal now uses exact retained JSON via browser::Reader::accept through a cfg(test) wrapper, applies decoded state, and invokes actual terminal_click in TestAppContext. Pixel bounds and exact-frame paint completion are simulated. It tests three web targets including soft wrap, rejects unsafe schemes/OSC8friendlylabel/adjacent-pane, and stale/inactive/unpainted/overlay/composition admission. No claim of physical event/paint alignment or OS browser opening. Independent source review approved the adapter; completed gates are recorded below.

Capture reproduction uses Node24 --import tsx capture.mjs gpui with a new exclusive output directory; existing gpui/gpui-final outputs must not be overwritten. Run from original worktree root with explicit pinned artifact prerequisites recorded by receipt.

## Native verification completed

Official Rust1.96.1, CARGO_HOME=/private/tmp/tmux-gpui-toolchain/cargo, RUSTUP_HOME=/Users/thijs/.rustup; upstream target symlink reused on external volume, locked/offline, one build job, incremental disabled.

- Initial binary-target command (79927) ran0 tests: retained native-tests.log, no pass claim.
- First correct library compile (45820) failed strict unused-qualifications lint for gpui::Modifiers. Narrow qualifier removal retained in final source; native-lib-tests.log preserves failure.
- Corrected `cargo test --locked --offline -p herdr-gpui --lib native_link_fixture_tests` (15866):3passed/0failed,2859filtered.
- `cargo test --locked --offline -p herdr-gpui --lib tmux_snapshot` (50141):439passed/0failed/1ignored,2422filtered. Both terminalexit0. No Cargo remains.

Each negative admission begins with ready input and exact expected URL proof before invalidation; overlay creation is asserted. Fixture JSON is copied byte-identically to apps/tmux-gpui/fixtures/nr04-links-publication.json. Source diff has only cfg(test) Reader wrapper, test registration, new test module and fixed canonical fixture. Native physical modifier hit/paint/OS-opening acceptance remains pending. Tests never open an external browser.

The retained capture.mjs is archival: imports and explicit ignored output paths require its original worktree/path prerequisites. Do not run over existing gpui/gpui-final output. Raw captured JSON is fixed fixture-only content and contains no connection credentials. Both failed and passing attempts are retained.

Committed log copies omit redundant trailing blank lines; original task logs remain unchanged.
