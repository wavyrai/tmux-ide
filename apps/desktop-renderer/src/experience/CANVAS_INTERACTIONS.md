# Native canvas interactions

The desktop canvas is implemented directly in Solid. `AppWindowDocumentV1`
remains the authority for window identity, focus order, and durable geometry;
tmux only supplies terminal bytes. The viewport transform is deliberately a
renderer-local value in this phase because the current AppWindow contract has
no versioned viewport field. Persisting it requires a future contract revision
and migration rather than browser storage or an unversioned side channel.

Ordinary terminal pointer and wheel input always stays terminal-owned. Holding
Space enables panning from the blank canvas, window chrome, or non-input window
content, but deliberately does not override a terminal surface or an
interactive header control.

Pane chrome exposes dock/float and floating maximize/restore only when the host
provides a durable AppWindow mutation callback. Close stays explicitly disabled
because the AppWindow command contract has no close operation. Persisting the
viewport requires one reviewed change spanning an AppWindow V2 migration, a
viewport command, and the daemon/Electron host mutation bridge; it must not be
approximated with renderer storage.

Interaction behavior was informed by the MIT-licensed Solid Flow and XYFlow
projects, especially their separation of viewport state from node state. No
Solid Flow or XYFlow source code, runtime, or package is included here.

## Grid overlay invariants

These two are measured, not stylistic. Both were violated in the reference
implementations this app's interaction model was studied against, and both are
cheap to violate here because the mirror renderer letterboxes.

**1. Position by cell, not by flow.** Everything painted over a terminal grid —
a hover highlight, a drag ghost, pane chrome anchored to a position, an agent
status glyph, the m49.7 widget surface — is positioned in **scaled grid units
derived from the same fit scale the renderer committed**, never in raw container
pixels and never spliced inline into the row's text.

The mirror renderer scales its grid down to fit its card (`mirrorFitScale`), so
container pixels and grid pixels are the same thing at scale 1 and at no other
scale. An overlay positioned at the card's own inset is therefore correct
exactly until the deck shrinks a node to keep it on screen, and then drifts by a
margin that grows with the scale — which is why the bug reads as "it works on my
machine" rather than as a layout error.

`experience/grid-overlay.ts` is the only correct path: `gridOverlayBox()` for the
letterboxed grid's box inside its container, `gridCellRect()` for a cell
rectangle within it. Both take the scale the renderer applied as an argument
rather than recomputing it — a second derivation is a second chance to disagree
with the pixels on screen. Degenerate measurements fall back to the whole
container, because an overlay covering slightly too much is a cosmetic error and
one collapsed to zero is an invisible feature.

**1b. The fit must CONTAIN the grid, not merely scale it.** The letterbox
transform takes its origin at the emulator element's **top-left** and centres by
an explicit translation (`mirrorFitTransform`). `transform-origin: center center`
looks equivalent and is not: xterm sizes its element by the **grid**, not by the
card, so once the grid outgrows its container the box the origin is taken from is
the overflowing one, and the scaled render is parked around a point outside the
card.

Measured (m50.2): a 157x36 window laid out about 1134x503px inside a 318x176
card and rendered at y=838 for a card at y=657 — off the bottom of a 900px
window. This is not a cosmetic bug. **xterm pauses rendering for an element
outside the viewport**, so the emulator's buffer went on advancing while the DOM
kept its last painted frame: the mirror seeded, painted once, reported a live
stream, and silently stopped following the pane it was mirroring.

The test lesson generalises past the mirror: asserting that a **container** is
visible proves nothing about what it contains. For anything that scales or
transforms its content, assert the containment — the content's box inside the
container's box, and inside the viewport.

**2. Index by cell, not by UTF-16 offset.** Any code that maps a column number
to a character goes through the emulator's cell API (`line.getCell(x).getChars()`
plus `getWidth()`), never through indexing a string built from the row.

One cell can hold a variation selector, a combining mark, a ZWJ sequence or a
skin-tone modifier, and the trailing half of a wide glyph is a **zero-width cell
that repeats the preceding cell's characters**. Code that joins cells into a
string and then indexes by column diverges at the first such cell and stays
diverged for the rest of the line — so a feature works for everyone who tests it
and silently misreads every pane belonging to a user whose output has emoji or
CJK in it.

`terminal/widgets/xterm-cell-rows.ts` is the reader; `WidgetCellRow` in the
contracts package is the shape that carries rows to pure logic, which is why
widget detection can be tested exhaustively without an emulator. Rows the
emulator marked `isWrapped` are rejoined into one logical line before anything
is parsed out of them.
