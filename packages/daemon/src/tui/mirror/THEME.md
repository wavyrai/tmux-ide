# Semantic theme foundation

`theme.ts` is the app-owned semantic token boundary. It deliberately stays
small: OpenTUI receives concrete `RGBA` values, but app code should name the
role it needs instead of hard-coding surface colors.

## Token roles

- `colors.accent` is the user-selected brand/action color. It is preserved
  exactly, so a saved accent may equal a status color.
- `colors.focus` and `colors.focusBorder` are focus tokens. They default from
  accent when safe, but fall back to the base focus family when the selected
  accent collides with any resolved status color. Keyboard focus must not look
  like blocked, working, done, idle, or unknown state.
- `colors.status.*` are state tokens. They must remain visually distinct from
  focus so blocked, working, done, idle, and unknown states are never confused
  with navigation focus. They are not guaranteed to be distinct from raw user
  accent because old saved accents remain valid.
- `density`, `borders`, and `glyphs` are structural tokens. They describe the
  app's default spacing, border style, and common terminal symbols; they are not
  per-surface layout decisions.

## State precedence

Theme state resolves in this order:

1. The persisted app config supplies the selected mode (`dark`, `light`, or
   `system`) and custom token overrides such as `theme.accent`.
2. Explicit `dark`/`light` modes choose that palette directly.
3. `system` follows the renderer `theme_mode` subscription; if the renderer
   has not reported a mode yet, the dark palette is used as the stable fallback.
4. Custom accent, foreground, muted, status, and glyph overrides are applied
   after palette selection. Existing saved custom accents remain valid.

Snapshots are stable immutable containers. The TypeScript contract exposes
readonly token fields and runtime freezes the containers. `RGBA` itself exposes
mutable channel setters backed by native storage, so snapshots provide readonly
RGBA references by contract; consumers must treat them as immutable and never
mutate color instances in place. Consumers subscribe once, compare snapshot
identity, and avoid allocating reactive theme objects during render.

## Primitive versus recipe boundary

This module is a primitive-style foundation: it defines semantic tokens, mode
resolution, and subscriptions. Recipes such as Missions lanes, settings rows,
dialogs, or terminal chrome decide how those tokens are mapped to their own
layout and interaction states. tmux-ide does not depend on TUIparts at runtime;
the reference informed the shape, but the visual layer remains app-owned.
