# Responsive shell chrome

The shell chrome boundary is split from app behavior:

- `shell-chrome.ts` owns responsive geometry, tab labels/spans, overlay widths,
  status/help text, and visual state precedence.
- `shell-chrome.tsx` renders presentational Solid/OpenTUI pieces over the app's
  existing root router. It does not install keyboard handlers in production.
- `app.tsx` keeps the authoritative input owner, pointer routing, tmux pane
  forwarding, lifecycle, and PaneSurface framebuffer path.

## Responsive rules

- `wide` starts at `160x45` and is verified at `200x60`.
- `standard` starts at `96x30` and is verified at `120x40`.
- `compact` covers smaller terminals and is verified at `80x24`.

The sidebar stores a user-preferred width, but the rendered width is projected
per terminal size. Compact mode caps the sidebar at 20 cells so the main surface
keeps usable width; the preferred width is not overwritten by compact rendering.

Palette and dialog widths are projected from the same shell layout. Their render
placement and hit-test geometry consume the same values.

## Visual semantics

Navigation state and semantic state remain distinct:

- active view: selection background;
- keyboard focus: focus border/attributes;
- pointer hover: hover background;
- workspace context: accent foreground over raised surface, not alert styling;
- agent attention: attention background and blocked-status border when otherwise
  neutral; when combined with selection/hover/focus it keeps a distinct alert
  marker/border so navigation state does not erase the semantic cue;
- terminal focus: dedicated focus fill/marker.

This mirrors the recipe layer: visual recipes can show state, but behavior stays
with the central app router.
