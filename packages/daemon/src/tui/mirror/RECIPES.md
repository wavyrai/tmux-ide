# Visual recipe layer

This directory keeps visual recipes app-owned. The recipe layer consumes
`SemanticThemeSnapshot` tokens from `theme.ts`; it does not define a second
palette or own global input.

## Anatomy

- `recipes.ts` is pure state, geometry, text, scrollbar, gallery, and hit-test
  logic. It is safe to unit-test without OpenTUI rendering.
- `recipes.tsx` is presentational Solid/OpenTUI composition over ordinary
  `<box>`, `<text>`, and recipe props.
- `recipes-gallery.tsx` is a deterministic renderer harness for dark/light
  snapshots and interaction coverage.

## State precedence

Recipe visual state resolves in this order:

`disabled > pressed > selected > focused > attention > hovered > loading > empty > status > base`

The order is encoded in `RECIPE_STATE_PRECEDENCE` and enforced by
`resolveRecipeState()`. Status color is semantic state; focus and selection are
navigation state and must remain visually distinct through the theme layer.

## Interaction ownership

tmux-ide keeps one root keyboard owner and one central pointer router. Recipes
are presentational: they can display selected/focused/hovered/pressed state, but
they do not install global `useKeyboard` handlers or route pane/editor/dialog
events. The gallery uses a root container and pure hit testing to exercise the
same architecture without implying that recipes own app behavior.

## TUIparts spike decisions

- Button: pattern only for this card. TUIparts Button packages useful press
  behavior, but tmux-ide already routes activation centrally. Adopting it now
  would add a second behavior owner before surfaces are migrated.
- Tabs: pattern only. TUIparts Tabs owns roving focus and selection; tmux-ide
  hosted/composite views already have an authoritative model and hit-test path.
- Input: pattern only. tmux-ide editor/search/prompt text is already routed
  through app-owned buffers and dialog stack. Native OpenTUI Input remains useful
  later for isolated prompts, but this card provides an `InputShell` recipe.
- Dialog: defer. TUIparts Dialog is provider/root-keyboard/portal behavior; it
  conflicts with the current one global dialog stack and overlay geometry unless
  a later card deliberately replaces that stack.
- Badge: adopt as an app-owned recipe shape. It has no reusable behavior, so a
  local `Badge`/`StatusChip` is the correct layer.

No `@tuiparts/solid` dependency is added. The small reusable ideas are the
primitive-versus-recipe boundary and state render callback shape, not runtime
code.

## Card 03 migration path

Migrate shell surfaces one strip at a time: tab bar chips, dialog rows, palette
rows, Files/Diff rows, and Missions chrome. Each migration should preserve the
existing pure geometry first, then replace repeated JSX with recipes that
consume those geometry projections.
