# Changes from the pinned upstream revision

- Kitty graphics: `tmux_snapshot/kitty_graphics.rs` assembles bridge image
  chunk lines into a bounded LRU and maps publication `graphics` placements onto
  the existing painter graphics scene (`terminal_painter/images.rs` decodes and
  paints). `browser.rs` accepts chunk lines beside publications and a
  `kitty-missing` command; `decode.rs` still rejects replica placements;
  `herdr-client` `SurfaceImages` gains `insert`/`remove` for incrementally
  arriving images; `terminal_painter.rs` gains a test-only `painted_images()`
  accessor. See `KITTY-GRAPHICS.md`.

- Native terminal web links: `tmux_snapshot/terminal_links.rs` reuses Herdr
  `terminal::link_at` HTTP(S) parsing and validation. Cmd/Ctrl-click resolves only
  the exact painted selected pane; canonical copy-region wrapping joins complete
  logical lines without crossing panes or guessing clipped continuations.
  It opens via GPUI without rearming terminal input or sending daemon commands.
  Ordinary/Shift selection remains unchanged; OSC 8 transport is not added.

- Alpha polish (2026-10-14): Home/Terminals share the native titlebar beside
  the macOS traffic lights, using Herdr titlebar move/double-click behavior and
  existing SVG assets. Follow-up styling directly adapts Herdr `window/tab_strip.rs`
  full-height cells, one-pixel dividers, primary wash and `text_on` contrast.
  Home/Terminals remain fixed destinations. Interactive tabs and sidebar toggle stop drag propagation;
  retained session and daemon-owned tmux window strips remain separate.
  Selected sidebar rows use measured, one-time reveal inspired by Herdr sidebar
  scrolling, while manual scrolling and keyboard navigation retain ownership.
  Font controls reuse shared size bounds, corner tokens and the check SVG;
  redundant preference writes/geometry resets are suppressed.
  Upstream reference refreshed separately to `01fd228fd03365abf5924dee8ebc1dbb9ba50825`;
  this is a targeted adaptation, not a bulk replacement of the pinned derivative.

- `tmux_snapshot/home/filters.rs` reuses Herdr SearchInput for bounded local
  agent name/session search and All/Working/Needs attention filters. Published
  roster identities, availability, coverage and selection fences stay authoritative.
  `composition.rs` excludes Home from deferred AppKit terminal composition cleanup
  so roster updates cannot discard search input composition.

- `tmux_snapshot/picker/commands.rs` adds the initial native F5 command vocabulary
  (Home, sessions, appearance and refresh), reusing the existing Herdr SearchInput
  adapter and tmux action owners. Terminal key forwarding yields F5 to the shell;
  request fences and popup/composition ownership remain in the existing picker.
  This is a partial command menu, not full TUI palette parity.

- `tmux_snapshot/controls.rs` introduces shared native icon-and-label tabs using
  existing theme colors and the attributed Herdr terminal SVG. `workspace_chrome.rs`
  uses them for app navigation and tmux window tabs. `icons.rs` registers the new
  tmux-ide-authored `assets/icons/tmux-home.svg`; upstream provenance is unchanged.
  The dedicated preview installs the asset source. SVGs receive explicit semantic
  foreground colors because GPUI does not paint an SVG without its own color.
  Shared icon buttons now render sidebar switch/theme/refresh controls with hints;
  their existing action listeners and ownership checks are retained.

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
- `tmux_snapshot/terminal_font.rs` and `picker/fonts.rs` reuse Herdr's
  `FontConfig`, installed font discovery and symbol fallback resolution for
  tmux-only family/size preferences. Renderer, selection, IME, wheel and resize
  geometry consume the same metrics. Preferences are stored separately from
  Herdr configuration; asynchronous saves invalidate stale native geometry.
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
and Foundation features; dependency versions and lockfile are unchanged. Navigation
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
hover rows and native SearchInput into a tmux-only Rename/Zoom/Restore and Split right/down menu. The
overlay preserves terminal geometry, validates the bridge capability and isolates
composition/terminal input. It uses the existing tmux daemon actions rather than
Herdr RPC. No Zed source was copied for this slice; its popover example served
as an additional reference for layering.

- `scripts/sign-preview-app.mjs` outside the vendored tree adapts the signing
  sequence from pinned Herdr `scripts/release/sign-macos.sh`: private copy, nested
  signing, notarization, stapling and verification. It uses tmux-ide identities,
  explicit Node entitlement policy and the existing strict archive format; no
  Herdr endpoint, credential import, universal build or DMG configuration is used.

- Native fleet preference controls add optional strict metadata and explicit
  favorite/collapse commands in the tmux-only browser boundary. Home cards reuse
  existing GPUI hover, tooltip, theme and chevron assets; new
  `assets/icons/fleet-star.svg` and `fleet-star-filled.svg` were initially original
  tmux-ide vector artwork and are now Heroicons assets (see below). `icons.rs` embeds these assets. Preference state and persistence
  remain owned by the existing local tmux-ide daemon resource. No Herdr protocol,
  dependency versions, upstream source hashes or terminal painter are changed.

- Native polish replaces 19 shared interface SVG filenames with unchanged
  Heroicons assets from tailwindlabs/heroicons commit
  `616b7a4dbbf3d011760af8066262cd5c6b3868f3`. Exact mappings and SHA-256 values
  are retained in `upstream/assets/icons/heroicons-provenance.json`; the MIT
  license is in `LICENSE-heroicons` beside it. Shared filenames also affect
  imported menu/settings/review glyphs. Agent brand artwork is unchanged.
  The app assembler includes the license and provenance in Resources.
- Home fleet layout uses explicit machine/server/session hierarchy and shared
  connection controls. Default native chrome uses neutral backgrounds and
  selection fills; shared tabs no longer use colored underline/divider styling.
  Terminal cell colors and custom preset values remain canonical. Source and
  package checks do not substitute for native visual qualification.
- Shared titlebar spacing now follows native full-screen state: the leading
  traffic-light reservation is removed in full screen and restored on exit.
  Native-picker decoration uses the shared subtle separator and neutral active
  fill; the applied theme icon has an explicit tint required by GPUI SVG paint.

- The tmux-ide saved-machine editor uses dialog-local focus handles to include
  Save and Cancel/Done in forward and reverse Tab navigation. Footer activation
  reuses GPUI key-up clicks with captured form/request identity; submitted Save
  leaves focus on Cancel. Terminal key routing and daemon mutation guards remain
  at their existing owners.

- The native tmux shell binds Control-Command-F to Herdr’s existing window-only
  fullscreen action, including when terminal or picker inputs have focus. It does
  not import the Herdr terminal/session keymap or change daemon authority.

- The tmux shell uses one rectangular native AppKit glass view beneath the full
  viewport and one root tint for continuous header/sidebar chrome. Navigation
  bands inherit that material; the former rounded sidebar outline and corner
  cutouts are removed. The rounded opaque workspace sits inside an 8px gutter,
  with window/pane headers and a rectangular terminal canvas inset far enough
  to avoid its corner silhouette. Home uses the same content treatment. The
  shared navigation-header wrapper accepts a fill override; other Herdr
  titlebar renderers keep their existing backgrounds. Accessibility and
  unsupported-platform fallback remains opaque, using the same chrome color.

- Saved-machine removal reuses the editor's dialog-local focus pattern for
  Remove and Cancel/Done. Forward/reverse Tab and GPUI key-up activation retain
  captured form/request identity; a submitted removal keeps Cancel reachable.
  Registry revision/profile checks and the daemon mutation path are unchanged.

- The Add-machine form reuses the saved-machine editor/removal dialog focus
  pattern for its SSH target, Cancel and Save footer. GPUI key-up callbacks
  retain form/request identity and composition guards. SSH validation and the
  existing daemon connection path are unchanged.

- Saved-machine removal feedback distinguishes an actually pending registry
  operation from an unconfirmed result. The latter directs users to Cancel and
  refresh; an uncorrelated registry error is not presented as proof that this
  removal failed. Confirmed absence and existing mutation/admission guards are
  unchanged.

- Home/Terminals titlebar tabs use the shared control corner radius and a compact
  height within the existing titlebar. Inactive tabs inherit the continuous
  chrome instead of painting a separate surface, including on hover. Only the
  selected tab receives a theme-derived highlight. Navigation and drag-region ownership are unchanged.
