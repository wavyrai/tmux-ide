# Card 22 — Cohesive product visual-language benchmark

Status: normative implementation and acceptance benchmark

Date: 2026-07-21

Scope: OpenTUI application, Solid/Electron desktop application, and the shared
Solid presentation boundary. This card changes no production code.

## Pinned evidence

The measurements in this document are pinned so later work can distinguish a
deliberate product decision from source drift.

| Input | Revision | What was inspected |
| --- | --- | --- |
| tmux-ide OpenTUI baseline | 6932d541 | Semantic theme, application shell, pane frame, terminal chrome, bottom dock, command palette, fixed-size renderer tests |
| tmux-ide shared Solid dock delivery branch | fa85a405 | Shared presenter, OpenTUI leaves, DOM leaves, web-host CSS, package boundary |
| tmux-ide Solid/Electron delivery branch | f8dc911f | Desktop app shell, host capabilities, titlebar, window controls, responsive CSS, reduced motion |
| local Gloomberb reference | 1a44ddf | React host adapter, cell rhythm, pane chrome, tabs, command bar, themes, native window controls, scrollbars |
| OpenTUI platform reference | local opentui skill, read 2026-07-21 | Integer-cell layout, Solid renderer behavior, keyboard/focus layering, animation constraints, deterministic rendering and span capture |

Primary evidence locations:

- Gloomberb: src/renderers/electrobun/view/input-host.tsx:23-24,
  src/renderers/electrobun/view/host/style.ts,
  src/renderers/electrobun/view/styles.css,
  src/components/layout/pane/header.tsx,
  src/components/layout/pane/footer/index.tsx,
  src/components/layout/pane/sizing.ts,
  src/renderers/electrobun/view/host/tabs.tsx,
  src/components/command-bar/panel/layout.ts,
  src/theme/themes.ts, and src/theme/colors.ts.
- tmux-ide OpenTUI: packages/daemon/src/tui/mirror/theme.ts,
  packages/daemon/src/tui/mirror/shell-chrome.ts,
  packages/daemon/src/tui/mirror/workspace/application-shell.ts,
  packages/daemon/src/tui/mirror/workspace/pane-frame.ts,
  packages/daemon/src/tui/mirror/workspace/workbench-shell.ts, and
  packages/daemon/src/tui/mirror/workspace/command-palette-surface.ts.
- Shared Solid dock delivery branch:
  packages/daemon/src/ui/workbench-dock/presenter.tsx,
  packages/daemon/src/ui/workbench-dock/web-host.tsx, and
  packages/daemon/src/ui/workbench-dock/web-host.css.
- Electron delivery branch: apps/desktop-renderer/src/App.tsx and
  apps/desktop-renderer/src/styles.css.

## Decision

tmux-ide should use a cell-first, host-refined visual system.

The product shares semantic state, token names, component order, keyboard
meaning, labels, and responsive intent. OpenTUI renders those decisions in
integer character cells. The desktop host maps the base rhythm to pixels and
adds native precision for hit targets, shadows, radii, scrollbars, drag regions,
and window controls.

The desktop application must feel like the same terminal-native product, not a
generic web dashboard wrapped around terminals. That does not mean painting a
terminal screenshot in HTML. It means preserving the same information density,
one-row chrome, mono typography, focus hierarchy, state colors, command
vocabulary, and bottom-dock behavior while using real DOM controls.

The tmux panes remain the agent terminal substrate. Files, Changes, Missions,
Activity, onboarding, and the command palette are native OpenTUI or DOM
surfaces outside those tmux framebuffers.

## What Gloomberb proves, and the tmux-ide response

| Mechanic | Code-backed Gloomberb behavior | Current tmux-ide state at pinned revisions | Card 22 requirement |
| --- | --- | --- | --- |
| Cell rhythm | Web host defines an 8 by 18 px cell, reports viewport dimensions in cells, and translates numeric host layout values to pixels. | OpenTUI is naturally cell based. The Electron shell uses a loose sans dashboard scale. | Use 8 by 18 px as the desktop workspace rhythm and 1 by 1 terminal cells in OpenTUI. |
| Typography | 12 px mono type on an 18 px line, anti-aliased with geometric precision. Status and pane footers use 11.5 px. | OpenTUI inherits terminal mono. Electron starts with Inter and large marketing typography. | Workspace UI is mono 12/18. Onboarding can reach 20/24, but cannot introduce a separate marketing visual language. |
| Pane chrome | Header and footer are exactly one row. Focused terminal panes integrate borders into chrome; native panes use a stable one-pixel frame. | PaneFrame has a one-row header and rich state, but its border is painted by multiple absolute boxes and its density thresholds are global-size-like. | One stable owner paints header, border, footer, hit zones, and focus. Framebuffer content is clipped to body only. |
| Focus hierarchy | Focus, terminal focus, window-edit selection, floating state, and attention are separate signals. Native selected windows get a stronger ring and halo. | The OpenTUI model already keeps these states orthogonal. Focus rails and pane borders can duplicate the signal. | Keep orthogonal state, define precedence, and never encode agent status as focus color. |
| Tabs and dock | Underline tabs are 28 px, compact tabs are 18 px, active weight is stronger, overflow scrolls, and active tabs scroll into view. | OpenTUI bottom dock is one row and functional. DOM dock is 32 px with hard-coded colors and consumes terminal x/width fields. | One semantic dock model, host-owned geometry, 28 px desktop strip, one-row TUI strip, stable tab order and selected/hover distinction. |
| Command palette | Width is derived from viewport cells and capped. Rows retain stable label and trailing columns. Keyboard selection clears pointer hover. | OpenTUI palette is feature-rich but substantially wider: 64/82/96 cells at the reference sizes. Electron only says that the palette is coming next. | Adopt the exact geometry in this benchmark and render the same command descriptors in both hosts. |
| Window controls | 28 px titlebar overlay, three 28 px controls, 10 px icons, 90 ms color response, platform-specific native window style. | Electron uses a 42 px titlebar and 46 px controls. Host capabilities are secure and useful. | Preserve the secure host boundary, replace the dimensions and visual treatment with the shared dense chrome. |
| Hover and press | Hover is subtle and selected state remains authoritative. Rows, tabs, and actions use small host-native feedback. | Recipe state coverage is strong in OpenTUI. DOM dock and Electron use independent values. | Share precedence and semantic variables; keep host-specific rendering and timing. |
| Responsive behavior | Most geometry is continuous cell math rather than a collection of unrelated breakpoints. | OpenTUI has exact compact/standard/wide projections. Electron has one 980 px breakpoint. | Use the width and terminal matrices below. No surface may invent another unreviewed density breakpoint. |
| Testing | Geometry and palettes are pure enough to test separately from hosts. | OpenTUI already uses 80x24, 120x40, and 200x60 char frames and span capture. Desktop lacks visual parity fixtures. | Make the 18 base host/theme/size combinations mandatory and add state sheets for chrome and palette. |

Gloomberb is a behavior and mechanics reference, not a brand palette to copy.
tmux-ide keeps the blue identity already established by its canonical OpenTUI
semantic theme.

## Parity boundary

Full parity means parity of product-quality mechanics, not identical product
content or a line-for-line port.

### Parity-critical behavior

These items are release blocking:

| Area | Parity-critical behavior |
| --- | --- |
| Visual rhythm | Cell-derived desktop spacing, mono density, one-row chrome, stable label/trailing columns, and no generic dashboard scale |
| Desktop shell | Compact native titlebar, coherent app tabs, platform-aware window controls, drag/no-drag regions, and real hover/close behavior |
| Pane system | Per-pane header, grip, title, subtitle, status, actions, focus, attention, maximize/restore, floating treatment, resizing, and overflow degradation |
| Focus | One visually unambiguous input location, atomic border paint, no layout shift, no flicker, and separate attention/status signals |
| Bottom dock | Persistent tabbed tool surface, collapse/open/maximize, horizontal overflow, active-tab visibility, keyboard navigation, and native Files/Changes/Missions/Activity content |
| Command palette | Centered capped geometry, stable columns, ranked groups, complete loading/empty/error/disabled states, keyboard/pointer agreement, and desktop overlay treatment |
| Responsive behavior | Continuous cell-based density with explicit compact/standard/wide outcomes and no lost function at narrow widths |
| Theme behavior | One semantic source for dark, light, and high contrast; compliant contrast; focused/selected/hovered/pressed/disabled states |
| Terminal feel | Framebuffer clipped inside native pane chrome, correct cursor/input ownership, scroll behavior, and Ctrl-C passthrough |
| Fit and finish | Coherent icons, subtle scrollbars, restrained motion, reduced-motion support, deterministic visual tests, and no temporary foundation UI in production |

### Deliberate tmux-ide product differences

These are not parity failures:

| tmux-ide decision | Why it differs deliberately |
| --- | --- |
| Solid shared UI instead of React | Solid is the selected cross-surface product stack; renderer choice is not a visible parity requirement. |
| Electron host instead of Electrobun | Secure host capability boundaries and platform behavior matter; the packaging runtime does not need to match. |
| Canonical tmux-ide blue palette | Gloomberb supplies mechanics and contrast discipline, not tmux-ide branding. |
| tmux as agent-terminal truth | Agent processes, PTYs, resizing, and terminal bytes remain tmux-owned. |
| Native Files, Changes, Missions, Activity, onboarding, and palette | tmux panes are reserved for agents and shells; application tools are first-class OpenTUI/DOM surfaces. |
| Mission-first information architecture | Projects, harness-neutral agents, mission history, and activity are tmux-ide concepts rather than Gloomberb plugins. |
| Ctrl-Q quit/detach and Ctrl-C terminal passthrough | tmux-ide protects standard terminal interrupt behavior. |
| Zero-config project discovery | Users should not need to author ide.yml or workspace.yml before seeing a useful application. |
| Smaller initial theme catalog | Three complete modes are preferable to many partially integrated themes; more themes can be layered on the same semantic contract later. |
| Product-specific labels and icons | Semantic meaning and metric coherence must match; Gloomberb names, marks, and copy must not be cloned. |

Any claimed deliberate difference not listed here requires a benchmark update
and review. “The host made it easier” is not sufficient justification.

## Normative token contract

All values in this section are exact. A host may only deviate where the table
explicitly permits it.

### Rhythm and typography

| Token | Desktop Solid/Electron | OpenTUI |
| --- | ---: | ---: |
| workspace-cell-width | 8 px | 1 column |
| workspace-cell-height | 18 px | 1 row |
| workspace-font-family | ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace | terminal mono |
| workspace-font-size | 12 px | terminal setting |
| workspace-line-height | 18 px | 1 row |
| chrome-font-size | 12 px | terminal setting |
| status-font-size | 11.5 px | terminal setting |
| onboarding-title | 20 px / 24 px, weight 700 | weight/bold attribute, at most two rows |
| title weight, active | 700 | bold attribute |
| title weight, inactive | 600 | normal unless contrast requires bold |
| body weight | 400 | normal |
| primary horizontal inset | 8 px | 1 column |
| compact gap | 4 px | 0 columns |
| regular inline gap | 8 px | 1 column |
| regular vertical gap | 18 px | 1 row |

Desktop text uses antialiasing and geometric precision. Workspace surfaces do
not use oversized headings, wide card padding, decorative radial gradients, or
proportional-font navigation. Selectable terminal output remains selectable;
chrome remains non-selectable.

### Chrome geometry

| Token | Desktop Solid/Electron | OpenTUI |
| --- | ---: | ---: |
| native titlebar overlay | 28 px | not applicable |
| window control | 28 by 28 px | host terminal owns OS controls |
| window-control icon | 10 by 10 px, 1.5 px stroke | not applicable |
| app tab strip | 28 px | 1 row |
| pane header | 18 px | 1 row |
| pane footer when visible | 18 px | 1 reserved row |
| bottom dock tab strip | 28 px | 1 row |
| global status strip | 18 px | 1 row |
| docked pane border | 1 px | 1 cell line glyph |
| floating pane border | 1 px | 1 cell line glyph |
| window-edit selected border | 3 px inset plus 6 px at 22% focus halo | strong/double line glyph without changing rect |
| divider hit gutter | 8 px with centered 1 px rule | 1 cell separator |
| scrollbar gutter | 8 px | 1 column |
| scrollbar minimum thumb | 24 px | 1 row or column |
| docked radius | 0 px | none |
| floating pane radius | 6 px | rounded line glyphs |
| palette/dialog radius | 8 px | rounded line glyphs |
| compact control radius | 4 px | none |
| tab radius | 5 px underline, 6 px pill | none |
| floating shadow | 0 18px 38px, canvas at 46% | none |
| focused floating shadow | 0 18px 40px, canvas at 50% | none |

Pane action targets inside the 18 px header are 20 by 18 px with a 12 px icon.
Window and standalone controls use 28 by 28 px targets. Desktop dividers use a
transparent 8 px resize target, so visual density does not reduce usability.
In the primary desktop window, the native titlebar overlay and app-tab surface
occupy the same 28 px row; they are not two stacked rows. Detached windows keep
the same 28 px titlebar rhythm.

### Pane density

Pane density is based on the pane's own content budget, never the entire
viewport.

| Pane content width | Chrome variant | Required presentation |
| ---: | --- | --- |
| below 28 cells / 224 px | tiny | grip only when at least two cells fit; one-cell kind glyph; title consumes remaining space; one highest-priority action at most |
| 28-43 cells / 224-351 px | compact | title, status glyph, icon actions; no subtitle or text action labels |
| 44-79 cells / 352-639 px | standard | title, short subtitle when it fits, status text, icon actions |
| 80 cells / 640 px and above | wide | title, subtitle, status text, state chips, icon actions; text action labels only when all title minimums still fit |

The title minimum is 12 cells / 96 px after grip and kind glyph. Actions are
removed from lowest priority first; the title is never covered or pushed under
right-pinned controls. Below 8 by 4 cells, omit the border and preserve body
content, matching the current safe fallback.

### Semantic palettes

These values replace per-surface hard-coded colors. The desktop host receives
them as CSS variables from the same semantic theme snapshot used by OpenTUI.

| Role | Dark | Light | High contrast |
| --- | --- | --- | --- |
| background | #101016 | #f8f8fa | #000000 |
| surface | #16161e | #eef0f6 | #000000 |
| surface-raised | #1e1e28 | #ffffff | #101010 |
| foreground | #d4d4d8 | #1c202a | #ffffff |
| muted-foreground | #6e6e82 | #5c6376 | #d0d0d0 |
| border | #3c3c50 | #bcc4d6 | #a0a0a0 |
| accent | #82aaff | #2d69dc | #8fc3ff |
| accent-muted | #3c425c | #d4e0ff | #17324d |
| focus | #82aaff | #2d69dc | #8fc3ff |
| focus-border | #6e91e6 | #1450be | #ffffff |
| selection | #282e42 | #dae4fc | #20547f |
| selection-foreground | #ffffff | #0f192d | #ffffff |
| hover | #1e2230 | #e4eaf6 | #10243a |
| button-hover | #343c56 | #d0dcf6 | #1b3c5e |
| attention surface | #5c2c30 | #ffe0e0 | #4a160f |
| blocked | #ff5f5f | #d23448 | #ff7676 |
| working | #ffd75f | #b07800 | #ffd75f |
| done | #87afff | #425cd2 | #8fc3ff |
| idle | #87d787 | #268752 | #79e09e |
| unknown | #808080 | #707682 | #d0d0d0 |

Required contrast:

- foreground against background or surface: at least 4.5:1;
- muted readable text: at least 3.6:1, never used for essential controls;
- selected text against selection: at least 4.5:1;
- keyboard focus indicator against adjacent surfaces: at least 3:1;
- high-contrast foreground: at least 7:1;
- high-contrast static boundaries: at least 3:1.

The pinned dark and light values deliberately preserve the current tmux-ide
OpenTUI palette. The current shared dock CSS and Electron teal palette are not
additional themes and must be removed as independent sources of truth.

### Derived surfaces

Derived color math is shared, deterministic, and tested:

- inactive pane body: background;
- focused pane body: mix background toward focus by 6%;
- inactive pane header: mix surface toward border by 15%;
- focused pane header: mix background toward focus by 22%;
- floating focused header: mix background toward focus by 25%;
- pointer hover: the semantic hover token;
- pressed action: button-hover;
- disabled foreground: muted-foreground at 55% alpha on desktop, muted-foreground
  without alpha plus a disabled glyph in OpenTUI;
- inactive scrollbar: fully transparent;
- active scrollbar thumb: foreground at 24% alpha;
- hovered scrollbar thumb: foreground at 26% alpha.

No component may derive focus from blocked, working, done, or idle status.

## State and ownership matrix

State precedence is exact, from highest to lowest:

1. disabled;
2. window-edit selected;
3. terminal input focus;
4. keyboard focus;
5. selected/current;
6. attention;
7. pressed;
8. pointer hover;
9. base.

Exceptions are additive and limited:

- Attention may retain a one-cell or one-dot status marker when a pane is
  focused, but may not replace the focus border.
- Pressed may temporarily replace selected background only for the pressed
  action, not its parent tab or pane.
- Pointer hover is cleared when keyboard movement changes selection.
- Selection and pointer-hover backgrounds never paint the same row.

| State | Border | Header/body | Marker | Geometry |
| --- | --- | --- | --- | --- |
| inactive | border | inactive derived surfaces | hollow dot | unchanged |
| keyboard focused | focus-border | focused header, normal body | solid dot | unchanged |
| terminal focused | focus-border | focused header and 6% focused body | terminal square | unchanged |
| attention, inactive | border | attention surface only in status/header marker region | exclamation in blocked/working tone | unchanged |
| window-edit selected | strong focus border and halo | 24% focus header | diamond | unchanged |
| floating | normal focus rules plus shadow/radius on desktop | floating derived surfaces | ring when otherwise inactive | unchanged |
| maximized | normal focus rules | normal surfaces | max state chip | unchanged |
| disabled action | no extra border | base surface | disabled glyph | unchanged |
| hovered action | no extra border | hover | same icon | unchanged |
| pressed action | no extra border | button-hover | same icon | unchanged |

The pane frame is the only focus-border owner. The terminal framebuffer begins
at the projected body origin and cannot paint header, footer, gutter, border, or
halo cells. Workbench focus rails communicate canvas-versus-dock focus only;
they do not repeat the focused pane's perimeter.

On a focus change, old and new pane bounding rectangles, body origins, header
positions, and action hit boxes must be bit-for-bit equal before and after.
Only paint tokens and semantic attributes may change.

## Responsive acceptance matrix

### Desktop reference viewports

Desktop golden captures use a 900 px viewport height. A separate 720 by 480
minimum-window smoke test verifies clipping and scrolling but is not a golden
composition.

| Viewport | Variant | Session rail | Context inspector | Agent canvas | Open dock minimum | Expected pane density |
| --- | --- | ---: | ---: | --- | ---: | --- |
| 720 px | compact | 48 px, icons plus accessible names | hidden; represented by dock tab | one primary pane; two only if each remains at least 280 px | 126 px including strip | tiny or compact |
| 1280 px | standard | 168 px | optional 240 px when explicitly open | two panes by default, three when each remains at least 280 px | 180 px including strip | compact or standard |
| 1600 px | wide | 184 px | optional 280 px when explicitly open | three panes by default, four when each remains at least 280 px | 252 px including strip | standard or wide |

Desktop workbench height excludes the 28 px titlebar and 18 px global status
strip. Open dock height is round(workbench-height times 0.30), clamped to the
minimum in the table and to preserve minimum canvas heights of 144, 216, and
288 px for compact, standard, and wide. Collapsed dock height is exactly 28 px.
Maximized dock consumes the workbench, but never the native titlebar or global
status strip.

At 720 px, no root horizontal scrollbar is allowed. The tab list may scroll
horizontally with hidden chrome and must scroll the active tab into view.
Inspector content moves into the bottom dock; it does not disappear from the
product.

### OpenTUI reference viewports

The values below follow the current application-shell and workbench formulas
at the fixed renderer-test sizes.

| Terminal | Variant | Sidebar | Application content after top/status rows | Default open dock | Remaining canvas | Palette |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 80 by 24 | compact | 20 columns | 60 by 22 cells | 7 rows | 15 rows | 54 by 22 cells |
| 120 by 40 | standard | 28 columns | 92 by 38 cells | 11 rows | 27 rows | 72 by 23 cells |
| 200 by 60 | wide | 28 columns | 172 by 58 cells | 17 rows | 41 rows | 72 by 23 cells |

The top app tabs and bottom global status each consume one row. The bottom dock
tab strip consumes one row inside the listed dock height. Collapsed dock height
is one row. Minimum open dock heights remain 7, 10, and 14 rows; minimum canvas
heights remain 8, 12, and 16 rows.

When a sidebar plus pane grid cannot preserve a 28-column pane, pane chrome
degrades according to the pane-density table. The app must not hide right-side
pane actions by drawing them beyond the captured frame.

## Command palette benchmark

Palette width follows the measured Gloomberb cell formulas because they create
a compact, repeatable command surface:

- Desktop: max(46, min(78, viewport-cells minus 10, floor(viewport-cells times
  0.64))).
- OpenTUI: max(42, min(72, terminal-columns minus 8, floor(terminal-columns
  times 0.68))).

At the required viewports this resolves to:

| Host size | Width | Ready-state height | Horizontal position |
| --- | ---: | ---: | --- |
| desktop 720 by 900 | 57 cells / 456 px | 20 cells / 360 px | centered, minimum 32 px edge |
| desktop 1280 by 900 | 78 cells / 624 px | 20 cells / 360 px | centered |
| desktop 1600 by 900 | 78 cells / 624 px | 20 cells / 360 px | centered |
| OpenTUI 80 by 24 | 54 columns | 22 rows | centered, minimum 4 columns |
| OpenTUI 120 by 40 | 72 columns | 23 rows | centered, minimum 4 columns |
| OpenTUI 200 by 60 | 72 columns | 23 rows | centered, minimum 4 columns |

The ready list body is at most 16 rows and at least 9. Desktop content padding
is 1 cell / 8 px inline plus a 14 px panel inset; OpenTUI content padding is 3
columns. Trailing command metadata is max(8, min(12, floor(inner-width times
0.18))) cells. Query, group labels, command label, description, status, and
shortcut columns may not change x position when the selected command changes.

Desktop palette treatment is an 8 px radius, 14 px panel padding, and
0 10px 18px canvas shadow at 34%. OpenTUI uses one rounded border. Backdrop
click closes only on desktop. Escape closes on both. Loading, empty, no-match,
error, retry, disabled, current, selected, and scrolled states are mandatory
fixtures.

## Icons

Desktop uses one coherent line-icon family:

- 12 by 12 px for pane, tab, rail, and compact action icons;
- 10 by 10 px for native window controls;
- 1.5 px stroke, round line caps and joins;
- currentColor only;
- no emoji and no mixed filled/outline metaphors in one control family.

OpenTUI maps every semantic icon to a tested single-column Unicode fallback.
Each fallback must pass the terminal display-width helper with width one.
Labels remain the accessibility source of truth; icons are decorative where the
label is already exposed.

## Motion and feedback

| Interaction | Desktop | OpenTUI |
| --- | --- | --- |
| window-control hover | 90 ms linear, color/background only | not applicable |
| tab hover | 110 ms ease, color/background/underline only | next render, no animation |
| action hover | 90 ms linear, color/background only | next render |
| action press | 60 ms linear to button-hover; no translation | mouse-down state until release |
| palette enter/exit | 120 ms ease-out, opacity plus at most 4 px vertical translation | immediate |
| dock collapse/restore | 140 ms ease-out; content clips during transition | immediate |
| pane focus | 0 ms; atomic paint update | one renderer frame |
| resize drag | immediate; no easing | immediate integer cells |
| attention pulse | no continuous pulse; one 140 ms arrival tint allowed | marker update only |

No animation changes the cell grid, terminal body origin, pane header height, or
hit geometry. With reduced motion, every duration is zero, scroll behavior is
auto, and no looping spinner is required. TUI animation is limited to discrete
glyph changes and must never repaint focus borders on a timer.

## Shared-host architecture acceptance

The shared Solid layer may own:

- semantic IDs and ordering;
- active, selected, focused, hovered, pressed, disabled, attention, and status
  state;
- labels, descriptions, keyboard commands, and accessibility intent;
- responsive intent such as compact, standard, or wide;
- command and mission descriptors.

The OpenTUI host owns:

- cell rectangles and integer layout;
- terminal display-width clipping;
- border glyphs, span colors, framebuffer clipping, and mouse cell hit tests.

The desktop host owns:

- CSS grid/flex and pixel rectangles;
- DOM focus, ARIA, pointer hit targets, scrolling, shadows, radii, and motion;
- titlebar drag regions and platform window controls.

WorkbenchDockHostProjection on fa85a405 still exposes dock, dockTabs, dockBody,
dockBodyRail, dockBodyContent, and per-tab x/width cell geometry to the DOM
presenter. Card 22 must split this into a semantic dock presentation model plus
OpenTUI and desktop geometry adapters. Structural TypeScript compatibility is
not sufficient host independence.

Likewise, hard-coded values in web-host.css and styles.css must become semantic
CSS variables produced from the canonical theme. The renderer stays free of
Node.js, Electron, tmux, and filesystem imports.

## Required acceptance suite

### Live preview review checklist

Use this checklist on every candidate desktop and TUI preview. Record the
candidate commit, host, size, theme, reduced-motion setting, and screenshot or
terminal capture before checking a box. A preview passes only when every
applicable item is yes; “not inspected” is not a pass.

Setup for one review round:

- [ ] Candidate revision and build artifact are recorded.
- [ ] Desktop device scale is 100%; TUI font zoom is unchanged during the run.
- [ ] Desktop is reviewed at 720 by 900, 1280 by 900, and 1600 by 900, then
  smoke-tested at 720 by 480.
- [ ] TUI is reviewed at 80 by 24, 120 by 40, and 200 by 60.
- [ ] The same deterministic fixture is loaded: long pane title, two agent
  statuses, Files attention, Missions selected, dirty changes, and enough
  terminal output to scroll.
- [ ] Dark, light, and high-contrast modes are each reviewed without restarting
  into a different fixture.

Shell and overall cohesion:

- [ ] The first impression is one dense terminal-native application, not a web
  landing page containing a terminal.
- [ ] App tabs, session navigation, pane chrome, dock, palette, and status use
  one mono rhythm and the same semantic colors.
- [ ] Desktop titlebar is 28 px, status is 18 px, dock tabs are 28 px, and TUI
  equivalents are one row.
- [ ] On macOS, native traffic-light clearance aligns with the integrated app
  tabs; on Windows/Linux, the three 28 px custom controls use 10 px icons.
- [ ] Maximize and restore the desktop window from its control: state and icon
  update together without moving app tabs. Verify minimize and close on a
  disposable secondary window; close hover uses the danger treatment.
- [ ] The current project/session, current surface, current input pane, and
  current dock tab are each identifiable without competing accent signals.
- [ ] No radial hero, oversized marketing heading, large dashboard card, or
  host-local theme color remains in the workbench.

Pane chrome and terminal ownership:

- [ ] Every visible terminal pane has a header, grip, clipped title, kind icon,
  status, and right-pinned actions appropriate to its local width.
- [ ] Hover each pane action: its hit area is stable, icon is centered, and
  title width does not change.
- [ ] Press and release each pane action, including release outside: pressed
  state always clears.
- [ ] Maximize one pane and restore it: header/actions remain in the same visual
  language and the previous grid returns without drift.
- [ ] Resize across the 28, 44, and 80 cell density boundaries: controls degrade
  in the specified order and never cover the title.
- [ ] Scroll terminal content to all edges: bytes, cursor, selection, and
  scrollbar stay inside the body and never overwrite chrome.
- [ ] Focus transfers change paint only; body origin, border position, header,
  footer, and actions do not move.

Focus-flicker stress:

- [ ] Switch focus across adjacent panes ten times with the keyboard.
- [ ] Repeat ten switches with pointer clicks.
- [ ] Hold a navigation key so focus advances rapidly where supported.
- [ ] During all three checks there is exactly one focused pane, no detached
  horizontal line, no old border residue, no double rail, and no terminal row
  inserted into chrome.
- [ ] A blocked or working state changes only status/attention treatment and
  never impersonates focus.
- [ ] Window-edit selection is visibly stronger than ordinary focus but does
  not resize the pane.

Bottom dock:

- [ ] Files, Changes, Missions, and Activity appear in the same order on both
  hosts with product-appropriate icons and shortcuts.
- [ ] Arrow navigation, pointer activation, Enter/Space, disabled skipping, and
  focus-visible behavior select the same semantic tab.
- [ ] Pointer hover and keyboard selection never remain painted on two rows.
- [ ] Collapse leaves exactly the tab strip; open restores the persisted size;
  maximize consumes only the workbench and restores exactly.
- [ ] Drag resize is immediate and respects the canvas/dock minimums.
- [ ] At 720 px and 80 columns, overflow keeps all tools reachable and scrolls
  the active tab into view.
- [ ] Dock content is native UI, not a tmux pane pretending to be Files,
  Changes, Missions, or Activity.

Command palette:

- [ ] Open from keyboard and pointer entry points; both land on the same query
  and selected command.
- [ ] Measured width and height match the command-palette benchmark at the
  current viewport.
- [ ] Query, group, icon, label, detail, status, and shortcut columns do not
  jump while moving through results.
- [ ] Keyboard movement clears stale pointer hover.
- [ ] Selected, current, hovered, disabled, loading, empty, no-match, error, and
  retry states are visually distinct without color-only meaning.
- [ ] Long labels truncate before trailing shortcuts; the shortcut column
  remains visible.
- [ ] Escape closes the palette first. Ctrl-C is not consumed as app quit.
- [ ] Desktop backdrop click closes the palette; clicks inside do not.

Theme and state:

- [ ] Switching dark to light to high contrast changes semantic variables, not
  component geometry.
- [ ] Foreground, muted text, selection, focus, and high-contrast boundaries
  pass the ratios in this benchmark.
- [ ] Essential status always has a glyph or label in addition to color.
- [ ] Disabled controls remain readable but cannot be confused with inactive
  enabled controls.
- [ ] Hover is subtle, pressed is stronger, selected remains authoritative, and
  focus-visible is reserved for keyboard focus.
- [ ] High contrast contains no alpha-only essential border or focus cue.

Responsive and narrow-window behavior:

- [ ] 720 px shows a 48 px session rail, primary canvas, dock access, and status
  with no root horizontal scrollbar.
- [ ] Information removed from a side inspector at 720 px is reachable in the
  bottom dock.
- [ ] 1280 px supports the standard two-pane composition and optional context
  inspector without violating 280 px pane minimums.
- [ ] 1600 px supports the wide three-pane composition and coherent four-pane
  degradation.
- [ ] 80 columns retains quit/palette help, active surface, session identity,
  one usable agent pane, dock tabs, and status.
- [ ] 120 and 200 columns add detail rather than merely stretching blank space.

Onboarding and empty state:

- [ ] A project without .tmux-ide or ide.yml reaches a useful detected-project
  screen without an error or blank canvas.
- [ ] The primary action and its consequence are clear without documentation.
- [ ] Onboarding uses the same mono type, chrome, palette, actions, and focus
  behavior as the workbench.
- [ ] Onboarding title stays within 20/24 desktop typography or two TUI rows.
- [ ] Completing or skipping onboarding lands in the same shell; there is no
  second visual system during the transition.

Motion, icons, and accessibility:

- [ ] Focus and resizing are immediate; hover, press, palette, and dock motion
  match the timing table.
- [ ] Reduced motion removes every nonessential transition and animation.
- [ ] Desktop icons are one 12 px line family, window icons are 10 px, and no
  emoji or font-dependent double-width icon appears.
- [ ] TUI icon fallbacks occupy exactly one display cell.
- [ ] Desktop controls expose correct roles, names, selected/expanded/pressed
  state, and logical tab order.
- [ ] Text selection works inside terminal output and text inputs but does not
  accidentally select app chrome.

Review closeout:

- [ ] Required screenshots, char frames, span captures, and computed-token dumps
  are attached to the card.
- [ ] Every failure is classified as parity-critical, a listed deliberate
  product difference, or a proposed benchmark change.
- [ ] No proposed benchmark change is accepted only to make an existing
  implementation pass.

### Base visual matrix

Every row below is required in dark, light, and high-contrast themes:

| Host | Sizes | Capture |
| --- | --- | --- |
| Solid/Electron | 720 by 900, 1280 by 900, 1600 by 900 | deterministic screenshot and computed-token dump |
| OpenTUI | 80 by 24, 120 by 40, 200 by 60 | captureCharFrame plus captureSpans |

That is 18 base captures. Each base fixture contains:

- agent canvas with one terminal-focused pane and one inactive attention pane
  where the width permits;
- bottom dock open on Missions;
- Files tab carrying attention without stealing selection;
- global status strip and session navigation;
- enough terminal content to prove framebuffer clipping;
- a long pane title and long tab label to prove truncation.

For each of the 18 combinations, add these state captures:

1. base workspace;
2. command palette with selected, current, disabled, hovered, and trailing
   shortcut rows;
3. zero-config onboarding with detected project and one primary action.

The resulting 54 captures are the release baseline for cohesive product
experience.

### Geometry assertions

- Root width and height equal the requested viewport exactly; no root overflow.
- Every desktop chrome value matches the normative table within 0.5 px.
- Every OpenTUI chrome value matches the normative table exactly in cells.
- Changing focus, terminal focus, attention, hover, press, theme, or selection
  changes no bounding rectangle.
- Pane body begins exactly after the owned header/border and ends before the
  owned footer/border.
- A pane framebuffer cannot produce a non-background span in chrome cells.
- Ten rapid focus transfers produce no orphan border row, duplicate focus rail,
  or single-frame geometry change.
- Long titles truncate before the first right-pinned action with at least one
  cell / 8 px gap.
- Active tabs remain visible after overflow and keyboard navigation.
- 720 by 480 keeps primary navigation, canvas, collapsed dock, and status
  reachable without root horizontal scrolling.

### State and input assertions

- Keyboard selection clears stale pointer hover.
- Hover cannot override selected, focused, disabled, or window-edit state.
- Attention never changes focus color.
- Pressed clears on pointer release outside the control and on blur.
- Focus-visible appears for keyboard navigation and does not remain after a
  pointer-only activation unless the platform requires it.
- Escape closes palette first; it does not quit the app.
- Ctrl-C remains terminal passthrough in a terminal body.
- The product quit/detach command remains Ctrl-Q and is shown consistently.
- Tab order, arrow-key behavior, Enter/Space activation, and disabled skipping
  match across hosts.

### Theme and accessibility assertions

- Test computed contrast for every role pair listed in the palette section.
- High-contrast mode uses no alpha-only essential boundary.
- Essential status has text or glyph meaning in addition to color.
- Desktop tablist, tabs, dock panels, pane actions, palette rows, window
  controls, and onboarding actions have roles and accessible names.
- TUI icon fallbacks are one display cell at all three terminal widths.
- Reduced-motion captures contain no active transition or animation.

## Definition of done

Card 22 is complete only when:

- the semantic token source drives OpenTUI, shared Solid surfaces, and the
  Electron renderer;
- high-contrast is a real theme mode rather than a CSS afterthought;
- the shared dock no longer exports terminal rectangles to the DOM host;
- the Electron foundation's sans dashboard, 42 px titlebar, 46 px controls,
  independent teal palette, radial hero, and large cards are replaced by the
  cohesive workbench language;
- pane chrome has one owner and passes the rapid-focus anti-flicker assertion;
- command palette geometry and behavior match the benchmark;
- all 54 visual captures and the focused interaction tests pass;
- no production surface has a local visual token without a documented semantic
  role.

## Highest-risk visual traps

1. Sharing terminal geometry instead of semantics. Cell x/width fields in a DOM
   contract will make desktop look like a stretched terminal and create
   rounding bugs.
2. Two chrome owners. A native PaneFrame plus framebuffer-drawn border/header is
   the most likely cause of focus flicker, stray rows, and terminal content
   overwriting chrome.
3. Polishing the current Electron landing page. Its typography, density,
   palette, titlebar, and card composition are intentionally only a foundation;
   refining them would deepen the wrong visual language.
4. Independent theme constants. OpenTUI, shared dock CSS, and Electron currently
   have three similar but different palettes. Small drift is highly visible
   when terminals and native panels touch.
5. Global breakpoints applied to local panes. A 1600 px window can contain a
   320 px pane; pane chrome must respond to its own budget.
6. Focus encoded as status. Agent blocked/working/done colors must never move
   the active border or users will lose input-location confidence.
7. Animated focus geometry. Transitions on borders, width, inset, or body origin
   turn ordinary focus changes into flicker. Focus is an atomic paint change.
8. Mixed icon metrics. Emoji, double-width glyphs, and unrelated SVG families
   break both alignment and product identity.
9. Hiding functionality at 720 px. Inspector content may move into the dock but
   cannot simply disappear at the desktop breakpoint.
10. Golden frames without span/style checks. Character snapshots alone miss
    focus, selection, hover, and contrast regressions; desktop pixels alone miss
    semantic and computed-token drift.
