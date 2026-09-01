# ADR 0042: OpenTUI component system

## Status

Accepted for the tmux-ide 2.9 release.

## Context

The production OpenTUI shell grew directly around tmux projection and terminal
framebuffer concerns. That kept the runtime honest, but it also left window
tabs, pane headers, status bars, and dialogs as local text fragments. Visual
changes therefore tended to duplicate state styling and pointer behavior.

Gloomberb demonstrates the useful layering for a terminal application:
reusable `ui/*` primitives, compound `layout/pane/*` components, and a thin app
shell. OpenCode demonstrates the complementary rule that overlays and footer
composition should have one owner instead of being recreated by each route.

## Decision

The OpenTUI application uses four layers:

```text
ui/* primitives
  Button · Badge · Tabs · StatusBar · Dialog
                         ↓
workspace compounds
  TerminalWindowStrip · PaneFrame · pane action menu
                         ↓
application shell
  navigation · sidebar · terminal workspace · overlay host
                         ↓
runtime authorities
  tmux topology · daemon semantic projection · terminal framebuffer
```

The component API follows the same principles as a shadcn-style library:

- one component family per file with named exports;
- semantic variants instead of call-site color choices;
- interaction ownership lives in the interactive component;
- domain compounds compose primitives rather than restyling raw `<text>` nodes;
- the barrel file is the stable import surface;
- renderer tests are the component examples and visual contract;
- the terminal framebuffer is an opaque pane body and is never repainted by
  chrome components.

Existing `recipe-components.tsx` remains a compatibility facade while callers
move to `ui/*`. It must not gain new component families.

## Consequences

Window and pane chrome can evolve without touching tmux authority, terminal
streaming, resize transactions, or color decoding. Pointer hit targets and
visual states are testable in isolation. Web or native hosts can later consume
the same semantic component models without becoming runtime authorities.
