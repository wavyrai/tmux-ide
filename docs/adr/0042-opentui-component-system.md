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

## Production V2 inventory

The contract starts from the behavior already shipped by the V2 root. Moving
JSX must not remove or silently reassign any of these states or actions.

| Current surface       | State presented                                                       | Actions emitted                                         |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| App bar               | active route, navigation focus, hover, attention, catalog/daemon note | open Home (`F1`), open Terminals (`F2`)                 |
| Session/agent sidebar | active session, connection state, agent activity, attention           | open session, navigate to exact agent pane              |
| Window strip          | active window, agent status, attention, available space               | activate window, create window                          |
| Pane title row        | selected pane, physical terminal focus, agent activity, attention     | select pane, open pane menu                             |
| Context status bar    | route/context, focus owner, transient note, readiness                 | open Commands (`F5`), create first session when offered |
| Command palette       | selection, disabled command, armed close confirmation                 | navigate, jump to agent, create/split/close             |
| Pane menu             | selection, disabled item, armed destructive confirmation              | select text, rename, split right/down, close            |
| Rename dialog         | current draft, validation/readiness, modal focus                      | edit, save with `Enter`, cancel with `Esc`              |

Terminal selection, resize guides, and the terminal framebuffer are not chrome.
They remain terminal-workspace responsibilities and are projected into stable
slots owned by this component tree.

## Target component tree

```text
AppFrame
├─ primary navigation slot
├─ sidebar slot
├─ WindowTabBar
├─ workspace slot
│  └─ PaneFrame[]
│     ├─ PaneTitleBar
│     └─ opaque body slot (terminal framebuffer or another product surface)
├─ ContextStatusBar
└─ OverlayHost
   ├─ command palette
   ├─ pane context menu
   ├─ rename dialog
   └─ transient toast/note
```

`AppFrame` owns composition and cell budgets, not commands. `WindowTabBar`,
`PaneFrame`, `PaneTitleBar`, and `ContextStatusBar` own presentation and direct
pointer hit targets. `OverlayHost` owns stacking, modal pointer capture, and
focus containment. The application root remains the sole command, global
keyboard, lifecycle, and focus-return owner.

## Public component contracts

These are renderer-neutral public props. The OpenTUI host may add native leaf
props internally, but call sites must not receive raw colors, transports, or
framebuffer handles.

### `AppFrame`

```ts
interface AppFrameProps {
  appearance: SemanticThemeSnapshot;
  width: number;
  height: number;
  variant: "compact" | "standard" | "wide";
  activeRoute: "home" | "terminals";
  navigationFocused: boolean;
  sidebar: JSX.Element | null;
  windowTabs: JSX.Element | null;
  statusBar: JSX.Element;
  overlays: JSX.Element;
  children: JSX.Element;
  onRouteIntent(route: "home" | "terminals", source: InputSource): void;
  onCommandsIntent(source: InputSource): void;
}
```

### `WindowTabBar`

```ts
interface WindowTabBarProps {
  appearance: SemanticThemeSnapshot;
  width: number;
  items: readonly WindowTabItem[];
  activeId: string | null;
  hoveredId: string | null;
  focused: boolean;
  addDisabled?: boolean;
  onActivateIntent(id: string): void;
  onAddIntent(): void;
}
```

`WindowTabItem` contains stable semantic identity, display label, optional
status badge, attention, and disabled state. It never contains a tmux client or
the command that activates a window.

### `PaneFrame`

```ts
interface PaneFrameProps {
  appearance: SemanticThemeSnapshot;
  pane: PaneFrameModel;
  rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  selected: boolean;
  terminalFocused: boolean;
  keyboardFocused: boolean;
  attention: boolean;
  actions: readonly PaneActionPresentation[];
  children: JSX.Element;
  onSelectIntent(paneId: string): void;
  onActionIntent(paneId: string, actionId: string): void;
}
```

The body is opaque. `PaneFrame` may position it but may not inspect, recolor,
reseed, or resize terminal cells independently of the application geometry
owner.

### `PaneTitleBar`

```ts
interface PaneTitleBarProps {
  appearance: SemanticThemeSnapshot;
  paneId: string;
  width: number;
  title: string;
  subtitle?: string | null;
  status?: StatusPresentation | null;
  selected: boolean;
  terminalFocused: boolean;
  keyboardFocused: boolean;
  hovered: boolean;
  attention: boolean;
  menuDisabled?: boolean;
  onSelectIntent(): void;
  onMenuIntent(anchor: Readonly<{ x: number; y: number }>): void;
}
```

### `ContextStatusBar`

```ts
interface ContextStatusBarProps {
  appearance: SemanticThemeSnapshot;
  width: number;
  context: readonly StatusSegmentPresentation[];
  message: StatusMessagePresentation | null;
  actions: readonly StatusActionPresentation[];
  focusedActionId: string | null;
  onActionIntent(id: string): void;
}
```

Only changing context, readiness, focus, agent attention, and transient results
belong here. Generic instructional prose does not. Stable actions are real,
mouse-addressable controls rather than fragments appended to a sentence.

### `OverlayHost`

```ts
interface OverlayHostProps {
  appearance: SemanticThemeSnapshot;
  viewport: Readonly<{ width: number; height: number }>;
  overlay: OverlayPresentation | null;
  returnFocus: SemanticFocusTarget | null;
  onActivateIntent(id: string): void;
  onDismissIntent(reason: "escape" | "outside" | "complete"): void;
  onDraftIntent?(value: string): void;
}
```

`OverlayPresentation` is a discriminated union for palette, menu, rename, and
toast models. Only one modal palette/menu/dialog is active. Toasts may coexist,
but never capture keyboard focus.

## State and tone contract

Interaction state and semantic tone are separate axes. The resolved interaction
priority is:

```text
disabled > pressed > selected > focused > attention > hovered > base
```

Loading and empty are content states and are resolved before base only when no
stronger interaction is active. The required presentation is:

| State       | Surface                 | Text/accent              | Border/marker         | Behavior                               |
| ----------- | ----------------------- | ------------------------ | --------------------- | -------------------------------------- |
| Normal      | panel/header role       | primary or secondary     | subtle/inactive       | available action                       |
| Hovered     | hover selection role    | primary/link             | default/`·`           | pointer preview only                   |
| Focused     | raised surface          | primary                  | focused/`›`           | keyboard target                        |
| Selected    | selection role          | selection text           | selected/active glyph | current route/window/pane              |
| Disabled    | disabled selection role | muted                    | subtle/`×`            | no pointer or keyboard activation      |
| Attention   | attention surface       | primary + warning accent | attention/`!`         | preserves alert while navigable        |
| Warning     | existing surface        | warning tone             | warning               | caution; not destructive by itself     |
| Destructive | danger/attention recipe | high-contrast warning    | attention/`!`         | first activation arms, second confirms |

Selected, focused, or hovered attention items keep a warning marker or border;
navigation state must not erase semantic urgency. Destructive confirmation is
explicit state owned by the command model, never inferred by the primitive.

## Focus and intent ownership

- The application root owns `F1`, `F2`, `F5`, global `Esc`, paste, shutdown,
  and focus return.
- Components own their direct left-click hit targets and emit semantic intents.
  They do not invoke tmux or the daemon.
- Right-clicking a pane body or title emits one menu intent anchored to that
  pane's durable semantic identity.
- A modal overlay captures pointer and keyboard ingress. `Esc` dismisses it;
  completion restores the exact still-live focus target captured on open.
- The rename dialog owns text editing presentation. The root owns submission,
  validation, cancellation, and the rename command.
- Physical terminal focus and selected-pane navigation remain distinct inputs;
  neither component derives one from the other.

## Responsive and geometry contract

Breakpoints remain those already used by `shellChromeLayout`:

| Fixture  | Variant  | Sidebar | Main | App bar | Status | Window strip | Full-height pane frame | Terminal body after pane title |
| -------- | -------- | ------: | ---: | ------: | -----: | -----------: | ---------------------: | -----------------------------: |
| `200x60` | wide     |      28 |  172 |       1 |      1 |            1 |                     57 |                             56 |
| `120x40` | standard |      28 |   92 |       1 |      1 |            1 |                     37 |                             36 |
| `80x24`  | compact  |      20 |   60 |       1 |      1 |            1 |                     21 |                             20 |

The app bar, status bar, window strip, and pane title are each exactly one row.
No compound may add padding, a border row, or a second hint row around terminal
content without changing this table and the executable geometry contract.

Responsive priority is deterministic:

| Component        | Wide `200x60`                                  | Standard `120x40`                       | Compact `80x24`                                                            |
| ---------------- | ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| AppFrame         | wordmark, shortcuts, labels, contextual status | wordmark, labels, compact context       | icon-first routes; omit optional context before actions                    |
| WindowTabBar     | equal tabs, full status, `+ New window`        | equal tabs, clipped labels, compact add | active/adjacent identity first, `+` add, preserve attention marker         |
| PaneTitleBar     | title, subtitle, status, actions               | title, status, overflow menu            | focus marker, clipped title, overflow menu; status before optional actions |
| ContextStatusBar | context, dynamic message, actions              | clipped context/message, actions        | active context and highest-priority available action                       |
| OverlayHost      | preferred width up to 72                       | preferred width up to 60                | viewport inset 1; scroll items instead of exceeding height                 |

At every size, stable identity, focus, attention, destructive confirmation, and
the Commands entry remain visible before descriptive copy.

## One appearance authority

ADR/card 274 is incorporated as a hard boundary:

```text
built-in appearance
  -> terminal host defaults (system mode only)
  -> user theme
  -> project theme
  -> accessibility transforms
  -> explicit legacy overrides
  -> one immutable SemanticThemeSnapshot
  -> all app-owned chrome
```

Presentation components receive that snapshot and consume semantic roles. They
must not import renderer palette APIs, construct a theme, read raw host colors,
or embed named/hex/ANSI colors. Explicit `dark` and `light` bypass host mode;
`system` follows the last valid host palette published by the appearance owner.

Terminal content is a separate projection. Only default foreground/background
may follow appearance. Explicit ANSI, indexed-256, and truecolor cells are
identity-preserving and cannot be recolored by `AppFrame`, `PaneFrame`, or an
overlay.

## Import boundary

Presentational primitives and compounds may import:

- renderer-neutral contracts and semantic presentation models;
- `SemanticThemeSnapshot` as their single appearance input;
- shared geometry, clipping, icon, and state-recipe helpers;
- Solid/OpenTUI leaf types and primitives in the OpenTUI host only.

They may not import:

- the renderer or terminal-palette lifecycle owner;
- daemon transports, workspace clients, control clients, or tmux adapters;
- pane streams, terminal parsers, framebuffer owners, or pane surfaces;
- raw theme construction/resolution functions or hard-coded colors;
- filesystem, process, server, Electron, or web runtime modules.

The command owner maps emitted semantic intents to tmux/daemon operations. The
terminal workspace mounts the framebuffer into the opaque pane body. Neither
dependency points back into the component system.

## Explicit non-goals

This contract does not move production JSX. Electron, web, daemon protocols,
terminal streaming/parsing, palette lifecycle implementation, and tmux command
behavior are unchanged. Those changes belong to their dependent implementation
cards and must conform to this boundary.

## Consequences

Window and pane chrome can evolve without touching tmux authority, terminal
streaming, resize transactions, or color decoding. Pointer hit targets and
visual states are testable in isolation. Web or native hosts can later consume
the same semantic component models without becoming runtime authorities.
