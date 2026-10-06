# The rendered app demos

The landing page's Fig. 01 (`docs/public/tui-demo.svg`, and `tui-demo-light.svg`, the same
frames in the app's default Light theme, shown when the site is light), the nine mini-figures
(Fig. 02.1–04.3, `docs/public/tui-figures.svg`) and the README demo are
rendered from the production `tmux-ide app` shell. They are not screenshots
and not drawings.

```bash
pnpm demo:tui            # re-render everything (needs bun); ~3 s
pnpm demo:tui --text     # also print Fig. 01's frames as plain text
pnpm demo:font           # rebuild the embedded glyph subset (needs uv)
```

## How it works

- `docs/scripts/tui-demo-scene.tsx` mounts `ApplicationShellView`, the same
  composition `application-root-v2.tsx` mounts. It is fed the models the app
  builds (machine sidebar, Home fleet projection, palette commands, a tmux
  layout with window links) and rendered headlessly with OpenTUI's test
  renderer. Only the terminal contents are fixture text, coloured through the
  theme's own terminal palette.
- `tui-demo-fixture.ts` holds the fixture fleet. The data is invented and
  contains no real hosts, users or paths. `tui-demo-figures.ts` defines each
  mini-figure as a before/after pair of app frames, a crop and a cursor
  choreography.
- `tui-demo-svg.ts` writes the cell grids as SVG at Geist Mono's true cell
  (8.4 × 18.2 px at 14 px). Fig. 01 embeds the glyph subset, because an SVG
  loaded as an `<img>` cannot use page fonts, and it replays the app's working
  spinner. A frame that differs only by a modal (the palette) is stored as the
  app's scrim plus the changed cells.
- `tui-demo-figure-markup.ts` renders every figure in the dark and the light
  theme. Each colour pair becomes a custom property, set for the light site
  and again under `.dark` in the generated `tui-mini-figure-frames.css`, so
  the figures follow the site theme. All figures go into one cached sprite that
  `components/marketing/tui-mini-figure.tsx` references with `<use>`. Each
  figure also says how the reader's "You" cursor performs its action
  (`from` → `at` → `to`); `components/marketing/tui-cursor.tsx` draws that as
  a CSS-only cursor (the icon sprite's `#cursor-arrow` plus a name pill) on the
  figure's slot of the page's motion queue, and the same component overlays
  Fig. 01 with one cursor on its 12 s loop. Agents act in their panes, so they
  have no cursor.
- `tui-demo-font/` builds the Geist Mono subset (SIL OFL 1.1). The build also
  draws the few glyphs Geist lacks (spinner braille, `⎿ ✻ ✶ ⋯ ▾ ✓`) on Geist's
  own metrics. If a frame draws a character outside `chars.txt`, the render
  fails and says so. Add the character, run `pnpm demo:font`, then
  `pnpm demo:tui`.

## Size budget

`check:performance` caps each of `tui-demo.svg` and `tui-demo-light.svg` at 18 KB gzip (a page
view fetches only the one matching the site theme). When the cap was set,
the three frames measured about 5.7 KB and each embedded glyph subset (regular
and bold) about 5.4 KB, for 15.7 KB in total. Real bold is kept because the
app draws headings, tabs and tool calls in bold. The SVG is an `<img>` that
does not block first paint. The landing figures share one sprite
(`tui-figures.svg`, about 3.8 KB gzip) and two font files, so they add almost
nothing to the homepage HTML.

## Staying current

`pnpm demo:tui` records a hash of every presentation file it imports (the
app's UI layer and visual tokens) in `docs/scripts/tui-demo.sources.json`.
`check:site` → `check:tui-demo` fails when any of them changed since the last
render, names the changed files, and also verifies the sprite and cursor set.
After a TUI change, run `pnpm demo:tui`, review the result, and commit the
regenerated files with the change.
