# Pixel native-surface development integration

This pinned patch targets the maintained terminal-browser repository, which now
contains Pixel under `pixel/`. It connects Pixel's complete composited canvas to tmux-ide's Rust
native-surface SDK on macOS. It includes the browser chrome, uses an owned CPU
copy into BGRA IOSurface storage, and avoids routing native frame payloads through
the tmux-ide Node daemon or tmux. It is not zero-copy Chromium texture sharing.

Status: the maintained terminal-browser checkout builds its native binding and
TypeScript packages, and passes 257 Rust tests (one ignored) and 92 JavaScript tests across the Pixel and browser packages. Electron 44.2.0 loads the
binding, and its browser daemon starts and shuts down cleanly with an isolated
profile. An isolated GUI run shows the full browser chrome, scrolling and viewport
expansion. A changing page emits zero terminal bytes on the native path; detaching
the viewer produces Kitty output for the unchanged page. A rebuilt capability-116
GUI also accepts a browser started after opening its terminal tab: scrolling from
section 1 to sections 10–11 emits only a 14-byte cursor control, with no Kitty
image frames. Closing the tab restores Kitty output for the unchanged page.
Simultaneous plain-terminal/native output is now implemented in source: the
publisher watches bounded daemon demand, keeps Kitty enabled until demand is
verified, and publishes both outputs when a terminal viewer needs images. Demand
changes invalidate the Kitty caches and redraw even an idle page. A rebuilt
browser run verified an ordinary tmux PTY client joining the live GUI, receiving
Kitty commands during scrolling, and leaving; subsequent GUI scrolling emitted
zero terminal bytes. This checks terminal delivery, not separately rendered
terminal-emulator pixels. These checks do not
establish native performance.
Do not replace an installed browser or advertise this as released support.

## Vendored distribution qualification

The patched browser uses the stable `tmux-ide-browser` application/profile identity,
separate from upstream terminal-browser data. Its upstream self-updater is disabled:
`upgrade` directs users to `tmux-ide update`, and release checks make no upstream
request. Upstream usage/crash telemetry is disabled even if old settings enable it.
The patch includes regression checks for both distribution boundaries.

This is still a development integration, not a bundled release. The signed runtime
candidate retains cookie encryption. A fresh persistent profile currently stalls
while initializing its encryption key; a minimal Electron reproduction also waits
in `safeStorage.isAsyncEncryptionAvailable()`. An ephemeral-profile diagnostic loads
the same local page, but is not a product fallback. Keychain settings have not been
reset or deleted. Runtime packaging, managed launch discovery, persistent-profile
startup and end-to-end native-controls qualification remain release gates.

## Prepare a separate checkout

Clone the repository and check out the exact commit in `provenance.json`, then:

```sh
node apps/tmux-gpui/integrations/pixel/prepare.mjs /absolute/terminal-browser-checkout /absolute/tmux-ide-checkout
```

The preparation script checks the revision, clean checkout and patch checksum
before applying anything. It refuses reapplication over existing work. The patch
contains a lockfile seeded from the tmux-ide native workspace so GPUI remains on
its pinned 0.3.19 renderer. Only development path dependencies are substituted.
Use `cargo --locked` for subsequent builds; do not silently regenerate the lockfile.

The current source uses native capability 116 with scoped retirement. Rebuild
the daemon, GUI and browser binding together; the earlier capability-115 browser
run is historical evidence; the separate capability-116 late-start run qualifies
the rebuilt daemon, GUI and binding together.

## Launch configuration

The browser now derives its local route from the launching terminal’s `TMUX`,
`TMUX_PANE`, `PWD`, and validated tmux-ide namespace. The authenticated daemon
resolves that exact socket, server PID, session and pane to a current semantic
pane, checking the owner generation and inventory twice. A rebuilt-browser GUI run verifies this automatic path without an explicit JSON
override: scrolling from section 1 to sections 10–11 produces 14 cursor-control
bytes and no Kitty image commands. Closing the GUI tab restores Kitty output for
the idle page. A second run replaces the browser process while keeping the original GUI tab
open; the new browser renders and scrolls with no Kitty image payload. Closing
and reopening that tab also recovers native rendering, with zero terminal bytes
for the subsequent scroll.

An explicit `TMUX_IDE_NATIVE_SURFACE` JSON object can select the route for fixtures,
using these fields:

- `record`: absolute path to the private daemon record.
- `serverId`, `generation`: exact current server registration.
- `workspaceName`, `liveSessionId`: exact selected workspace/session.
- `pane`: semantic pane ID, not a raw tmux `%` ID.

These values select a route; they do not grant authority. The SDK verifies the
private daemon record, local identity, server generation and one-pane read-only
capability. Never place owner tokens in this object. An invalid explicit configuration does
not fall through to inherited configuration.

Without a valid launch context or an authenticated native receiver, Pixel keeps its Kitty
path. Native startup is lazy on the render worker, and that worker polls while
idle to process retirement and send the newest queued canvas. A transport change
invalidates the Kitty render caches and requests a redraw, including when the
page's pixels have not changed. Remote browsers continue using Kitty; this patch
does not negotiate a remote native-surface channel.

## Qualification and limits

The patched engine and Node binding build, and the integration patch applies to a
clean checkout at the pinned revision. Earlier GUI runs exercised full browser
chrome, scrolling, viewport expansion, late startup, browser process replacement,
receiver loss, idle-page Kitty fallback and recovery. These are historical checks,
not proof that the latest browser remains on the native transport after resizing.
The latest resize run fell back to Kitty; the subsequent stale-handoff fix passes
its native transport regression, but its final interactive resize check remains
pending manual zoom/restore because desktop automation cannot deliver clicks.
An unlocked run loaded the test page, published red/blue/red favicon updates,
and displayed the favicon in the native pane header. Window-tab appearance after
focusing the browser pane remains unverified. The actual-daemon test
holds an old image across provider replacement and verifies that its retirement
cannot release the replacement frame. Bounded allocation, submission and demand
limits have regression coverage.

The macOS workspace CI sequence passes formatting, file-size checks, both Clippy
feature configurations, 3,868 default-feature tests and 3,902 all-feature tests.
There are respectively 26 and 33 ignored external/native tests; the explicit live
fixtures above are separate evidence. The full terminal release gate passes with
pinned Bun 1.4.2. Earlier Linux workspace Clippy checks passed both feature
configurations; they were not repeated for the favicon addition.
Windows was not qualified because its Rust target is unavailable on this host.

Mixed native and ordinary tmux-client delivery passes; independently rendered
fallback pixels, physical typing latency and GPU memory usage are not established
by these captures. This is a local macOS development integration, not a published
browser or tmux-ide release. It performs an owned CPU copy, not zero-copy Chromium
texture sharing. Remote browsers retain the existing Kitty transport.

## Open from tmux-ide

The CLI now exposes `tmux-ide open [url]`. It creates a new pane in the current
session (or `--session NAME` outside tmux) and runs the selected browser there.
Use `--split down --size 40` for a vertical split or `--window` for a new window.
The browser receives the new pane's tmux identity and the caller's validated
namespace. Do not set an explicit native-surface route from the originating pane.

To use this separately built native integration, make a dedicated executable
launcher with the absolute paths for your build, for example:

```sh
#!/bin/sh
export TERMINAL_BROWSER_DIST_ROOT='/absolute/runtime-with-electron'
exec '/absolute/node' '/absolute/terminal-browser-checkout/cli/dist/main.js' "$@"
```

Then select that launcher for the command:

```sh
TMUX_IDE_TERMINAL_BROWSER_BIN=/absolute/native-browser-launcher tmux-ide open http://localhost:3000
```

A launcher is useful because distribution-specific environment belongs to the
browser build; `tmux-ide open` forwards namespace and standard user directories,
not arbitrary environment or a parent pane's explicit native-surface override.
Without the override, macOS checks the managed app’s
`Contents/Resources/browser/terminal-browser` launcher first, then resolves
`terminal-browser` on PATH. Builds without a bundled launcher continue to require
the development override or a PATH installation. A PATH installation does
not make a standard installed browser native-capable. This command does not
install the patched browser, replace an existing installation, or publish it.

## Browser pane geometry

Use the current bundled, patched tmux when qualifying this integration. An older
installed tmux can silently ignore `refresh-client -C` pixel metrics: the test
browser then sees 16×32 cells while the GUI paints approximately 17×40 cells,
which stretches the canvas. The isolated browser fixture must resolve tmux from
the checkout being tested, rather than an unrelated installed release.

Pane cards now exclude tmux's reserved border/header row from the content area.
The Pixel patch also distinguishes terminal font zoom from initial PTY metric
correction: changing from 23 rows at 32 pixels to 24 rows at 40 pixels must not
apply a 1.25× page zoom. Font zoom inside an unchanged pixel viewport still works.
When the only viewer uses native surfaces, the browser removes its old Kitty
startup images before handing over, preventing doubled transparent toolbar
controls. Mixed terminal viewers continue to request Kitty output.

The complete-canvas publisher observes its own read-only pane while validating
the session's full layout. It does not require every neighbouring pane to be
subscribed by the producer. When retirement removes the last submitted canvas,
it may republish the latest canvas without exceeding two outstanding frames.

A native transport regression queues a real IOSurface, advances the committed
pane before delivery, then sends a fresh image on the same connection. The
receiver discards the obsolete handoff and retires its reservation rather than
switching the whole connection to fallback. Invalid tickets and unadmitted rights
still fail closed. The final interactive resize/transport check for this change
remains pending manual zoom/restore; desktop automation cannot deliver clicks.

## Native browser favicons

The prepared browser publishes the active tab's favicon as fixed 16×16 RGBA
pixels. `tmux-ide open` passes its pinned tmux executable to the new pane; the
browser uses that pane's own session environment, including when an existing
browser daemon hosts it. Updates are coalesced and unchanged icons are skipped.
The metadata contains no URL or local file path, and is cleared on session close;
the daemon ignores records whose publishing process has exited.

Native clients offer capability 117 (favicon metadata plus zlib decoding, formerly
102). Other clients receive the original layout shape. The GUI caches up to 64
decoded icons, uses them in pane headers and window tabs, and falls back to the
browser mark when the page has no usable favicon. This remains a development
integration. The native header and live favicon updates were verified on October
27; the window-tab icon still needs a browser-pane focus check.

## Native navigation controls (in progress)

The prepared browser now accepts `native/1/state` and `native/1/command` on its
existing instance socket when launched with tmux-ide's pane environment. Commands
call the existing browser methods directly; no terminal key sequences are used.
State includes a fresh browser instance ID, pane, active tab, revision, URL,
title and back/forward/loading flags. Commands must echo the current identity
and revision. Accepted commands invalidate that revision to prevent replay.
Tab activation, loading changes and shutdown invalidate stale actions; a delayed
Stop cannot turn into Reload. Navigation text and displayed metadata are bounded.

The development GPUI toolbar now uses scoped discovery and transport for these
commands. This API is not included in native alpha 0.1.9. The current patch builds
and passes 50 browser JavaScript tests, and applies to a clean checkout at the
pinned source revision. Signed packaged GUI navigation was verified on October 28 with the checks
recorded below. These checks do not establish latency or performance parity.

## Browser engine extraction (development)

The engine archive remains a regular file inside the outer application package;
the native app installer continues to reject symbolic links.
`scripts/browser-runtime-extract.mjs` is a separate bounded extractor for the
engine. Its metadata must come from the authenticated application bundle. It
checks the archive digest before writing, rejects hard links and unsafe paths,
and creates only the exact approved framework links after extracting all regular
files. Every resulting link must resolve within the browser app. Failed staging
is removed without touching an existing installation.

`scripts/browser-runtime-load.mjs` caches the engine by archive digest in an
existing private, user-owned directory. It verifies the Apple signature, browser
identifier and Wavyr signing team before activation and on cache reuse. Concurrent
launches converge on an atomically installed tree. A failed existing cache is
reported rather than silently deleted or replaced.

Run the extractor tests with Node's test runner. For the real signed engine cache
test, set `TMUX_IDE_BROWSER_TEST_PAYLOAD` to the qualification directory containing
`candidate.json` and `browser-runtime.tar.gz`, then run
`scripts/browser-runtime-load.test.mjs`. The qualification test checks concurrent
installation, reuse and rejection of modified signed resources.

`scripts/build-browser-payload.mjs PREPARED_SOURCE ENGINE_PAYLOAD NEW_OUTPUT`
now assembles a standalone development payload, including CLI/browser bundles,
native binding, assets, JavaScript/Rust dependency notices, font license, engine
archive and launcher.
Assembly requires the exact pinned source and integration patch. Install that payload as
`Contents/Resources/browser`; the app needs no Node. The launcher resolves its own
location and runs `browser-launch.mjs` on the engine itself in Node mode
(`ELECTRON_RUN_AS_NODE=1`): the cached engine once `codesign` verifies it against
the browser's requirement, or, on first launch, a private copy unpacked with
`/usr/bin/tar` after the archive's SHA-256 matches `runtime.json` and the copy
verifies. `browser-launch.mjs` then installs the cache through the bounded
loader, and the private copy is removed on exit. Arguments are forwarded
without shell interpolation. Its internal relaunch entrypoint uses the same
loader. `assemble-local-app.mjs` accepts `--browser-payload PREPARED_DIRECTORY`
to copy these resources into a new app; its assembly manifest records every
browser file's digest. The copy rejects symbolic links and compares the complete
source and destination inventories. The prepared CLI accepts the launcher's absolute engine path separately
from the application resources.

Set `TMUX_IDE_BROWSER_LAUNCH_TEST_PAYLOAD` to this output directory and run
`scripts/browser-launch.test.mjs` to check both entrypoints in a temporary app
layout and isolated home, including paths with spaces and cache reuse. This test
runs CLI help/version only and does not establish live page loading.

The payload is explicitly marked non-distributable until final qualification.
JavaScript/Rust dependency notices and persistent-profile startup are checked.
The optional upstream `action` automation helper is not bundled; it can be
selected explicitly through `TERMINAL_BROWSER_AGENT`. The shipped browser assets
retain the upstream license and the font has a separate pinned license. Final
publication remains a separate release gate.

### Persistent startup qualification

`browser-runtime-startup.test.mjs` uses the signed engine, its normal persistent
profile mode, and the managed `tmux-ide-browser` app identity. It requires a real
loopback HTTP request and successful page load, with an external process deadline.
Set `TMUX_IDE_BROWSER_TEST_PAYLOAD` as for the cache test. A probe using Electron's
default app name exercises a different keychain identity and is not equivalent
to the managed browser. No encryption setting is disabled by this test.

On October 28, this test passed and the assembled browser launched through
`tmux-ide open` rendered the loopback page in an isolated GPUI pane. The page
request was observed by the fixture server. Final native toolbar interaction and
release signing qualification remain separate checks.

The Rust notice generator requires `cargo-about 0.9.2` and uses the locked macOS
runtime graph with the checked-in `about.toml`. It checks that every reported
crate is covered by a license text and preserves available source notices.
Private workspace components retain the separately bundled Pixel/native SDK
licenses. The font notice is bound to the exact shipped font digest.

The app signer explicitly signs the browser native module and scroll helper
before the outer app and records their before/after digests. The browser engine
archive must still be qualified independently; signing-sequence unit tests do
not establish a notarized release.

On October 28, Apple accepted the separately signed browser engine under submission
`14c0d6d9-6434-4e5f-8d30-9c2148f1e927`. Its stapled ticket survives the bounded
archive extraction, and cache integrity and persistent-profile startup checks
passed against that archive. The final payload also passed both launcher checks;
the Pixel JavaScript suite passed all 51 tests. These checks do not replace
notarization and focused navigation verification of the complete Mac app.

The assembled 0.1.10 candidate (build 2026102801) subsequently passed Developer ID
signing, Apple notarization (`7220b465-3c4a-450e-8d13-cc4d6d5cb593`), stapling,
Gatekeeper and the installer archive roundtrip. Its archive SHA-256 is
`2238f70c6c184cb7d296d19cdb3d9b2e1a067fb01805e4ac640a40774f8d6319`.
It remains unpublished pending final release review; the public native alpha
is still 0.1.9.

The signed candidate's October 28 GUI check used an isolated tmux server and
loopback HTTP fixture. Cmd-L navigation, native back/forward and reload, pane
zoom/restore, divider dragging, Cmd-T creation, Cmd-D splitting and keyboard
window switching passed. The HTTP fixture recorded the requested pages. The
browser stayed visible after zoom/restore and returning to its window. A prior
run waited inside macOS Keychain authorization; the subsequent fresh run loaded
normally without changing credentials or disabling encryption. These checks are
single-Mac correctness checks, not frame-by-frame blanking or latency benchmarks.
