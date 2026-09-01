# OpenTUI design-system proof matrix

This matrix is the release evidence for the shared OpenTUI component system.
Each scenario is rendered in both `dark` and `light` from a fresh semantic
theme publication. Terminal cells remain opaque fixture content: assertions
for app chrome must never recolor or otherwise interpret the fixture.

## Golden viewports

| Viewport | Layout contract | Required proof                                                                                                   |
| -------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `80x24`  | compact         | no clipped essential action, no overlay outside viewport, contextual footer collapses to location + primary hint |
| `120x40` | standard        | sidebar and contextual footer fit, palette/menu/dialog retain complete actionable labels                         |
| `200x60` | wide            | full Home brand, complete location/activity/action groups, full window and pane labels                           |

## Appearance matrix

For every viewport, capture these six fixtures in both appearances:

1. Home with no sessions: full-canvas Home, disabled Terminals navigation,
   `New session` and `Commands` actions, and no sidebar.
2. Home with sessions and agent attention: session count, working/attention
   summary, actionable navigation, and warning tone retained through focus.
3. Populated Terminals: session/agent sidebar, window tab bar, selected and
   terminal-focused pane title states, opaque ANSI terminal body, and contextual
   status bar.
4. Command palette: selected, disabled, and armed destructive command rows,
   bounded frame, topmost input, and exact focus return after dismiss.
5. Pane menu and rename dialog: pointer row activation, outside-click/Escape
   policy, input draft, validation, save/cancel, and exact pane focus return.
6. Transient result: success/warning notice coexists with the current route,
   does not capture input, and expires once after the bounded one-second
   lifecycle.

That produces `3 viewports × 2 appearances × 6 fixtures = 36` deterministic
renderer proofs.

## Current migration audit

The production graph guard is green, so the remaining work is component
composition rather than raw-color or framebuffer leakage:

| Surface                         | Current owner                                                          | Shared-system status                     | Remaining escape hatch                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Home                            | `runtime/application-shell-home.tsx`                                   | semantic theme + shared `Button` actions | content still uses native leaf boxes/text; keep these as non-interactive typography only |
| catalog session sidebar         | `runtime/application-shell-catalog.tsx`                                | migrated                                 | shared `Surface` + `NavigationRow`; catalog owner retains arrow/Enter selection          |
| connected session/agent sidebar | `runtime/application-shell-sidebar.tsx`                                | migrated                                 | shared semantic rows emit typed `session.open`/`agent.open` intents with input source    |
| primary app bar                 | `shell-chrome-view.tsx#ShellTabBar`                                    | migrated                                 | shared header `Surface`, `Tabs`, and semantic `Badge` projections                        |
| fallback mini sidebar           | `shell-chrome-view.tsx#ShellMiniSidebar`                               | migrated                                 | shared `Surface`, `NavigationRow`, and `KeyHint`; compatibility data only                |
| window tabs                     | `workspace/terminal-window-strip.tsx#WindowTabBar`                     | migrated                                 | shared `Surface`, button, badge, and state palette                                       |
| pane title/actions              | `workspace/terminal-pane-header.tsx`, `workspace/pane-action-menu.tsx` | migrated                                 | shared badge/button/menu; terminal body remains intentionally opaque                     |
| contextual footer               | `shell-chrome-view.tsx#ContextStatusBar`                               | migrated                                 | shared status groups, segments, and key hints                                            |
| palette/menu/dialog/toast       | `runtime/application-shell-overlays.tsx`, `ui/overlay-host.tsx`        | migrated                                 | one overlay stack/frame/list-row contract; command ownership stays in the root           |

Native `<box>` and `<text>` are valid leaves inside a component. They are not
an escape hatch when the component receives only semantic roles and emits a
typed intent. The audit treats duplicated interaction state, direct theme
construction, raw colors, or terminal ownership as the architectural failure.

## Interaction parity

Each actionable fixture records the same semantic intent from keyboard and
pointer paths:

| Surface                | Keyboard proof                  | Pointer proof                            |
| ---------------------- | ------------------------------- | ---------------------------------------- |
| primary navigation     | `F1`, `F2`                      | exact Home/Terminals hit region          |
| session and agent rows | arrows + `Enter`                | exact session/agent row                  |
| window tabs            | window navigation key + `Enter` | exact tab and add-window control         |
| pane title/actions     | pane navigation + menu key      | exact title, menu, and menu row          |
| status bar             | `F5`, `N` when offered          | exact contextual action                  |
| overlays               | arrows, `Enter`, `Esc`          | exact row, outside dismiss where allowed |

Renderer assertions must compare semantic roles and cell geometry rather than
hard-coded RGB values. A theme switch assertion renders both modes through the
same mounted component tree and verifies that every app-owned cell changes to
the new semantic snapshot while the terminal-body fixture remains unchanged.

## Release commands

```bash
pnpm exec vitest run packages/daemon/src/tui/mirror/runtime/production-design-system-contract.test.ts packages/daemon/src/tui/mirror/runtime/production-data-path.test.ts packages/daemon/src/tui/mirror/ui/component-chrome-contract.test.ts
pnpm test:tui-renderer
pnpm --filter @tmux-ide/daemon typecheck
```
