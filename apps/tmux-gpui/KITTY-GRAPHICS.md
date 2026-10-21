# Kitty graphics protocol in tmux panes

The native window shows images that programs in tmux panes send with the
kitty graphics protocol. Unicode placeholder images (`U=1`) are the supported
model; cursor-anchored images are best effort.

## Why it works under tmux

tmux parses and drops APC sequences, so its grid never holds images. A
control-mode client, however, receives the pane's raw bytes in `%output` before
that parse. Only control bytes and `\` are octal-escaped, and the daemon already
decodes them exactly. tmux splits `%output` at about 2 KiB, regardless of
sequence boundaries, so the daemon's scanner is a streaming state machine.
`allow-passthrough` does not affect control mode. A `DCS tmux;` wrapped APC
arrives verbatim and is unwrapped.

Placeholder cells (U+10EEEE plus row/column diacritics, with the image id in the
foreground colour) are ordinary text to tmux. They survive scrolling, history,
`capture-pane` reseeds, copy-mode and reattach. Renderers therefore resolve
placements from the cells they already paint, so placements are always in exact
sync with the text.

## Data path

| Layer                                               | Responsibility                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native/tmux/kitty-graphics.patch`                  | Window option `kitty-graphics`. Acknowledges `a=q`/`t`/`T`/`p`/`f` in stream order, so detection works before tmux answers DA1. Refuses file and shared-memory media with `EINVAL`. Honours `q` and `m=1` chunking, including inside `DCS tmux;`. Kitty APCs never become the pane title.                                                                       |
| daemon `terminal/mirror/control-channel.ts`         | On attach: `set-option -gq kitty-graphics on` (a no-op on stock tmux) and `set-environment -g TMUX_IDE_GRAPHICS kitty`. Disable with `TMUX_IDE_KITTY_GRAPHICS=0`.                                                                                                                                                                                               |
| daemon `terminal/graphics/kitty-graphics.ts`        | Scanner and per-pane image store. Accepts `f=100/32/24`, `o=z`, `m=1`, `a=t/T/p/d`, `U=1`. Budgets: 64 MiB per pane and 256 MiB across the daemon, least recently used evicted first. Only `t=d` (direct) transmission; file and shared-memory media cannot cross machines.                                                                                     |
| daemon `terminal-replica-interpreter.ts`            | Publishes per-pane graphics state: the image registry with each image's placeholder grid, plus cursor placements clipped to the viewport. This sits beside the canonical replica, never inside it, so replica hashes and old clients are unaffected.                                                                                                            |
| contracts `terminal-graphics.ts`, `pane-stream.ts`  | Capability: renderers add `TERMINAL_GRAPHICS_CAPABILITY_VERSION` (101) to the delivery offer's `protocolVersions`; daemons that predate it ignore it. Frames: `terminal-graphics` (state) and `terminal-graphics-blob` (512 KiB raw chunks). Client frame: `terminal-graphics-request` (pull by digest).                                                        |
| daemon `pane-stream-websocket.ts`                   | Announces state after delivery is ready. Serves requested digests, pacing chunks below a 2 MiB socket window so images never trip the backpressure ceiling.                                                                                                                                                                                                     |
| core `kitty-placeholders.ts`                        | Pure placeholder decoding and placement resolution, shared by renderers.                                                                                                                                                                                                                                                                                        |
| bridge `kitty-graphics.ts`, `live.ts`, `browser.ts` | The helper resolves placements against the exact snapshots it publishes and pulls only digests that are visible and not held by the window. Chunk lines are ordered ahead of publications and never coalesced. The browser moves placements to canvas cells, remembers held digests across helper restarts (`TMUX_IDE_KITTY_KNOWN`) and relays `kitty-missing`. |
| gpui `tmux_snapshot/kitty_graphics.rs`              | Assembles chunks (256 MiB / 512-image LRU) and maps placements onto the existing image layer. After a grace period it reports images that never arrived or were evicted, so they are pulled again.                                                                                                                                                              |

Each distinct image crosses the pane stream once per window. Over SSH the
remote daemon serves the same frames through the existing tunnel. A digest is
transferred only when a placement needs it and the window does not already
hold it.

## Full-frame clients

Some kitty-graphics clients draw their whole UI as one image. Under tmux they
re-transmit one image id every frame as a `U=1` virtual placement: RGBA,
deflated (`o=z`), in 4096-byte chunks, each chunk wrapped in `DCS tmux;`. They
print the placeholder grid once, with a 24-bit (`38;2`) colour id. Before
transmitting, they probe shared-memory and file media with `a=q`.

What keeps them correct and fast:

- **Media probes.** The patch answers `EINVAL` for `t=s`, `t=f` and `t=t`, so
  clients fall back to direct data on their own. Only direct data reaches the
  daemon through control mode.
- **Placeholder cells never paint glyphs.** The window paints U+10EEEE cells
  blank, resolved or not. Translucent parts of an image (toolbars,
  scrollbars) used to show the placeholder glyphs through them.
- **Re-transmitting an id keeps its placements.** It replaces only the pixels.
  `a=d` with `p` deletes only that placement. `a=f` root-frame edits (`r=1`,
  replace or blend) are applied.
- **Deflated pixels stay deflated end to end.** The daemon stores them as
  `rgba-zlib`/`rgb-zlib` and the window inflates them off its UI thread.
  Renderers that do not offer capability 102 get raw pixels.
- **Redraws need no publication.** Placements name the program's image (pane
  and image id). When an id is redrawn, the daemon pushes the new bytes at once
  and the window swaps them in as they complete. A superseded frame is
  abandoned mid-transfer. Until a redraw arrives, the previous image stays up,
  so there is no flicker.
- **Image-only output skips the parser.** A `%output` chunk that is entirely
  inside image payload changes nothing the parser can see, so the daemon does
  not hand it to the parser at all. Each parser write settles on a later timer
  turn, so dozens of them per frame used to cap the frame rate.

`bridge/kitty-graphics-perf.mjs` drives `scripts/kitty-spike/emulate-client.py`
through the product bridge path and times every image against its write.

## Pixel geometry

The native window reports rounded cell pixels with capability 103. Capability
104 adds thousandths of a device pixel, so the patched tmux derives each pane's
pixel dimensions without accumulating whole-cell rounding error. The pane's
winsize and CSI 14t response use the precise dimensions; CSI 16t keeps integer
cell dimensions. Older clients and servers retain the rounded fallback.
Fractional cell metrics can still produce a one-pixel difference at a snapped
pane edge; they avoid the multi-pixel drift from rounding every cell first.

## Programs inside panes

- The patched tmux answers queries in order, so ordinary detection (`a=q`
  followed by DA1) succeeds. Stock tmux cannot answer in order, so programs
  that rely on the query fall back to no images.
- New panes see `TMUX_IDE_GRAPHICS=kitty`. tmux-ide does not impersonate a
  terminal: it sets neither `TERM=xterm-kitty` nor `KITTY_WINDOW_ID`, because
  both enable features (terminfo, remote control) that tmux does not provide.
- Programs that support tmux generally detect `$TMUX` and emit placeholders
  wrapped in `DCS tmux;`. That is the supported path.

## Limits

- Cursor-anchored placements do not move the cursor, because tmux ignores
  them, so following text can overlap the image. Capture reseeds retain anchors
  only while dimensions, buffer and history coordinates remain unchanged.
  Resizes, history changes and actual terminal resets discard those anchors.
  Placements extending beyond the visible pane are clipped.
- Images live only in the daemon. They survive window reattach but not a
  daemon restart, after which placeholder cells paint blank.
- When `c`/`r` are omitted, the daemon assumes 10x20 px cells. It does not yet
  know the window's real cell size.
- Not modelled: animation frames other than root-frame edits, relative
  placements, z-index, and `a=d` beyond all and by-id (with or without `p`).
- When one image has several virtual placements, cells resolve to the most
  recently placed grid. The placement id carried in the underline colour is
  not read, because the replica does not carry underline colour.
- File and shared-memory media are refused, even for local sessions.
- Stock tmux turns every APC into the pane title. The daemon now ignores
  overlong titles instead of dropping the pane from its inventory.

## Verification

- Daemon vitest (`terminal/graphics`), core placeholder tests, bridge
  `kitty-graphics.test.ts`, and Rust `tmux_snapshot::kitty_graphics` tests,
  including a headless paint of a real-wire fixture at exact cell rectangles.
- `native/tmux/tests/kitty-graphics.py` runs in the sanitized native suite
  (`scripts/test-tmux-interaction-native.mjs`).
- `bridge/kitty-graphics-smoke.mjs`: owned daemon and scratch tmux.
  - Placeholder and cursor placements resolve, and the exact bytes arrive once.
  - A reattaching helper that already holds the image receives no bytes, then
    re-pulls the image after `kitty-missing`.
  - Passes on stock and patched tmux 3.7c. For the patched build, set
    `TMUX_IDE_KITTY_SMOKE_TMUX=<dir>` so it also checks that the option is on.
- `bridge/kitty-graphics-browser-smoke.mjs`: the product bridge path with a
  two-pane window.
  - Canvas offsets and ordered chunk lines are checked.
  - `TMUX_GPUI_TEST_BINARY` pipes everything into a dev native binary, which
    must accept every line.
  - `TMUX_IDE_KITTY_SMOKE_SIZE=1920x1080` exercises multi-chunk transfer.
- Reproduce the original probe with `scripts/kitty-spike/`.
