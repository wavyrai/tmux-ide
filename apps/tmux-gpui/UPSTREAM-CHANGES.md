# Changes from the pinned upstream revision

- `upstream/crates/herdr-gpui/src/main.rs`: thin upstream-reference entry.
  Its original module composition and preview interception moved to new `lib.rs`.
- `upstream/crates/herdr-gpui/Cargo.toml`: adds the dedicated `tmux-ide-gpui`
  binary as the package default run target. New `src/tmux_main.rs` and `src/tmux_cli.rs` dispatch exclusively to
  preview modes, never normal Herdr startup. New `tests/tmux_cli.rs` checks
  executable argument rejection, product identity and offline validation.
- `upstream/crates/herdr-gpui/src/tmux_snapshot.rs` and `tmux_snapshot/`: new
  bounded JSON decoder, read-only window, latest-frame mailbox and regression tests.
  `bridge/` outside upstream owns the local TypeScript daemon connection.
- New `tmux_snapshot/browser.rs`, `browser_ui.rs` and `browser_tests.rs` add
  bounded native catalog/selection transport, sidebar and stale-request tests.
  `tmux_cli.rs` exposes `--tmux-browser-stdio`; the shared preview view composes it.
- `tmux_snapshot/input_gate.rs` and `input_interruption_tests.rs` add local
  interruption/re-arm behavior and deterministic native input regressions. The
  view, composition handler and browser UI share the gate; no daemon authority
  or upstream terminal protocol is changed.
- `upstream/crates/herdr-gpui/src/terminal.rs`: makes the existing
  `WheelRemainder` and its `add` method crate-visible for native tmux scroll
  handling. The accumulation behavior is unchanged.
- `tmux_snapshot/pane_chrome.rs` and `hit_regions.rs` add a display-only selected
  title and separator accents. Geometry excludes all pane content and nondefault
  blank cells; the existing terminal painter and daemon grid remain unchanged.
- `tmux_snapshot/shell.rs` and `shell_tests.rs` adapt the existing native
  titlebar/frame, pure theme and UI font defaults for the tmux browser. The
  browser uses compact navigation and bounded labels; upstream daemon bootstrap
  and integration actions are not invoked. Native appearance qualification is
  recorded separately in `VALIDATION.md`.
- `tmux_snapshot/picker.rs` and its tests adapt Herdr's native SearchInput and
  bounded fuzzy-search pattern to daemon session/pane IDs. Terminal input is
  excluded while the picker owns focus; publication/current-target checks remain
  at the tmux boundary. `search_input.rs` adds an opt-in byte limit for this
  picker while preserving existing default behavior; new limit tests cover it.
- `tmux_snapshot/sidebar.rs` and its tests group verified choices by session/window
  identity. The browser nests panes beneath the selected session, reuses Herdr
  `sidebar::label_text` for labels, and fences row callbacks against the current
  request and catalog. The existing theme and compact row styling are retained;
  this does not import HerdrWindow or its backend actions.
- `tmux_snapshot/appearance.rs` validates optional tmux bridge appearance data;
  shell, browser, search and the existing painter share its applied colors.
  The theme picker reuses SearchInput and theme-aware UI primitives, while
  persistence and palette resolution use tmux-ide contracts/config. Native
  system appearance notifications use GPUI observers and the existing bounded
  bridge channel; no Herdr settings or updater identity is inherited.
- No upstream dependencies, lockfile, painter or Herdr wire protocol changed.
  The tmux preview bridge adds optional appearance publications and theme/host
  appearance commands; terminal protocol and authority are unchanged.

The sidebar row presentation additionally adapts the selected-row typography in
`sidebar/row.rs::row_text` and hover-fill treatment from `sidebar/layout.rs`.
It retains `sidebar::label_text`, with a bounded marker gutter and label area;
window headings stay inert and selection continues through the tmux identity fence.

The tmux-only `glass.rs` / `glass/macos.rs` boundary adds Apple's public
`NSGlassEffectView` behind the GPUI Metal view using the raw-handle borrowing
pattern from `browser/native.rs`. It owns only its inserted sibling and its
accessibility observer. The member Cargo manifest enables existing objc2 AppKit
and Foundation features; dependency versions and lockfile are unchanged. Sidebar
chrome exposes the material only when the native boundary reports success;
unsupported/accessibility modes and terminal content remain opaque. This is a
new tmux adaptation, not a Liquid Glass implementation copied from Herdr.

The tmux-only divider gesture model adds fenced, release-time pane resizing,
status-row-aware geometry, stale/focus cancellation and an input-interruption
latch. It calls the existing tmux-ide daemon action through the JSON helper;
Herdr's wire protocol and terminal painter remain unchanged. Exact targeting of
ambiguous deeper nested boundaries is deferred.

The original hashes remain in `upstream-provenance.json`; do not regenerate
that manifest to hide downstream changes. All other upstream files must match.

`tmux_snapshot/pane_actions.rs` adapts Herdr’s pane-menu captured-target pattern,
hover rows and native SearchInput into a tmux-only Rename/Zoom/Restore menu. The
overlay preserves terminal geometry, validates the bridge capability and isolates
composition/terminal input. It uses the existing tmux daemon actions rather than
Herdr RPC. No Zed source was copied for this slice; its popover example served
as an additional reference for layering.

- `scripts/sign-preview-app.mjs` outside the vendored tree adapts the signing
  sequence from pinned Herdr `scripts/release/sign-macos.sh`: private copy, nested
  signing, notarization, stapling and verification. It uses tmux-ide identities,
  explicit Node entitlement policy and the existing strict archive format; no
  Herdr endpoint, credential import, universal build or DMG configuration is used.
