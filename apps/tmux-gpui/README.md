# tmux-gpui — experimental native client

This work lives in the **tmux-ide monorepo**. It is not a separate repository,
submodule, npm package, or released application.

## Current state

`upstream/` contains the pinned Herdr GPUI source baseline, including its
Cargo workspace, tests, assets, documentation, Apache-2.0 license and third-party
notices. `upstream-provenance.json` records the source commit and SHA-256 digest
of every imported file. Upstream crate names are retained for comparison.
The adapter renders snapshots and the selected live window’s pane arrangement
through the upstream painter. Keyboard input targets one selected pane. The browser preview supports authenticated keyboard input and bounded Cmd-V text paste. A local TypeScript helper reuses the existing daemon delivery validator;
Rust reads bounded, complete publications off the UI thread. Initial window resizing uses daemon geometry authority; competing-viewer and focus-release qualification is still pending. Automatic reconnect is not implemented. Native text composition is
implemented with further IME qualification pending. If you click or type before
keyboard input is ready, the preview keeps input interrupted until you click the
ready terminal again and retype. It never replays discarded input. This also
applies after a terminal input queue failure, to prevent executing only the tail
of a command. A controlled native readiness test verifies this guard; broader IME and platform
qualification remain pending.
The baseline is the revision examined in our research, not a claim of latest upstream.

The root MIT license does not replace the imported source's license. Preserve
`upstream/LICENSE`, `upstream/NOTICE`, nested notices and attribution; identify
modified upstream files when adapting them.

## Development boundary

The production CLI, daemon and OpenTUI client remain the release surface. This
Cargo workspace is outside pnpm and npm publication. Native validation will be
separate until the first adapter is qualified. No Rust rewrite of the daemon is
required.

Use the dedicated `tmux-ide-gpui` binary. Do not launch the retained `herdr-gpui`
reference binary against personal state: it still has Herdr
connection/bootstrap behavior, update endpoints, branding, and product actions.
Do not run its installer, release scripts, or hook setup in this monorepo.
Some upstream scripts resolve the Git root and must be adapted before use here.
Nested `.github` workflows are source reference only; GitHub does not run them.

The root GPUI CI workflow includes a macOS ARM64 packaging gate. It assembles an
unsigned development app from the native build receipt and runs artifact checks
plus source and exact-packaged daemon compatibility checks. To run that gate locally with the pinned Rust toolchain,
packaging dependencies and cargo-about 0.9.2 available:

```bash
bash apps/tmux-gpui/scripts/check-packaged-app.sh \
  /absolute/node24/bin/node /absolute/node24/LICENSE /absolute/new-evidence-directory
```

The directory retains build/assembly/test logs and the app. The gate opens no GUI,
signs nothing and publishes nothing; hosted CI success and physical acceptance
are separate requirements.

For source validation, with the pinned Rust toolchain installed:

```sh
cd apps/tmux-gpui/upstream
cargo metadata --offline --no-deps --format-version 1
cargo fmt --all -- --check
```

The pinned toolchain is in `upstream/rust-toolchain.toml`. See `VALIDATION.md` for the checks actually run. This is an experimental development preview, not a supported general-purpose
tmux GUI.

## Preview release gates

See [INTEGRATION.md](INTEGRATION.md). Native session/pane selection, multi-pane
rendering, keyboard/paste, bounded history navigation, whole-pane copy and initial
text composition are implemented. Read-only local daemon discovery is available.
Primary Home/Terminals tabs are separate from tmux window tabs. The workspace
sidebar lists sessions; each selected session has one window strip above its panes.
Home uses a full-width layout with the current session catalog and loading, empty
and unavailable states. It hides the workspace sidebar unless a picker is open.
The native switcher and theme picker are implemented. Remaining release gates include physical comparison
with the TUI, broader IME/geometry/recovery qualification, signed packaging, and
clean-machine install/update verification.

Research: https://www.sfora.ai/org/wavyr/posts/nh727dsdkwj6d5ezhfkwzvzfz58fy1f7

## Snapshot preview

```sh
apps/tmux-gpui/scripts/preview.sh
# Or pass an exported TerminalReplicaSnapshot JSON file:
apps/tmux-gpui/scripts/preview.sh /absolute/path/snapshot.json
```

The launcher builds `tmux-ide-gpui` and selects `--tmux-snapshot`. Its dedicated
entry never dispatches to normal Herdr startup. It reads one bounded file before opening GPUI and has no network,
input, resize, updater or settings connection. Close the window or press Cmd-Q
to exit. `--tmux-snapshot FILE --validate-only` validates without a window.

This first viewer paints the visible grid with the existing glyph cache,
colors, decorations and cursor shape. History is validated but not scrollable;
blink is displayed steadily; image placements are rejected explicitly. The
included fixture is synthetic and validated against the TypeScript contract,
not a capture of a live session. Broader native parity remains a later gate.

Local adaptations are listed in `UPSTREAM-CHANGES.md`; the provenance manifest
retains the original digests for comparison.

## Live read-only preview

With Rust and the monorepo Node dependencies installed:

```sh
apps/tmux-gpui/scripts/live-preview.sh /absolute/path/connection.json
```

The connection file must be a regular file no larger than 16 KiB with permissions
`0600`, outside version control. It contains explicit connection coordinates:

```json
{
  "baseUrl": "http://127.0.0.1:PORT/",
  "ownerToken": "PRIVATE_DAEMON_OWNER_TOKEN",
  "scope": { "serverId": "SERVER_ID", "generation": "DAEMON_INSTANCE_UUID" },
  "workspaceName": "WORKSPACE_NAME",
  "liveSessionId": "LIVE_SESSION_ID",
  "semanticPaneId": "SEMANTIC_PANE_ID"
}
```

These values come from the authenticated daemon's scoped server/session/inventory
APIs. The helper does not discover, install or start a daemon. It issues an explicitly
read-only pane capability and never requests input or geometry authority. Tokens
stay in the helper; the native process receives only snapshots and connection state.

A bad hash, wrong identity, broken stream or daemon replacement retires the reader
and clears the view. Reconnect means explicitly restarting the preview with current
coordinates. There is no fallback to another session and no input to replay.
History is retained and validated by the canonical replica, but omitted from the
visible-grid publication. At most one pending complete publication is retained on
each side; no patch or partial frame is painted. ACK means committed by the helper's
canonical replica, not that the GPU has painted. This prototype has not been benchmarked.

## Isolated live smoke test

```sh
node --import tsx apps/tmux-gpui/bridge/live-smoke.mjs
# Include the real native window after building it:
TMUX_GPUI_TEST_BINARY="$PWD/apps/tmux-gpui/upstream/target/debug/tmux-ide-gpui" \
  node --import tsx apps/tmux-gpui/bridge/live-smoke.mjs
```

Use the repository's supported Node/Bun/tmux toolchain on PATH. The existing product
fixtures create a private HOME, daemon and tmux socket. The test verifies an initial
marker, newly produced output, shutdown, and refusal to adopt a replacement daemon.
The native variant waits for the UI to apply its unavailable state. All owned
children and fixture state are cleaned up in `finally`.

## Launcher process ownership

The live launcher owns the native window and its read-only helper. Closing the
window explicitly terminates and reaps the helper even when no new output arrives.
Ctrl-C or SIGTERM stops both owned children, escalating after a bounded grace
period if necessary. It never signals the daemon or tmux. Helper EOF still reaches
the native view so it can display unavailable state.

Run the process regressions with:

```sh
node --test apps/tmux-gpui/bridge/preview-processes.test.mjs
```

These process tests cover idle window close, cancellation, ignored SIGTERM, failed
spawn and helper failure. The native smoke also exercises launcher cancellation
against its private daemon and confirms that the daemon remains available.

## Dedicated native entry

`cargo build --locked -p herdr-gpui --bin tmux-ide-gpui` builds the native preview.
The upstream package name is retained for provenance; the executable name is
`tmux-ide-gpui`. No arguments opens the disconnected preview window. `--help`
describes supported modes; `--version` identifies an unreleased development
preview rather than copying upstream's version as a tmux-ide release.

The original `herdr-gpui` executable remains for reference checks only. Shared
modules currently compile through a library; this isolates startup dispatch but
does not constitute dependency trimming or a signed application package.

## Transitional session picker

To choose a session and pane interactively before opening the native read-only
window, use:

```sh
apps/tmux-gpui/scripts/select-preview.sh /absolute/path/private-host.json
```

The private `0600` host file contains only `baseUrl`, `ownerToken` and `scope` from
the live-preview configuration above. Selection is currently in the launching
terminal, not inside GPUI. The scoped daemon catalog supplies the sessions and
semantic pane IDs; the selected live-session identity is revalidated before opening.
A temporary private connection file is removed after the owned launcher exits.
This removes manual pane-ID copying, but automatic daemon discovery is still required before this is a normal user
installation flow. The native picker below supersedes this diagnostic picker.

## Native session and pane picker

```sh
apps/tmux-gpui/scripts/browse-preview.sh
# Or explicitly select a daemon/server:
apps/tmux-gpui/scripts/browse-preview.sh /absolute/path/private-host.json
```

With no argument, the launcher discovers an existing local daemon from its canonical
record and verifies endpoint identity and the shared wire-protocol compatibility
before authenticating. An incompatible protocol shows a safe error and requires
an explicit daemon or preview update, then Refresh sessions. This check uses the
wire contract, not the npm version number. Explicit private-host files do not use
this canonical discovery check. Discovery requires exactly one
online server; use the private host configuration described above when there are
multiple servers. Discovery never starts, repairs, or upgrades a daemon. Start the
normal tmux-ide CLI first if none is running. The browser opens Home; click a
session card or sidebar session. The native client opens the daemon's verified active
pane in its current window, then displays that window's pane feeds in tmux's arrangement.
If the current window or active pane cannot be identified uniquely, choose a window
explicitly. Opening a session does not replay input: click the ready terminal before typing.
Click another pane directly on the canvas to select it and focus keyboard input.
Clicks in separator gaps are ignored; layout changes must be painted before a
click can select a pane. Current subscriptions are limited to 24 panes across the
session. Window tabs and session navigation use verified daemon metadata. Native
pane titles are implemented in source: top titles occupy a separate row and lower
titles use only verified unused separator spans. Lower titles are decorative so
divider dragging retains priority; select their panes through the terminal body.
A lower title is omitted when safe separator space is unavailable. The current Live Resize Preview includes these titles. Both top labels were
visibly checked in an isolated two-pane demo; the complete header interaction
matrix remains unqualified. Selected pane actions remain below
the terminal canvas. Refresh
repeats local discovery (or rereads the explicit private host file) and
reloads the scoped catalog on Home. Returning Home retires this browser’s pane
connection and resize claim without stopping the tmux session. Home currently
shows sessions and a **New session…** name editor. Creation uses the daemon API,
refreshes Home on success, and leaves the new session unopened. The daemon chooses
the canonical tmux name. An unconfirmed creation requires Refresh before another
attempt; creation is never automatically retried. Home also observes agent rows
from already registered sessions using the shared TUI projection and status ordering.
It reads at most 32 sessions, displays at most 256 rows, and reports partial or
unavailable coverage. Observations refresh five seconds after each completed round
while Home is foreground; observing never opens a session. **Open** revalidates the
exact live session and pane before attaching. The populated daemon journey and
headless native interaction tests pass; physical roster layout remains unqualified.
In the Terminals workspace, the sidebar also observes agents from the selected
session using the same status projection and ordering. Clicking a row rechecks
the current session incarnation and fresh pane inventory before navigation;
duplicate names remain separate targets. Refreshing or unavailable observations
disable row actions. The list refreshes five seconds after a completed observation
and retires on background, navigation or helper failure. These reads do not reopen
sessions or grant terminal input. Native source validation is recorded separately
from the running demo build.

Project presentation remains future work. Other catalog updates are explicit through Refresh. After a daemon replacement, select Refresh sessions,
then choose a session and pane again. For explicit files, update connection details
first. The browser process stays open. Recovery is explicit through Refresh and
reselection; it does not automatically reconnect. Switching clears the displayed
frame immediately, retires the previous pane connection, and only admits responses
for the new selection. Each pane uses the canonical delivery helper with an interactive capability and
explicit daemon input authority. The GUI receives display state, never the daemon owner token.

The native browser is local-only. If it says Window inactive, activate the app
through macOS first. Once its status says Keyboard ready, click the terminal to
type. Ordinary characters, Enter, navigation keys and basic Ctrl/Alt
combinations are supported. Input is pinned to that selection; stale requests are
discarded and ambiguous acknowledgements are never retried. Native resizing and minimize/restore presence are implemented with further qualification pending. Function
keys F1–F12 and control punctuation have focused mapping coverage. Pane labels and window groups come from the verified layout stream, with semantic IDs as the fallback before layout arrives. The temporary terminal picker is retained as a diagnostic path.

Run the isolated two-session controller test with:

```sh
node --import tsx apps/tmux-gpui/bridge/browser-smoke.mjs
```

Setting `TMUX_GPUI_TEST_BINARY` runs the native UI variant, which waits for a human
or UI test driver to select panes in both fixture sessions, then click the terminal
and type `echo gpui` followed by Enter. The test checks the exact output row. It uses private fixture
state and cleans up only its own processes and tmux server.

The sidebar highlights the selected session. Window tabs appear only above the
terminal canvas; selected-pane context and connection status appear below it.
The titlebar follows Home or the selected session. Switch, Theme and Refresh live
in the workspace sidebar footer, with Browse/Theme/Refresh actions on Home.
Terminals returns to the last selected session only after a live catalog confirms
its exact identity; otherwise it opens the picker. Broader TUI Home agent-roster
parity remains part of INTEGRATION.md.

Cmd-V pastes up to 64 KiB of UTF-8 text into the focused terminal. Empty,
NUL-containing and Escape-containing clipboard text is rejected explicitly.
The helper uses the verified pane's bracketed-paste mode, chunks at the daemon's
input limit without splitting Unicode, and awaits each acknowledgement. If input
authority is lost or an acknowledgement fails, the paste stops without replay;
an interrupted paste may have delivered a prefix. This is not an atomic daemon
transaction. The shell must have a UTF-8 locale to interpret Unicode correctly.

Native text composition remains local until commit, then sends through the same
input authority. On macOS Option is reserved for native text/dead keys; use Escape
followed by a key for terminal Meta. Selection changes clear composition and
remove terminal focus; click the terminal to resume typing. Native Option-E/E
composition is verified; CJK candidate-window positioning and composition across
focus/selection changes still require broader native qualification.

### Scrollback (browser preview)

Shift-PageUp and Shift-PageDown scroll the selected pane's canonical history;
Shift-End returns to live. The vertical wheel/trackpad also scrolls history when
the pointer is over the selected pane; click another pane before scrolling it.
Terminal typing is disabled while reading history.
The viewport retains at most 1,000 history rows and 2 MiB of serialized row data
in addition to the canonical replica's own retention. It anchors by verified row
identity across output; an expired, replaced or ambiguous anchor returns to live.
Alternate-screen history is unavailable. Native resizing is applied again after
returning to live. Broader terminal-mode qualification remains unfinished.
Wheel events navigate local history; terminal mouse reporting and horizontal
wheel forwarding are not implemented.

Cmd-Shift-C copies the selected pane's visible content, including a historical
viewport. Copy is bounded to 4 MiB, omits wide-cell continuation placeholders and
neighbor panes, and preserves canonical soft-wrap joins. The pane must be the
currently painted frame. Without a selection this is whole-viewport copy.

Drag inside the already selected pane to highlight text; Cmd-C copies that range.
Selection holds one captured window frame while the daemon continues streaming.
Typing and resizing are suspended until Escape, a click, scrolling, focus change,
or a session/pane change resumes the latest state. Disconnect or incompatible
pane geometry clears selection. The status bar identifies the captured view.
Wide graphemes and soft wraps use the same cell ranges for highlighting and copy.
Dragging beyond the pane clamps to its visible viewport; automatic scrolling
while dragging and word/line selection gestures remain unimplemented.

## Standalone bridge payload (packaging foundation)

Build the Node 24 bridge into a new output directory:

```sh
node apps/tmux-gpui/scripts/build-bridge.mjs /absolute/path/new-bridge-payload
node /absolute/path/new-bridge-payload/preview-launcher.bundle.mjs \
  /absolute/path/tmux-ide-gpui --local --browse
```

The payload bundles its JavaScript dependencies and launches its sibling helpers
without `tsx`, `node_modules`, or a source checkout. Existing output directories
are rejected. `bridge-manifest.json` records file sizes and SHA-256 hashes;
these hashes are not a signature or runtime trust check.

This is only the bridge payload. A distributable application must still include
the qualified Node runtime, native executable, license notices, source provenance,
signing/notarization, and the install/update flow. No native release is produced
by this command.

## Local macOS development app

Build the ARM64 native executable with a local integrity receipt, then assemble it
and an explicit Node 24 runtime into a
new `.app` directory (macOS only). Python 3 and the workspace Rust toolchain
must be on PATH, with `cargo-about 0.9.2` installed (`cargo install cargo-about
--version 0.9.2 --locked --features cli`). Notice generation may need network
access to fetch dependency sources. The native wrapper builds offline; populate
the Cargo cache first with `cargo fetch --locked` from `apps/tmux-gpui/upstream`
if needed:

```sh
node apps/tmux-gpui/scripts/build-native-release.mjs /absolute/path/native-build.json
# Use the native executable path printed by the build command.
node apps/tmux-gpui/scripts/assemble-local-app.mjs \
  /absolute/path/tmux-ide-gpui /absolute/path/node \
  /absolute/path/node-LICENSE /absolute/path/native-build.json \
  '/absolute/path/Tmux IDE Development.app'
```

The assembler rejects existing destinations, wrong architectures and non-system
linked libraries. It includes the bundled bridge, Node license and project/Herdr
notices. Each assembly generates `RUST-THIRD-PARTY-NOTICES.txt` from the locked
workspace and records its hash. Generation failure aborts assembly and removes
only the newly created app. The report covers all features and the configured
platform union, including build/dev dependencies; it is a conservative superset,
not proof of which code is linked or of complete nested-code/asset attribution.
The assembler requires a receipt matching the binary and current declared Rust
source snapshot, checks it before executing the native binary, and rechecks the
copied payload after packaging. A mismatch requires rebuilding. The receipt
records local tool/build identities and before/after source consistency; it is
not a signature, reproducible clean-build proof, or trusted source-commit
attestation. Compiler/dependency caches and the host SDK remain outside that
claim. Set CARGO_HOME/RUSTUP_HOME explicitly when using a separate toolchain.
The launcher discovers an already running local canonical daemon; it
does not install or start one. Its optional argument is a private host JSON file.
It clears inherited `NODE_OPTIONS` and `NODE_PATH` and uses bundled runtime paths.

This is a development app, not a distributable release. Signing, notarization,
complete dependency notices, source provenance, clean-machine qualification and
installation/update remain outstanding. The manifest explicitly records that
qualification is incomplete; its hashes are not signatures.

If initial host discovery/configuration is unavailable, the browser helper stays
open with input disabled. Start the supported daemon (or correct the explicit
private host file), then use Refresh sessions and select the fresh session/pane.
A failed refresh clears the old frame and input authority. This is explicit
recovery; automatic reconnect is not implemented.

To repeat the physical daemon-replacement check, set `TMUX_GPUI_TEST_APP` to an
explicit freshly assembled app and `TMUX_GPUI_RECOVERY_SIGNAL` to a new absolute
signal-file path, then run
`node --import tsx apps/tmux-gpui/bridge/native-recovery-smoke.mjs`
from the repository root with the
fixture's supported tmux runtime on PATH. Follow its printed UI steps. Create the
signal file only after observing the unavailable/blank terminal. The fixture owns
its daemon and tmux session and cleans both up; do not use it for real work.

## Automated correctness lane

Run `bash apps/tmux-gpui/scripts/check-bridge.sh` from the checkout with Node 24
and pnpm dependencies installed. It typechecks the bridge and runs all bridge unit
and process tests. The two local-app tests skip unless `TMUX_GPUI_TEST_APP` points
to an explicitly assembled app; a headless green result does not qualify packaging.

`.github/workflows/gpui-preview.yml` defines an independent preview lane: Linux
bridge checks and isolated startup/replacement/session journeys using supported
system tmux, plus macOS Rust formatting, file-size checks, both Clippy and test
feature configurations, the dedicated release executable build and its isolated
CLI integration tests. Run those release checks from `upstream/` with
`cargo build --locked --release -p herdr-gpui --bin tmux-ide-gpui` and
`cargo test --locked --release -p herdr-gpui --test tmux_cli`. The lane does
not publish artifacts, sign, install, or operate production sessions. Physical UI,
bundled runtime, display-scale and release/install/update qualification remain
separate required evidence. A local check does not establish a hosted CI pass.

Session selection briefly opens a read-only canonical layout stream so pane names
and window tabs appear before the first terminal is opened. The completed catalog
includes an optional verified active-pane preference. Only an explicit native
session-open action consumes this preference, once, through the existing pane
selection command. Passive catalog updates and legacy helpers do not open terminals.
The helper retires
after the complete layout snapshot; input stays disabled until pane selection and
the normal authority and focus checks complete. This uses the existing stream protocol and may briefly receive
terminal deliveries; it is not a metadata-only daemon endpoint.

Bridge payloads include `THIRD_PARTY_NOTICES.txt`, collected from dependency
package roots present in the esbuild input graph. The bridge manifest lists those
package versions and the notices file hash. Missing or empty dependency notices
fail the build. This preserves the bridge's dependency texts; native Rust/system
library notice completeness still needs separate release review.

## Installation transaction foundation

`scripts/install-transaction.mjs` is an internal filesystem transaction module,
not an installer command. It accepts an explicit staging directory and private
installation prefix, requires a verifier callback to approve the copied candidate,
and activates a version through an atomic relative symlink. Prior versions are
retained for rollback. Removal detaches the current pointer and retains files;
it never stops apps, helpers, daemons or tmux sessions.

The isolated tests use synthetic apps and test verifiers. They do not establish
Apple signature validation, notarization, daemon compatibility, clean-machine
installation, or a public update channel. Bundles containing symlinks are rejected.
Journaled interrupted installs and updates have an explicit recovery command.
Recovery requires the recorded process to be absent, verifies retained app bytes
and publisher policy again, and quarantines inactive transaction candidates.
Pre-journal and repeated-install interruptions, legacy locks, uncertain ownership,
interrupted recovery, and interrupted rollback
or detach remain fail-closed. Power-loss durability remains unqualified. Run the tests
through `scripts/check-bridge.sh`; GP10 remains open until the full entry flow and
platform checks are implemented and verified.

The transaction callback can use `scripts/mac-app-verifier.mjs` for macOS release
verification. Supply trusted `teamId`, `bundleId`, `architecture` and
`minimumMacOS` policy from the release configuration, never from the candidate.
It checks Developer ID signatures on the app and both bundled binaries, enabled
Gatekeeper, architecture and macOS deployment requirements without running them.
The current unsigned development app deliberately fails this verifier. Signed
acceptance and the public installer entry are not yet qualified; see VALIDATION.md.

### Local staged-app install/update command

From the repository root, with Node available, `scripts/install-cli.mjs` provides
JSON results and requires an explicit private destination. Its parent must already
exist. Supply publisher policy obtained independently of the app: a JSON object
containing only `teamId`, `bundleId`, `architecture` and `minimumMacOS`. Keep that
file outside the staged app and managed installation. No signature-bypass option
is provided; the unsigned development preview cannot be installed by this flow.

```sh
node apps/tmux-gpui/scripts/install-cli.mjs --help
node apps/tmux-gpui/scripts/install-cli.mjs install \
  --prefix /absolute/managed-root --policy /absolute/trusted-policy.json \
  --app /absolute/SignedPreview.app --version preview-1
node apps/tmux-gpui/scripts/install-cli.mjs update \
  --prefix /absolute/managed-root --policy /absolute/trusted-policy.json \
  --app /absolute/NewSignedPreview.app --version preview-2
node apps/tmux-gpui/scripts/install-cli.mjs rollback \
  --prefix /absolute/managed-root --policy /absolute/trusted-policy.json
node apps/tmux-gpui/scripts/install-cli.mjs recover \
  --prefix /absolute/managed-root --policy /absolute/trusted-policy.json \
  --disposition keep-current
node apps/tmux-gpui/scripts/install-cli.mjs detach --prefix /absolute/managed-root
```

`uninstall` is an alias for detach: it removes the managed current pointer, retains
versions, and stops no processes. The app is not launched automatically. Locked
installations fail closed. Explicit `recover` requires `keep-current` or
`restore-previous`; it never steals a live or uncertain lock. `keep-current` retains
the selected app, while `restore-previous` selects the journaled prior app.
An interrupted first install with no selected app can be recovered with
`keep-current` after verifying and quarantining its candidate, then retried.
Recovery retains orphan bytes under `.recovered-*` for inspection.
This is the local staged-app flow, not the public download/bootstrap
installer. A signed positive install and clean-machine qualification remain open.

### Release-download components (not a public installer)

`preview-release-manifest.mjs` authenticates exact manifest bytes using an
independently supplied Ed25519 public key. `preview-release-download.mjs` uses
that metadata to stage the exact bounded archive under an explicit private
directory, following only trusted HTTPS origins and verifying its size/hash.
The caller must clean the returned `stagingRoot` after consuming the result.
`preview-release-extract.mjs` re-authenticates and checks the archive before
extracting into another owned private tree. It supports only strict USTAR:
explicit TmuxIDE.app parents, printable-ASCII case-unambiguous paths, regular
files/directories, no links or GNU/PAX extensions. This is an internal packaging
constraint, not a terminal-text limitation. The real development bundle passes
this format. Callers own successful staging cleanup. These staging modules do not run or install candidates.
`preview-release-install.mjs` composes them with the atomic transaction and real
macOS verifier, including authenticated CFBundleShortVersionString binding on
the copied candidate. Cancellation during verification prevents activation;
cleanup errors explicitly distinguish a confirmed activation from an uncertain
transaction outcome. The same installer CLI now exposes explicit-version release mode; publisher trust and a live endpoint are not configured yet.
Signed positive installation remains unqualified; see VALIDATION.md.

### Standalone installer payload (local preparation)

Build the existing installer into a relocatable script:

```bash
node apps/tmux-gpui/scripts/build-installer.mjs /absolute/new-output-directory
node /absolute/new-output-directory/tmux-ide-install.mjs --help
```

The payload includes the MIT license and a SHA-256 inventory. It needs an existing
Node24 runtime and independently trusted policy, but no checkout or node_modules.
It preserves the same install/update/rollback commands and mandatory macOS
verification. This is not a published bootstrap installer; the inventory is not
a signature or a trust root. Signed installation and public delivery remain open.

### Explicit-version release install/update (not published yet)

With Node24, the same installer accepts release mode by omitting `--app`:

```sh
node apps/tmux-gpui/scripts/install-cli.mjs install \
  --prefix /absolute/managed-root --policy /absolute/trusted-release-policy.json \
  --version VERSION
node apps/tmux-gpui/scripts/install-cli.mjs update \
  --prefix /absolute/managed-root --policy /absolute/trusted-release-policy.json \
  --version VERSION
```

Replace VERSION with the publisher's explicit release identifier. The trusted
JSON has the existing four Apple fields plus `releasePublicKey` (64 lowercase
hex characters), `releaseBaseUrl` (HTTPS directory), and `redirectOrigins`
(explicit HTTPS origins). Obtain these independently of downloaded artifacts.
The command requests VERSION/update-manifest.json and update-manifest.sig below
the base, authenticates them, then verifies and installs the matching archive.
There is no automatic latest-version selection or inherited Herdr endpoint.

Release-mode Ctrl-C/SIGTERM requests cancellation and awaits cleanup. A reported
confirmed activation is not rolled back by subsequent cancellation/cleanup failure.
SIGKILL/power loss remain separate interruption cases. Rollback accepts either
trusted policy form; detach preserves stored versions/configuration.

No native release endpoint or publisher policy is available yet, and successful
Apple-signed installation remains unqualified. Install/update/rollback return
`launchPath`, the stable `<prefix>/TmuxIDE.app` alias. New stored versions retain
a named `.app` bundle; detach removes the alias and current link but keeps versions.
Foundation metadata inspection passes; physical Finder/LaunchServices launch is
still pending. Do not treat these commands as a released user flow.

### Prepare an archive (packaging only)

```bash
python3 apps/tmux-gpui/scripts/preview-release-package.py \
  --app /absolute/TmuxIDE.app \
  --version VERSION \
  --output /absolute/new-output/tmux-ide-gpui-VERSION-macos-arm64.app.tar.gz
```

The output parent must exist; an existing archive is never overwritten. This
adapts Herdr's sorted USTAR/gzip packaging to the installer's regular-file-only
contract. It rejects links, special files/modes, unsupported paths and oversized
archives. Keep the input app quiescent. Identical inputs produce identical bytes
in the tested Python/runtime environment; cross-runtime reproducibility has not
been qualified. This command does not verify, sign, notarize, install or publish
an app. Release metadata must be assembled before signing; an archive version
label cannot convert the development bundle into a release.

### Explicit metadata before signing

The assembler accepts an optional trailing `--metadata /absolute/metadata.json`.
For example, a local test policy can contain:

```json
{ "bundleId": "com.tmux-ide.gpui.preview", "version": "0.1.0", "buildNumber": "1" }
```

These example values are not an announced release. All three fields are required
strings. The bundle ID must use the tmux-ide GPUI namespace without a development
segment; version has three numeric components and buildNumber is a decimal
string. Unknown fields and malformed values are rejected before any supplied
binary runs or output app is created. Product name and minimum OS remain fixed.
Explicit assembly writes `assembly-manifest.json`, carrying the metadata and
`distribution:false`, `signing:not-qualified`. Default assembly still writes the
development plist and `development-manifest.json`. Both paths retain notices and
native-source receipt verification. Supply metadata before signing; this command
does not sign, notarize or make the resulting app distributable.

### Native session and pane switcher (source preview)

The native browser source now offers **Switch… / Cmd+K**. It reuses Herdr's native
search input for session and current-session pane labels; arrow keys navigate,
Enter selects a current daemon catalog target, and Escape returns focus. Picker
text/paste is isolated from terminal input. Search input is limited to1024 UTF-8
bytes and results to32 rows; oversized editing offers leave the current query
unchanged. IME composition keeps Enter/Escape from selecting or closing the picker.
A disconnected or superseded catalog invalidates it. This does not search panes
in sessions whose pane catalog has not been loaded.

Both workspace test configurations and lint configurations pass. The local
`/tmp/Tmux IDE Switcher Focus Preview.app` includes the switcher and initial-focus
fix; its receipt and checks are recorded in
`evidence/native-switcher-focus-2026-10-09/`. Earlier preview bundles may predate
these changes. Physical native focus/IME/scroll qualification is still pending.
It is not full Herdr palette or integration parity.

### Application and tmux navigation (source preview)

Home and Terminals are separate application tabs. Home uses the full window;
the workspace sidebar lists sessions, while a single strip above the terminal
canvas lists tmux windows. The selected pane and connection status sit below
the canvas. Cmd+K can select individual panes. Exact daemon identities, rather
than labels, determine the target; stale catalog callbacks are rejected.

Returning to Terminals reuses the previous session only after a live catalog
verifies it. The earlier nested sidebar prototype is superseded. See
`evidence/native-structure-2026-10-09/` for native layout and packaged checks.

The source window strip now reveals the selected tmux window after semantic
selection, tab order/label or width changes. Ordinary redraws preserve manual
scrolling, and an unmeasurable strip schedules only one layout follow-up per
stable state. The rendered overflow regression is recorded in
`evidence/window-tab-reveal-2026-10-10/`. The unopened local Navigation Preview
includes this fix and passes all three packaged-app checks. The user’s running
New Session Preview predates it.
Physical horizontal-scroll qualification remains pending.

### Pane divider resizing (source preview)

Backend and headless gesture checks pass. An isolated native run verified both
column and row divider drags against actual tmux sizes, including status-row
accounting and no terminal input leakage. The exact artifact, screenshots and
remaining nested-layout limits are in `evidence/native-divider-2026-10-10/`.
This is scoped evidence, not qualification of every later app build.

Drag a separator to resize the actual tmux layout continuously. The cursor
identifies available handles. The bridge reuses the TUI resize transaction: one
request in flight, only the latest desired size retained, and the exact final
target sent on release. Daemon receipts and coherent layout/surface geometry
govern progress; the client renders the verified updated layout. It does
not stretch terminal pixels or create a separate local pane layout.

Output can continue during a drag. Session, topology, pane lifetime, focus or
coordinate changes cancel the gesture; Escape cancels it too. Divider dragging
is isolated from text selection and terminal input. Outer tmux pane-status rows
are accounted for when requesting a content height.

Simple splits and unambiguous T-shaped segments are supported. Some deeper
nested outer dividers intentionally have no handle: a pane-size request can
move an inner edge instead. Those need exact split-tree targeting before being
enabled. Continuous resizing is implemented in the current local preview; older
helpers without gesture support retain release-only behavior. The client never
predicts terminal geometry. Current source and packaged bridge tests verify
changes before release, final target preservation and presence cancellation on
both axes. Physical smoothness of this build remains unqualified; see
`evidence/continuous-resize-2026-10-10/`.

The isolated real-tmux check is:

```bash
node --import tsx apps/tmux-gpui/bridge/pane-resize-smoke.mjs
node --import tsx apps/tmux-gpui/bridge/pane-resize-gesture-smoke.mjs
```

Set `TMUX_GPUI_TEST_BINARY` to an explicit native executable for the interactive
fixture. It opens only disposable sessions and asks for two divider drags.

### Shared tmux-ide themes (source preview)

The native browser's **Theme…** picker offers the same 22 named presets as the
TUI, plus Dark, Light and System. Search and select a theme; the applied marker
changes only after the helper saves it successfully. Escape returns to the
terminal. Typing or composing in the theme picker never sends terminal input.

The helper uses the shared config's `theme.mode` and `theme.preset`; unrelated
settings are preserved, and the saved choice is restored on the next launch.
System follows macOS light/dark appearance in the native app. It does not sample
an outer terminal's palette. Already-running TUI instances retain their own
settings lifecycle.

Theme changes update native chrome and terminal default colors together. ANSI
slots 0–15 use the shared TUI projection; slots 16–255 and explicit application
RGB colors remain unchanged. No terminal cells are rewritten. Custom/project
JSON themes, legacy color overrides and the TUI's automatic contrast controls
are not exposed by this native picker yet.

The local `/tmp/Tmux IDE Themes Preview.app` includes the theme picker. Its
artifact and packaged-helper checks pass. Source verification and packaging
status are recorded in `evidence/native-themes-2026-10-09/`; physical theme
appearance and macOS System transitions remain unverified.

### Native sidebar material (source preview)

The source preview now uses Apple's actual `NSGlassEffectView` for the sidebar
on supported macOS versions, with the active theme's tint and appearance. The
terminal remains opaque. Older systems and Reduce Transparency/Increase Contrast
use opaque chrome; runtime accessibility notifications request a redraw.

A separate synthetic debug window verified native activation, clickable theme
selection, dark/light changes, narrow-width clipping and clean exit. This is
not a new distributable app: the existing Themes Preview predates this change.
Accessibility transitions, old-system fallback and real-daemon qualification of
the glass build remain open. See `evidence/native-glass-2026-10-09/`.

### GPUI implementation references

Keep the native interface aligned with the tmux-ide TUI. In addition to the
vendored Herdr components, consult Zed’s
[GPUI examples](https://github.com/zed-industries/zed/tree/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/gpui/examples):
`scrollable.rs` for nested chrome scrolling, `uniform_list.rs` for long sidebar
lists, `popover.rs` for anchored menus and outside-click dismissal, and
`tab_stop.rs` for keyboard focus order. `window_shadow.rs` demonstrates window
decorations and resize hit testing; it is not a Liquid Glass implementation.

These examples are references, not new dependencies. Verify compatibility with
our pinned GPUI version before adapting them. The GPUI crate declares Apache-2.0;
preserve its license and attribution if copying source, and check each additional
Zed crate separately. No Zed example code has been copied by this reference update.

### Zed pane/header design reference

Reviewed Zed at `f16f9652ec57bf806e65b2a0d51bb92a63644914`:
[`pane.rs`](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/workspace/src/pane.rs)
for selected versus focused tab styling, tooltip/action composition and scrolling
the activated tab into view;
[`pane_group.rs`](https://github.com/zed-industries/zed/blob/f16f9652ec57bf806e65b2a0d51bb92a63644914/crates/workspace/src/pane_group.rs)
for separate visible divider and pointer-hit geometry (1px versus 4px there).

Apply these as design references to our native titles and tmux window strip:
keep selected identity separate from window focus/input readiness, reveal clipped
titles through tooltips, retain compact explicit actions, and keep the active
window tab visible. A larger divider hit target must still preserve our exact
pane/axis ownership and avoid stealing terminal selection. Do not replace daemon
geometry with Zed's editor-owned split layout or infer terminal input authority
from header focus. Our lower labels currently remain decorative to preserve
separator dragging; richer actions require explicit hit-area qualification.

The workspace crate declares GPL-3.0-or-later, unlike the Apache-2.0 GPUI crate.
No workspace source was copied in this review. Herdr remains the attributed
implementation reuse source; additional copied code requires checking its own
crate/file license. These are next design candidates, not implemented behavior.

### Native pane actions (source preview)

Open **Actions…** in the selected pane’s bottom context bar to rename it or
choose **Zoom / Restore**. Rename uses a native text field; Enter submits and
Escape cancels outside active text composition. The menu overlays the terminal
and does not resize it. It reuses Herdr’s captured-target menu and SearchInput
patterns while dispatching through tmux-ide’s existing daemon actions.

A menu belongs to its exact pane and current capability. Selection, lifetime,
layout or availability changes dismiss it. Actions are disabled while reading
history or without current authority. A submitted action is not replayed or
optimistically shown as successful; verified daemon state updates the label or
zoomed layout. Rename currently requires a nonempty title of at most 80 UTF-16
code units, matching the daemon contract. Clearing a manual name is not exposed.

Run the isolated real-tmux path with:

```bash
node --import tsx apps/tmux-gpui/bridge/pane-actions-smoke.mjs
```

It verifies exact-pane rename, literal tmux-format text, stale-command refusal,
absolute zoom/restore, duplicate suppression, and absence of shell input.

### Native signing pipeline

See [SIGNING.md](SIGNING.md) for the explicit existing-identity notarization command,
Node entitlement review, pre/post-signing provenance, and remaining release gates.
The producer does not import credentials or publish artifacts. Its tool-injected
checks do not establish successful Developer ID signing or clean-machine installation.
