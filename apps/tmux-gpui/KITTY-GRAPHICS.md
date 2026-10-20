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
| `native/tmux/kitty-graphics.patch`                  | Window option `kitty-graphics`. Acknowledges `a=q`/`t`/`T`/`p` in stream order, so detection works before tmux answers DA1. Honours `q` and `m=1` chunking, including inside `DCS tmux;`. Kitty APCs never become the pane title.                                                                                                                               |
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
  them, so following text can overlap the image. They drift after scrollback
  trimming and are dropped by any capture reseed, including when a new window
  attaches (verified by the smoke test).
- Images live only in the daemon. They survive window reattach but not a
  daemon restart, after which placeholder cells paint blank.
- When `c`/`r` are omitted, the daemon assumes 10x20 px cells. It does not yet
  know the window's real cell size.
- Not modelled: animation, relative placements, z-index, and `a=d` beyond all
  and by-id.
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
