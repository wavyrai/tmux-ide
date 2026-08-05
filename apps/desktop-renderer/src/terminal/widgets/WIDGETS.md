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

Dialect: headings, paragraphs, fenced code, blockquotes, ordered/unordered and
task lists with nesting, horizontal rules, GFM tables, and inline
strong/emphasis/strike/code/links. Code spans win over every other inline rule
and their contents are never re-scanned, so a documented shell command survives
being documented.

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

| Refusal             | When                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `unsupported-media` | Not one of the raster extensions above (this is where SVG lands).                                                |
| `too-large`         | Over `PANE_WIDGET_IMAGE_MAX_BYTES` — the marker's ceiling, less the two encoding steps. Roughly 50 KB of source. |
| `empty`             | A zero-byte file, or empty stdin.                                                                                |
| `unknown-widget`    | A widget id this build does not have.                                                                            |

The ceiling exists because the marker has to survive a mirror **re-seed**, and
the daemon reseeds with `capture-pane -S -2000`: anything scrolled past 2000
rows is gone after a re-lease. Serving image bytes over a daemon route — which
lifts the ceiling entirely and is the right long-term shape — is a follow-up
card, blocked only on contract work another branch owns.

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
