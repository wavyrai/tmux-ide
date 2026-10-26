# Pixel native-surface development integration

This pinned patch targets the maintained terminal-browser repository, which now
contains Pixel under `pixel/`. It connects Pixel's complete composited canvas to tmux-ide's Rust
native-surface SDK on macOS. It includes the browser chrome, uses an owned CPU
copy into BGRA IOSurface storage, and avoids routing native frame payloads through
the tmux-ide Node daemon or tmux. It is not zero-copy Chromium texture sharing.

Status: the maintained terminal-browser checkout builds its native binding and
TypeScript packages, and passes 257 Rust tests (one ignored) and 92 JavaScript tests. Electron 44.2.0 loads the
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
clean checkout at the pinned revision. Actual GUI checks cover full browser
chrome, scrolling, viewport expansion, late startup, browser process replacement,
receiver loss, idle-page Kitty fallback and recovery. The actual-daemon test
holds an old image across provider replacement and verifies that its retirement
cannot release the replacement frame. Bounded allocation, submission and demand
limits have regression coverage.

The macOS workspace CI sequence passes formatting, file-size checks, both Clippy
feature configurations, 3,845 default-feature tests and 3,879 all-feature tests.
There are respectively 26 and 33 ignored external/native tests; the explicit live
fixtures above are separate evidence. The full terminal release gate passes with
pinned Bun 1.4.2. Linux workspace Clippy passes both feature configurations.
Windows was not qualified because its Rust target is unavailable on this host.

Mixed native and ordinary tmux-client delivery passes; independently rendered
fallback pixels, physical typing latency and GPU memory usage are not established
by these captures. This is a local macOS development integration, not a published
browser or tmux-ide release. It performs an owned CPU copy, not zero-copy Chromium
texture sharing. Remote browsers retain the existing Kitty transport.
