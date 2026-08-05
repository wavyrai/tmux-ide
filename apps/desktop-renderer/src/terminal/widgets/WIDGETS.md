# In-band rich rendering (m49.7)

A pane opts into rich rendering by **printing one line**. There is no protocol,
no registration and no handshake: any command, script or agent that can `echo`
can render a document, a diagram or a GIF into its own pane, and the pane never
stops being a real tmux pane while it does.

```bash
tmux-ide widget markdown PLAN.md      # or: … | tmux-ide widget markdown
tmux-ide widget image demo.gif
# Ctrl-C returns the pane to a shell.
```

## The marker

One line, four space-separated fields, wrapped in SGR 8 (conceal) so a terminal
with no tmux-ide attached shows a blank line rather than machine noise:

```
ESC[8m TMUXIDE-WIDGET/1 <id> <payload> <digest> ESC[0m
```

| Field     | Grammar                         | Meaning                                          |
| --------- | ------------------------------- | ------------------------------------------------ |
| sentinel  | `TMUXIDE-WIDGET/1`              | Token and grammar version, inseparable           |
| `id`      | `[a-z][a-z0-9-]{0,31}`          | A key of the widget registry                     |
| `payload` | base64url of UTF-8 JSON, or `-` | The widget's arguments                           |
| `digest`  | 8 lowercase hex digits          | FNV-1a 32 over `` `<sentinel>:<id>:<payload>` `` |

The grammar lives in `packages/contracts/src/pane-widget-marker.ts` because it
is a contract between two processes — a CLI that encodes it and a renderer that
decodes it — and a duplicated digest is a digest that will eventually disagree
with itself.

### Why it cannot fire by accident

A line activates a widget only if **all five** hold:

1. it contains the sentinel token, and starts with it once trimmed;
2. it splits into exactly four whitespace-separated fields;
3. field 2 is a syntactically valid id **and** a key of the registry;
4. field 3 is valid base64url decoding to valid JSON that matches that widget's
   **strict** schema (no unknown keys);
5. field 4 equals the FNV-1a digest of fields 1–3.

The digest is an accident detector, not a signature — anyone can compute one.
That is exactly the requirement: ordinary output cannot satisfy all five
conditions at once, so `cat`-ing this file, grepping for the sentinel, or
printing a log that quotes a marker inside a longer line leaves the pane alone.
Every case in that list is a test in `pane-widget-marker.test.ts`.

Version is inside the token rather than beside it, so a future `/2` grammar is
simply not a `/1` marker: an old build leaves it as terminal output instead of
half-parsing it.

## Detection

`detectWidgetMarker(rows)` is pure and runs over **cell rows**, never over a
string built from them — see the grid overlay invariants in
`../../experience/CANVAS_INTERACTIONS.md`. Rows the emulator marked `isWrapped`
are rejoined into one logical line, which is what lets a marker longer than the
grid is wide be detected at all. The newest valid marker wins.

Where each path scans, and why it is the cheapest correct point:

| Path                                 | Trigger                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive (`terminal-surface.tsx`) | After an output write **commits** — cells do not exist before the emulator parses.                                                          |
| Mirror (`mirror-pane-node.tsx`)      | The same, plus **every seed batch**: a re-lease repaints from `capture-pane`, so on that path a marker can arrive without any delta at all. |

Both gate the expensive full-buffer scan behind a cheap byte watcher that looks
for the sentinel's ASCII token in the raw stream, carrying its tail across chunk
boundaries. While a widget is already showing, every write schedules a scan
instead — that is what lets the widget go **away**.

## The pane is still a pane

The widget is an **overlay**, not a replacement. The emulator stays mounted,
visible to the accessibility tree and focusable underneath, so keystrokes still
reach the process. Clicking the document focuses the pane, not the overlay.

Ctrl-C therefore works the way it does in any terminal: the signal reaches the
process, the helper's handler erases the screen **and its scrollback** (`ED 2`
then `ED 3`), the marker stops existing, the next scan finds nothing, and the
pane is an ordinary terminal again. Nothing tells the app to close the widget —
the widget is simply a function of what is in the grid.

## The widgets

### `markdown`

`{ text: string, title?: string }`. Parsed by `markdown.ts` into a typed tree and
rendered by `markdown-view.tsx` as real elements. There is **no `innerHTML`
anywhere**, so document text can never become markup and no sanitiser sits
between the parser and the screen. Links are restricted to `http`, `https`,
`mailto` and same-document targets; anything else keeps its label and loses its
href.

#### The supported subset

This is **not** CommonMark, and it is not trying to be. It is the subset an
agent actually emits, and the list is exhaustive — anything absent renders as
the literal text the author typed, which is the honest failure mode for a
parser this size.

**Blocks:** ATX headings (`#` through `######`, closing hashes tolerated) ·
paragraphs · fenced code (```or`~~~`, optional language, unterminated fence
runs to the end) · blockquotes · unordered lists (`-`, `\*`, `+`) · ordered lists
(`1.`or`1)`, starting at the author's number) · task list items
(`- [x]`/`- [ ]`, rendered as a real disabled checkbox) · nested lists by
indentation · horizontal rules · GFM tables with per-column alignment.

**Inline:** code spans · `**strong**` / `__strong__` · `*emphasis*` /
`_emphasis_` · `~~strikethrough~~` · `[text](href)` links · `<https://…>`
autolinks · backslash escapes · soft line breaks.

**Deliberately absent:** setext headings (`===` underlines) · indented (four
space) code blocks · reference-style links and footnotes · inline HTML, which is
absent by construction rather than by omission — this renderer creates elements
and never parses markup, so there is no code path that could honour it ·
`![alt](src)` inline images, which parse as their alt text because a document
may not fetch bytes (the `image` widget is the supported way to show one) ·
mermaid and other diagram fences, which render as ordinary code blocks.

Code spans win over every other inline rule and their contents are never
re-scanned, so a documented shell command survives being documented.

No markdown library was added. There is none anywhere in this repo — the docs
site is fumadocs/MDX, which is React- and Next-only — and a parser we own is
smaller than a dependency, testable as pure logic, and CSP-green by construction
rather than by evidence.

**Mermaid-class diagrams are a follow-up, not a gap we forgot.** No
self-contained option is cheap: the usual renderer is a large dependency that
wants its own fonts and layout engine, which is a card of its own rather than a
line item in this one.

### `image`

`{ media, data, name?, alt? }`. `media` is one of `image/png`, `image/jpeg`,
`image/gif`, `image/webp`, `image/avif`; `data` is base64. It renders as an
`<img>` fed a `data:` URL, which the renderer's CSP already permits (`img-src
'self' data:`), so **a GIF animates for free** — no decoder, no fetch, no policy
change.

`image/svg+xml` is deliberately excluded. An SVG is a document that can carry
script and external references, so accepting one would turn "render the file
this pane named" into "execute the file this pane named".

#### Where the bytes come from, and the refusals

The helper reads the file **itself** — it runs in the user's own pane with the
user's own permissions — and the bytes travel inside the marker's payload.

This is a deliberate departure from the original card, which specified fetching
bytes through the workspace-files preview route. That route cannot serve them:
`WorkspaceFilesAuthority.preview()` classifies an image as `status: "binary"` and
returns only its name, size and media type, and the preview contract has no
payload field. Carrying the bytes in-band needs no new route, no contract change
and no workspace-boundary question in the renderer.

The cost is a ceiling, and the helper refuses rather than truncating:

| Refusal             | When                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `unsupported-media` | Not one of the raster extensions above (this is where SVG lands).          |
| `too-large`         | Over `PANE_WIDGET_IMAGE_MAX_BYTES` — about 50 KB of source; derived below. |
| `empty`             | A zero-byte file, or empty stdin.                                          |
| `unknown-widget`    | A widget id this build does not have.                                      |

#### Where the ceiling comes from

The binding constraint is the **mirror seed**, not the emulator's scrollback.
`SessionChannel` reseeds a pane with `capture-pane -p -e -J -S -2000`
(`DEFAULT_HISTORY_LINES` in
`packages/daemon/src/terminal/mirror/session-channel.ts`), so a marker that has
scrolled past 2,000 grid rows comes back with its head missing after any
reseed — a flow thaw, a reconnect, a re-lease. xterm's own 10,000-line
scrollback is irrelevant: it is four times larger, so it never binds.

Working backwards from 2,000 rows, at a reference width of 80 columns:

| Step                                    | Value                     |
| --------------------------------------- | ------------------------- |
| `WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS`  | 96 KB = 98,304 characters |
| Worst-case wrapped rows at 80 cols      | 98,304 / 80 = **1,229**   |
| Margin inside the 2,000-row seed window | 771 rows (39%)            |

The image source cap then follows from the payload cap through **two** encoding
steps, which is the part that is easy to get wrong: the file's bytes are base64
into the JSON argument object, and then the whole object is base64url into the
payload field. Each step costs 4/3, so the round trip is 4/3 x 4/3 = 1.78, and
`PANE_WIDGET_IMAGE_MAX_BYTES` is `(98,304 / 1.78) x 0.94` = **51,913 bytes**
(~50 KB), the 0.94 covering the JSON envelope and the field names.

Sizing the source at 96 KB instead — the figure that falls out if only one
encoding step is counted — would produce a 174,816-character payload, or 2,186
rows at 80 columns, which **overflows** the seed window. That is the number this
derivation exists to rule out.

One honest limit: the row arithmetic is width-dependent. A maximum-size marker
needs about **50 columns** to fit 2,000 rows at all, so in a pane narrower than
that a reseed can truncate one. It degrades safely rather than badly — see
below — but it is a real edge, and the daemon byte route is what removes it.

#### Truncation fails closed

A partial marker is **never** rendered as a partial widget. All five grammar
conditions are checked against the whole line, so a marker missing its head
(scrolled out of the seed window), its tail (still arriving), or any span in the
middle simply is not a marker, and the pane renders as an ordinary terminal
showing whatever text survived. This matters more than it sounds: a widget built
from half a payload would cost the user both the pane and the text that was in
it, with nothing on screen saying why. `pane-widget-marker.test.ts` covers each
truncation shape, and `mirror-pane-node.test.tsx` covers it where it actually
happens — a seed batch carrying a beheaded marker.

Serving image bytes over a daemon route — which lifts the ceiling entirely, and
is the right long-term shape — is a follow-up card, blocked only on contract
work another branch owns.

## Adding a widget

1. Add a schema and an entry to `WIDGET_DEFINITIONS` in `widget-registry.ts`.
2. Add a branch to `WidgetSurface`.
3. Add the id to `PANE_WIDGET_IDS` in `packages/daemon/src/lib/pane-widget.ts`
   if the CLI should be able to emit it.

Nothing else knows about widget ids. A marker naming an id this build does not
have renders a named refusal — "this build does not have it" — rather than
silently staying a terminal, so a version mismatch is legible instead of
mysterious.

The workspace `type:` panes (`explorer`, `changes`, `preview`, …) can migrate
onto this registry later; they are the same idea with a different trigger.
