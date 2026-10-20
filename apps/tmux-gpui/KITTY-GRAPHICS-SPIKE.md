# Kitty graphics protocol spike (20 October 2026)

Status: feasibility spike on `spike/kitty-graphics`, not a product feature.
Question: can the native GUI show images that pane programs send with the
kitty graphics protocol, given that tmux owns the panes?

## 1. The bytes arrive

tmux parses and drops APC sequences, so neither its grid nor a normal client
ever sees an image. A control-mode client is different: `%output` carries
the pane's raw bytes before that parse.

Verified against isolated servers (`-S` private socket, `-f /dev/null`) for
Homebrew tmux 3.7c and the repo's patched 3.7c bundle, with
`allow-passthrough` both `off` and `on`. Results were identical in all four
runs (`scripts/kitty-spike/probe-control.py`):

```
%output %0 A\033_Ga=T,f=100,i=7,q=2;iVBORw0KGgo…AElFTkSuQmCC\033\134B\015\012
%output %0 \033_Ga=t,f=32,s=4,v=4,i=8,m=1,q=2;/wAA//8AAP//\033\134\033_Gm=1;…\033\134\033_Gm=0;…\033\134\015\012
%output %0 \033_Ga=T,f=100,i=9,U=1,c=3,r=2,q=2;…\033\134\033[38;5;9m􎻮̅̅􎻮̅̍􎻮̅̎\015\012…
%output %0 \033Ptmux;\033\033_Ga=T,f=100,i=10,q=2;…\033\033\134\033\134\015\012
```

- Escaping: only C0 bytes and `\` are octal-escaped (`\033`, `\134`). The
  base64 payload is passed through unchanged. The existing `decodeControlBytes`
  restores the bytes exactly.
- Chunking: tmux splits `%output` at about 2 KiB, regardless of sequence
  boundaries. For a 1080p transfer (1,574 escapes of 4 KiB each), 1,573
  `%output` lines ended mid-APC. The parser therefore has to be a streaming
  state machine. After decoding, the reassembled stream was byte-identical to
  the source.
- `allow-passthrough` has no effect on what control mode receives. A
  `DCS tmux;` wrapped APC arrives still wrapped, with ESC doubled.
- Unicode placeholders (U+10EEEE plus row/column diacritics, with the image id
  in the foreground colour) are ordinary text to tmux. `capture-pane -e`
  returns them intact.

## 2. What the spike built

Daemon (`packages/daemon/src/terminal/graphics/kitty-graphics.ts`):

- A streaming `KittyApcScanner` that unwraps passthrough. It replaces each APC
  with a private marker OSC (6974), so the replica's VT parser reports the
  cursor at the APC's exact byte position.
- A per-pane `KittyImageStore`: transmission with `f=100`, `f=32`, `f=24`,
  `o=z` and `m=1` chunking; `a=T`, `a=p` and `U=1` virtual placements; and
  `a=d` by all or by id.
- Projection onto the existing replica `placements` contract, as kind
  `kitty-image`. The spike encodes the source sub-rectangle in the id. The
  image bytes are reached through `interpreter.kittyImages()` by
  `contentDigest`.

GUI (`tmux_snapshot/kitty_graphics.rs`): maps those placements, plus a
`kittyImages` side-table in the snapshot JSON, onto the painter's existing
graphics scene (`terminal_painter/images.rs`). `decode.rs` now accepts only the
`kitty-image` kind. Only the static `--tmux-snapshot` path is wired. The live
and browse paths still pass no graphics.

Evidence:

- Daemon vitest: scanner tested at every split point, passthrough, chunked
  and compressed RGBA, clipping, delete, and an interpreter integration test.
- Rust: a headless GPUI test replays a real tmux transcript fixture
  (`fixtures/kitty-graphics-snapshot.json`). It asserts that all three images
  decode and paint at their exact cell rectangles.
- `tmux-ide-gpui --tmux-snapshot … --validate-only` accepts both the fixture
  and an 80x24 demo snapshot.
- The dev window opened, but no screenshot exists. The screen was locked, so
  `screencapture -l` failed.

Reproduce:

```sh
python3 scripts/kitty-spike/make-sequences.py SEQ
python3 scripts/kitty-spike/probe-control.py TMUX SOCK SEQ out.ctl off demo
(cd ../../packages/daemon && bun ../../apps/tmux-gpui/scripts/kitty-spike/render-snapshot.ts out.ctl snap.json)
scripts/preview.sh snap.json
```

## 3. Findings (not implemented)

**Query responses and detection.** Programs probe with `a=q` and then usually
send DA1 (`CSI c`). They decide based on which reply arrives first. tmux
answers DA1 itself, synchronously in its input parser. Any reply the daemon
injects through `send-keys` therefore lands after DA1, and the probe concludes
there is no support. Reliable detection needs a small patch to our tmux
(`input.c`): answer `a=q` with `OK`, in order, when an opt-in option is set.
That patch fits naturally beside `native-grid.patch`.

Programs also gate on the environment: `TERM`/`TERM_PROGRAM` values,
`KITTY_WINDOW_ID`, and `$TMUX`. Under `$TMUX`, most mature tools switch to
`U=1` placeholders wrapped in `DCS tmux;`. Some read
`tmux show -gv allow-passthrough` first, so we would set it `on` for
compatibility, even though control mode does not need it. Both points need a
per-tool survey before any claims are made.

**Persistence.**

- Images live only in the daemon, per pane. They survive a GUI reattach,
  provided the side channel re-sends every referenced image on seed. They do
  not survive a daemon restart.
- Placeholder placements survive a capture reseed. This was verified by
  replaying `capture-pane -e` into the interpreter: the placeholder image
  stayed in place.
- Cursor-anchored placements are lost on any reseed, because tmux has no
  record of them.
- A restarted daemon would see placeholder text with no image. It should render
  the cells blank, not as PUA glyphs.

**Cursor-anchored placements vs placeholders.**

Cursor-anchored placements:

- tmux does not move the cursor past the image. In the fixture, text printed
  after `a=T` overlaps the image, unlike in a native kitty terminal.
- The daemon tracks absolute buffer lines. This drifts once scrollback trims,
  which the spike does not handle.
- Resize, reflow and tmux copy-mode cannot move these placements, because tmux
  owns geometry. Expect misplacement.

Placeholders:

- Correct by construction under scroll, history, capture and reattach, because
  they are text in tmux's grid.
- A resize narrower than the image wraps placeholder rows. The protocol
  accepts this, and the result looks broken until the program redraws.
- copy-mode shows the text cells, so a GUI-rendered copy-mode view gets images
  for free.

Recommendation: support placeholders first, and treat cursor-anchored
placements as best effort.

**Bandwidth.** A 1920x1080 PNG of noisy content is 4,835,230 bytes:

| Stage                                   | Size             |
| --------------------------------------- | ---------------- |
| Base64 in 4 KiB chunks                  | 6,461,161 bytes  |
| Control-mode wire                       | ≈6.53 MB (+1%)   |
| Same frame as raw RGBA (`f=32`), base64 | 11,059,200 bytes |

Local tmux delivered the 1080p frame in 0.24 s. Over SSH, send the PNG bytes
from the remote daemon to the GUI once per content digest, and never as
decoded RGBA. Static images are fine. Video-rate updates are not
(≈50 MB/s at 10 fps).

**Live wiring still missing.** Missing pieces:

- an image side message in the delivery hub, compact encoding and
  daemon-client;
- the bridge forwarding images to the GUI over stdin JSON lines, which cap at
  8 MiB per line, so images need their own bounded and chunked message;
- digest deduplication;
- a byte quota per pane and per connection;
- real cell pixel size reported from the GUI. The daemon currently assumes
  10x20 px when `c`/`r` are absent;
- `a=d` variants beyond all and by id;
- z-index;
- the native `capture-pane -R` grid path, which still needs checking for
  combining-mark retention;
- a typed placement source rectangle in the contract.

## 4. Estimate

- Placeholder-first support across local and SSH, with the tmux `a=q` patch,
  protocol side channel, bridge, GUI, quotas and live tests: about
  **2–3 engineer-weeks**.
- Adding robust cursor-anchored placements (scrollback anchors, cursor
  advance, clearing semantics, reseed policy): **+1–2 weeks**, with known
  residual mismatches against tmux geometry.
- Animation (`a=f`/`a=a`) and file or shared-memory transmission
  (`t=f/t/s`): out of scope. They cannot cross SSH.
