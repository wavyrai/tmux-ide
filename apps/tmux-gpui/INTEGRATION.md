# Native client integration plan

## Ownership

The existing tmux-ide daemon retains discovery, authentication, tmux ownership,
terminal capture, input routing and resize authority. The Rust client consumes
its supported contracts and paints cells through GPUI. It does not start another
tmux server, emulate the terminal again, or infer authority from display names.

Herdr's framed bincode protocol is not the tmux-ide protocol. Reusing the painter
requires an explicit adapter, not a socket address replacement. Keep upstream
source changes small and documented for possible contribution back.

## 1. One read-only pane

- Inventory the current daemon handshake and terminal schemas from
  `packages/contracts` and replica behavior from `packages/daemon-client`.
- Capture an isolated daemon fixture containing initial state, output, resize,
  disconnect and replacement. Never connect a test to personal sessions.
- Add a Rust adapter with bounded queues and no blocking I/O on the UI thread.
- Verify generation, pane incarnation, nonce, revisions, hash/chunk assembly,
  acknowledgement and reseed behavior before publishing a coherent frame.
- Separate upstream presentation revision from daemon revision: coalesced
  daemon updates can advance from R to R+n.
- Render one pane with cursor, colors, Unicode/wide cells and alternate screen.

Acceptance: fixture replay agrees with the daemon's expected cells; stale or
incomplete frames are rejected; an isolated live pane matches native tmux;
closing the window leaves the session running. No input or updater is enabled.

## 2. Input and resize

Add daemon-authorized keyboard, paste, mouse and resize, with an explicit single
owner. Verify stale-generation rejection, reconnect without replaying input,
and dimension/state ordering. Keep unsupported Herdr actions unavailable.

Acceptance: deterministic input/resize tests and an isolated live session pass;
reconnection cannot duplicate a command or mutate the wrong pane.

## 3. A distributable macOS preview

Replace Herdr-specific bootstrap, update destinations, application identity,
branding and unsupported product controls. Adapt scripts for the nested project
root. Define native CI and isolated smoke tests before enabling release jobs.
Audit retained dependencies and assets and remove unused Herdr features based
on actual adapter reachability. Keep required notices.

Acceptance: installed app connects to the supported daemon, opens an ordinary
tmux session and recovers safely from daemon replacement. Installer/updater and
signing have their own verification. Linux/Windows remain unqualified until
actually tested. Measure performance only after correctness passes.

## Baseline verification

The setup checks every imported file against the pinned upstream source and
checks that the root npm pack excludes this directory. The snapshot adapter has now passed a macOS debug build and native window
inspection; see `VALIDATION.md` for exact scope. The source baseline is intentionally complete to avoid
breaking embedded assets and tests before the adapter boundary is established;
it is not the intended final product feature set.

## Product layout direction — user requirement, 9 October 2026

The GPUI product follows the existing TUI's Home, session/window navigation and
pane arrangement. The current single-pane sidebar is a temporary integration/test
surface, not the intended release layout. Retain native rendering and pointer
interaction while preserving TUI information hierarchy and daemon-owned geometry.

Use these current implementations as source references:

- `packages/daemon/src/tui/mirror/home-surface.tsx` and `home-surface-model.ts`
  for Home projections and navigation hierarchy.
- `packages/daemon/src/tui/mirror/runtime/application-terminal-workspace.tsx`
  and `terminal-layout-projection.ts` for tmux pane geometry and workspace layout.
- `packages/daemon/src/tui/mirror/workspace/terminal-window-strip.tsx` and
  `terminal-pane-header.tsx` for window navigation and pane chrome.
- Renderer-neutral core/contracts/presentation models where available; native
  code must not invent a conflicting session tree or resize owner.

Before preview release, show the same representative tmux session in TUI and GPUI
and verify window selection, pane arrangement, active pane, status labels, long
names and narrow-window behavior side by side. Native GPUI controls can adapt to
pointer/keyboard conventions; do not redesign the product around the prototype's
semantic-ID list. This acceptance condition belongs to GP03/GP05/GP08/GP11.


## Upstream integration reuse

The user explicitly approved reusing Herdr GPUI code, including its GitHub and
VS Code integrations (9 October 2026). Keep Apache-2.0 notices and provenance,
adapt daemon assumptions at the boundary, and preserve tmux-ide's TUI hierarchy.
These integrations are not currently exposed or qualified in the tmux preview;
bring them over after the usable core client rather than claiming inherited
source presence as working integration.


## Native shell acceptance

The terminal adapter is not visual or functional Herdr parity. Adapt the shared
native titlebar/frame, theme and typography around tmux-ide's TUI hierarchy.
Keep the terminal canvas responsible for its own measured bounds; header and
navigation clicks must not become terminal input. Verify normal and narrow
windows, long labels, focus and active-pane indication in the actual native app.
Headless layout and terminal tests cannot substitute for these checks.

The pinned Herdr source provides transparent native titlebar styling; the audit
found no explicit Liquid Glass content renderer. Its icon documentation discusses
OS lighting and disables glass effects in the catalog. Additional material or
translucency effects require their own implementation and native verification.
GitHub and editor actions remain separate unfinished integrations, not benefits
conferred automatically by importing upstream code.


### Concrete integration paths still to implement

- **Open in VS Code:** no dedicated opener was found in the pinned upstream
  application. `window/file_links.rs` opens validated local documents with the
  system default application; `vscode://` appears in rejected-URL tests. Add an
  explicit editor action using the selected pane's daemon-provided local cwd,
  with safe argument/URI handling and clear unavailable-editor behavior. The
  current preview catalog does not transmit cwd; use the workspace-state contract
  rather than guessing a directory from terminal output or session names.
- **GitHub:** `menu/github.rs` and `github/{auth,device,http,store}.rs` provide
  reusable authentication UI and workers. Configure tmux-ide's own OAuth/client
  and credential-storage identity before exposing them; do not inherit Herdr's.
  `menu/pr.rs` and `pull_request/` provide reusable branch PR/checks presentation.
  Resolve the selected local checkout and branch, fence responses on workspace
  changes, and verify Connect GitHub → view current branch PR → Open PR.
  Comment/merge actions in `menu/pr_actions.rs` require their own explicit action
  and failure verification; they are not implied by a read-only PR view.

These are implementation dependencies, not completed features or a full-parity
checklist. The native shell comes first; each integration needs a real user
journey and evidence once connected to tmux state.


## Public preview distribution — Herdr audit, 9 October 2026

Pinned Herdr302700e1486977092e4a9165bc083ecdc9236227 provides useful patterns:
`upstream/scripts/update-manifest.py` emits exact signed JSON and deterministic
archives; `updater/release.rs` authenticates original bytes before parsing, then
checks release identity, bounded downloads and hashes; `updater/install/archive.rs`
checks archive paths, duplicates, entry types and expanded size. The release
workflow signs/notarizes before packaging and verifies uploaded draft artifacts.

Adapt the patterns; do not enable its product updater. Its repository endpoint,
key, Herdr.app naming, calendar versions and bundle identity are not tmux-ide's.
Our installer accepts regular files/directories only, so the initial archive
contract must reject symlinks even though Herdr supports bounded internal links.

The frontend must authenticate a tmux-owned manifest, download the exact bounded
asset, extract into a private tree, bind its authenticated version to the app's
bundle version, and call the existing transaction with mandatory macOS verifier.
The transaction's directory version alone does not establish bundle-version
equality. Keep rollback explicit and preserve daemon/session ownership.

A Node-based entry can initially require existing Node24. It must not execute
the downloaded bundle's Node before authentication. A no-prerequisite bootstrap
is a separate qualification step; do not claim a one-command public installer
until the complete published journey has been exercised.

Host inspection still reports zero valid code-signing identities. Synthetic
release authentication can be verified with ephemeral test keys; successful
Developer ID signing, notarization and clean-machine installation require the
actual publisher credentials and cannot be inferred from those tests.


### Stable installed native launch entry

New installations retain `versions/<id>/TmuxIDE.app` and expose
`<prefix>/TmuxIDE.app -> current`. Updating or rolling back atomically changes
only `current`; existing extensionless version records remain readable without
migration. Foreign entries are rejected, and detach removes the owned launch
links while retaining versions and configuration.

Read-only Foundation inspection recognizes the actual development bundle through
both the stable alias and versioned path after install, update and rollback.
This does not qualify Finder/LaunchServices launch. That physical check remains
pending while the user tests the existing native window. Upstream mac_bundle's
Herdr.app ancestry/symlink assumptions are not a drop-in solution.


### Release metadata must precede signing

The development assembler deliberately emits `com.tmux-ide.gpui.development`,
short version `0.0.0`, build `0`, and a distribution:false development manifest.
An arbitrary archive version does not change that identity and will fail the
installer's expectedVersion check. The optional `--metadata` assembly input now supplies explicit tmux-owned
identity/version/build before signing. Before publishing, select the actual
release policy, sign the native executable and bundled Node
with the configured team, then sign/notarize the complete bundle. Never edit
bundle metadata after signing. Publisher Ed25519 key policy, HTTPS endpoint and
successful signed install remain separate required inputs and checks.

### Reuse-first native UI follow-up — 9 October 2026

Current browser_ui constructs basic rows and buttons, not the main HerdrWindow
sidebar/titlebar/palette system. Terminal plumbing and installer test counts do
not demonstrate Herdr feature or visual parity. The next UI work should port
existing components where practical:

1. Searchable session/window/pane switcher: adapt `src/search_input.rs` and
   `src/palette/{search,render}.rs` to the daemon catalog and existing Selection
   path. Reuse native text editing/matching; replace Herdr RPC action types.
   Qualify stale targets, focus return and no terminal input from picker typing.
2. Hierarchical sidebar/tab strip: adapt `src/sidebar/{row,view}.rs` and
   `src/titlebar/tabs.rs`; reuse label budgeting, theme and caching patterns.
   Map daemon IDs/selection, replace HerdrWindow/group/listener coupling.
3. Context menus: adapt `src/{tab_menu,group_menu}.rs` to daemon multiplexer verbs,
   retaining pending/error UI and identity checks. Do not import Herdr RPC or
   issue tmux commands directly from the UI.

These paths are within upstream/crates/herdr-gpui. This is an implementation map,
not completed UI. Existing license/notices remain required for adapted code.


### Native material appearance — user requirement, 9 October 2026

The user explicitly requests a Liquid Glass appearance comparable to Herdr.
Investigate the pinned upstream implementation and GPUI platform support before
choosing the adaptation. A transparent titlebar or vibrancy is not proof of a
Liquid Glass content layer. Preserve readable terminal colors, shared themes,
input/resize geometry and a solid fallback for unsupported platforms or reduced
transparency. Record actual native light/dark and narrow-window inspection before
claiming completion. This requirement is not implemented by sidebar hover styling.

Source investigation: pinned Herdr `titlebar.rs::options` supplies a transparent
titlebar, while pinned GPUI's `WindowBackgroundAppearance::Blurred` maps to
`NSVisualEffectView` with Selection material. Neither inspected implementation
contains `NSGlassEffectView`. Apple's public glass view is documented at
https://developer.apple.com/documentation/appkit/nsglasseffectview . Reusing the
existing blur path may supply a fallback; it does not satisfy the requested
Liquid Glass layer by itself. Keep this distinction in implementation and QA.

Read-only upstream follow-up on 9 October 2026: current main
`05db80a047863f5f860302ec68b53b67bdf56134` retains transparent titlebar styling and
GPUI 0.3.6; no glass view addition was found in the inspected comparison or
current window sources. This newer revision does add the VS Code side panel
(PR #358, `browser/code*.rs`, `code_server.rs`, `code_view.rs`). The earlier
VS Code inventory above describes only our pinned baseline. Assess the new
implementation for reuse independently; no upstream update has been imported.
