# Card 22 implementation-readiness audit

Status: implementation map, no production changes

Audit baseline: `origin/main` at `6932d541df47aa9dc5514ce7eee308aceeea0012`

Headless prerequisite examined: `m31/task-16b-headless-frontdoor` through `1d3277be`

Desktop prerequisite examined: `m31/task-19b-electron-shell` through `f8dc911f`

Shared-dock prerequisite examined: `m31/task-19a-shared-solid-dock` through `fa85a405`

Combined preview examined: `m31/integration-preview` at `5de0c589`

## Result

Cards 22.2–22.4 are ready to implement in small slices, but they must not begin on
today's `origin/main` as though the headless front door, desktop packages, and
shared dock were already there. The safe landing order is:

1. Card 16b's canonical shipped `tmux-ide --headless` daemon owner;
2. the corrected Card 19a shared dock and Card 19b Electron/Solid foundation,
   rebased onto that daemon revision and then landed together;
3. the completed Card 22.1 renderer-free experience kernel;
4. Card 22 host adapters and integration.

That dependency is real, not administrative. `origin/main` has the live
Solid/OpenTUI application but no `apps/desktop-renderer`, no
`apps/electron-shell`, and no `apps/*` workspace entry. Card 16b is also still a
seven-commit branch above the same main SHA. It supplies the canonical headless
daemon process and wire front door that the desktop host must discover rather
than replace. The reviewed 19a and 19b work exists on separate branches. The
combined preview proves that the corrected 19a/19b UI packages compose, but it
does not contain Card 16b, and its desktop `App.tsx` still constructs a synthetic
dock projection and keeps the foundation hero/rail/inspector. It is a visual
preview, not the daemon-integrated Card 22 product shell.

The implementation should preserve three existing strengths:

- `app.tsx` remains the single OpenTUI keyboard, pointer, renderer-lifecycle, and
  effect owner.
- tmux remains the terminal framebuffer and process truth. App chrome and dock
  geometry remain outside the framebuffer contract.
- the Electron main process remains a thin, secure OS host; the browser-native
  Solid renderer owns product UI and stays runnable without Electron.

## Dependency graph

```text
16b canonical headless front door
             │
             ├─ 19a corrected shared dock ─┐
             │                              ├─ shared landing revision
             └─ 19b corrected desktop ─────┘              │
                                                           ├─ 22.2 host adapters
22.1 experience kernel ─────────────────────────────────────┤
                                                           ├─ 22.3 shell/dock
                                                           └─ 22.4 PaneFrame

22.2 token adapters ────────────────┬─ 22.3 visual leaves
                                    └─ 22.4 visual leaves

22.3 shell geometry/slots ───────────── 22.4 terminal-pane composition

Card 21 live xterm attachment ────────── independent body-slot supplier
```

22.2 can be split by host after 22.1 lands. The OpenTUI and DOM portions of 22.3
can then proceed in parallel against one fixture and command trace. The shared
PaneFrame presenter in 22.4 must land before its two host leaves, but live xterm
transport is not a prerequisite for its chrome contract.

### Exact current live-preview route

The preview is branch-specific; it is not available from current `main`.

```bash
cd /Users/thijs/Developer/tmux-ide/.worktrees/m31-integration-preview
pnpm install --frozen-lockfile
pnpm dev:desktop-preview
```

`dev:desktop-preview` first builds `@tmux-ide/daemon`, then starts the Electron
development host. That host starts Vite at exactly `http://127.0.0.1:5173/`, sets
`TMUX_IDE_RENDERER_URL` to that URL, and opens the Electron window. For the same
renderer without Electron:

```bash
cd /Users/thijs/Developer/tmux-ide/.worktrees/m31-integration-preview
pnpm --filter @tmux-ide/daemon build
pnpm --filter @tmux-ide/desktop-renderer dev
# open http://127.0.0.1:5173/
```

The browser path intentionally uses the safe fallback in
`apps/desktop-renderer/src/host-capabilities.ts`; native window actions and daemon
lifecycle are unavailable there. Neither route previews Card 22 yet, and neither
is the live Card 16b daemon integration path. After the dependency chain lands,
keep the same user-facing preview command but replace Card 19b's deferred daemon
preflight with discovery of the canonical 16b owner.

## Verified ownership on current `origin/main`

### OpenTUI root and navigation

| File | Current owner | Card 22 treatment |
| --- | --- | --- |
| `packages/daemon/src/tui/mirror/app.tsx` | Production composition, signals, one `useKeyboard`, root pointer routing, renderer command executor, lifecycle, tmux effects, active canvas/dock/view state | Keep as the only input/effect owner. Replace direct shell JSX with the canonical shell projection/render boundary. Do not move tmux or lifecycle effects into presenters. |
| `packages/daemon/src/tui/mirror/workspace/application-shell.ts` | Pure cell-layout projection and shell hit-test for top tabs, sidebar, content, and status | Keep as OpenTUI host geometry. Change its inputs from locally invented product labels/states to Card 22.1 semantic shell data. It must not become the shared renderer-free shell model because it exposes cell rectangles. |
| `packages/daemon/src/tui/mirror/workspace/application-shell.tsx` | Tested presentational `ApplicationShell`, composing `ShellTabBar`, `ShellMiniSidebar`, `ShellStatusStrip`, and a child content slot | Make this the live OpenTUI shell boundary, after extending its sidebar slot/data so existing agent rows and actions are not lost. It is currently not imported or rendered by `app.tsx`. |
| `packages/daemon/src/tui/mirror/shell-chrome.ts` | OpenTUI cell variants, tab spans, sidebar hint spans, status-line clipping, and RGBA visual palettes | Retain geometry/clipping in the TUI adapter. Replace product-law ownership (surface registry, token meaning, marker meaning) with imports from 22.1/22.2. |
| `packages/daemon/src/tui/mirror/shell-chrome.tsx` | OpenTUI `ShellTabBar`, `ShellMiniSidebar`, `ShellStatusStrip`, and composite leaf chrome | Keep as OpenTUI leaves, fed through the 22.2 theme/icon facade. Do not expose these cell-native leaves to DOM. |
| `packages/daemon/src/tui/mirror/sidebar.tsx` | The richer live fleet sidebar: sessions, agents, attention/age, add-agent affordance, and palette footer hint | Do not delete it before feature parity exists. Fold its agent rows/actions into the canonical OpenTUI sidebar leaf or make it the sidebar slot of `ApplicationShell`; then remove the redundant `ShellMiniSidebar` path. |
| `packages/daemon/src/tui/mirror/workspace/workbench-controller.ts` | Renderer-local Home/Terminals and dock shortcut/focus policy | Keep renderer-local input interpretation, but use canonical surface and command IDs. The root still executes commands. |
| `packages/daemon/src/tui/mirror/renderer-commands.ts` | Stable renderer command registry and executor for palette, lifecycle, surface, canvas, and dock actions | Preserve as the effect boundary. Rebase its surface IDs/descriptors onto 22.1 rather than creating a second desktop-only registry. |
| `packages/daemon/src/tui/mirror/palette-surface-adapter.ts` | Converts current `PaletteAction` values into stable command-palette descriptors, icons, groups, details, shortcuts, and disabled reasons | Keep as a transitional OpenTUI adapter. Move shared command descriptor/ranking law to 22.1; retain tmux-specific actions and runtime availability here. |
| `packages/daemon/src/tui/mirror/workspace/command-palette-surface.ts` and `.tsx` | OpenTUI palette geometry, stable row identities, hit zones, and terminal-native rendering | Retain as the OpenTUI Cmd-K host. It should consume the canonical descriptor ordering/state from 22.1. DOM needs its own semantic dialog/listbox host, not this cell projection. |

The duplicate live composition is visible in `app.tsx`: it renders
`ShellTabBar` directly, then `Sidebar`, then `WorkbenchShell`. The independently
tested `ApplicationShell` is not part of production composition. Card 22.3 must
remove that split ownership rather than adding a third shell.

### OpenTUI dock and terminal canvas

| File | Current owner | Card 22 treatment |
| --- | --- | --- |
| `packages/daemon/src/tui/mirror/workspace/workbench-shell.ts` | OpenTUI cell geometry for canvas, focus rails, three dock modes, four dock tabs, action spans, and hit tests | Keep cell geometry and hit tests host-specific. On the 19a prerequisite, retain the shared navigation policy import and renderer-neutral dock projection shape. |
| `packages/daemon/src/tui/mirror/workspace/workbench-shell.tsx` | On main, manually renders canvas, dock tabs/actions, dock focus rail, and body | Start from corrected 19a, where the manual dock leaves are replaced by `OpenTuiWorkbenchDock`. Do not redo that extraction in 22.3. |
| `packages/daemon/src/ui/workbench-dock/presenter.tsx` | On 19a, intrinsic-free Solid control flow and renderer-neutral dock projection contract | Keep as the one shared dock composition seam. It derives no geometry and owns no state. |
| `packages/daemon/src/ui/workbench-dock/navigation.ts` | On 19a, shared automatic-activation policy for arrows/Home/End with disabled-tab skipping | Keep as shared command behavior. Both roots report the same semantic activation trace. |
| `packages/daemon/src/tui/mirror/workspace/workbench-dock-opentui.tsx` | On 19a, OpenTUI host leaves for the shared presenter | Feed 22.2 tokens/icons into these leaves. Keep DOM and Node imports out. |
| `packages/daemon/src/ui/workbench-dock/web-host.tsx` and `.css` | On 19a, DOM/ARIA leaves, keyboard roving/activation, and hard-coded dock CSS colors | Keep the DOM semantics. Replace the CSS literals with 22.2 variables. Do not move DOM keyboard events into the shared presenter. |
| `packages/daemon/src/tui/mirror/workspace/agent-terminal-canvas.ts` | Cell geometry separating app chrome/footer from the tmux framebuffer and its exact resize truth | Preserve. 22.3/22.4 may change shell space around it, but only this host adapter translates that into `tmuxSize`. |
| `packages/daemon/src/tui/mirror/workspace/agent-terminal-canvas-view.tsx` | Passive OpenTUI slots for chrome, framebuffer, and footer | Preserve the slots. Chrome work must not remount or absorb the framebuffer body. |

Files, Changes, Missions, and Activity already render as OpenTUI-native dock
surfaces in `app.tsx`; they are not tmux panes. Card 22.3 should change their
container and semantic data inputs, not replace them with terminal widgets.

### OpenTUI pane chrome

| File | Current owner | Card 22 treatment |
| --- | --- | --- |
| `packages/daemon/src/tui/mirror/workspace/pane-frame.ts` | Mixed host concerns: cell geometry/clipping/hit zones plus local pane-state precedence, markers, status glyphs, icon choice, chip priority, and action projection | Split the semantic composition from cell projection. Consume the 22.1 `PaneAppearance`; retain rectangles, cell fitting, Unicode display width, and hit tests here. |
| `packages/daemon/src/tui/mirror/workspace/pane-frame.tsx` | OpenTUI header/full-frame rendering, border glyphs, token palette, and stable chip keys | Convert to the OpenTUI leaves/wrapper for the shared PaneFrame presenter. Preserve semantic chip keys and property updates. |
| `packages/daemon/src/tui/mirror/workspace/terminal-pane-chrome.ts` | Adapts live tmux pane geometry/metadata to pane headers, chooses native/gutter placement, projects zoom/menu actions, and owns pointer intents | Keep as the tmux/OpenTUI bridge. Map pane metadata and orthogonal runtime flags into `PaneAppearance`; do not move `%pane_id` or cell geometry into the shared model. |
| `packages/daemon/src/tui/mirror/workspace/terminal-pane-chrome-view.tsx` | Renders native/framebuffer chrome layers and keys each pane by pane ID across fresh projections | Preserve keyed layer identity. Its current `sameIds`/`projectionsById` pattern is a regression guard against the prior `insertBefore`/anchor flicker. |
| `packages/daemon/src/tui/mirror/workspace/icons.ts` | TUI Unicode glyph/fallback/label registry | Turn into the 22.2 OpenTUI icon adapter. Canonical icon meaning and ID come from 22.1; cell-safe glyph/fallback remains here. |
| `packages/daemon/src/tui/mirror/theme.ts` and `recipes.ts` | OpenTUI `RGBA` semantic snapshot, interaction precedence, and cell-native recipe geometry | Keep a compatibility facade for current callers. Shared token/state meaning comes from 22.1; RGBA, cell dimensions, and OpenTUI palette conversion remain host-specific. |

The existing pane state is already modeled as orthogonal booleans
(`focused`, `terminalFocused`, `attention`, `windowEditSelected`, `floating`,
`maximized`) but `paneFrameMarker` collapses those flags into one marker while
other chips remain independent. Card 22.1 must become the authority for that
composition; Card 22.4 must not re-create a different priority table in DOM.

## Verified desktop ownership on the reviewed Card 19b foundation

| File | Current owner | Card 22 treatment |
| --- | --- | --- |
| `apps/electron-shell/src/main.ts` | Single-instance lifecycle, BrowserWindow creation, native titlebar mode, macOS traffic-light placement, bounds persistence, theme publication, directory dialog, shutdown, and renderer loading | Keep all OS window controls and drag/window lifecycle capabilities here. Card 22.3 may adjust host-native titlebar parameters, but it must not move product UI into Electron main. |
| `apps/electron-shell/src/window-security.ts` | Sandboxed/context-isolated preferences and navigation/popup/webview denial | No visual edits. Preserve this boundary while adding product UI. |
| `apps/electron-shell/src/preload.ts`, `host-ipc.ts`, `ipc-channels.ts` | Finite validated `HostCapabilities` bridge for bootstrap, theme, window actions, quit, and folder selection | Reuse only the finite capabilities needed by the canonical shell. Do not add generic command/eval/raw IPC for UI parity. |
| `apps/desktop-renderer/src/host-capabilities.ts` | Browser-safe fallback and validation of the preload bridge | Preserve browser-dev operation. Shell components depend on this interface, never on Electron imports. |
| `apps/desktop-renderer/src/App.tsx` | Temporary foundation titlebar, static workspace rail, hero/cards, host-status inspector, statusbar; combined preview also fabricates dock state/projection | Replace its product composition in 22.3. Keep bootstrap/theme/window subscriptions and native capability calls, preferably moved into a small renderer controller/store. Delete the synthetic `DOCK_TABS`/`dockProjection` once real shared shell state drives the dock. |
| `apps/desktop-renderer/src/styles.css` | Temporary foundation layout and hard-coded colors; combined preview imports shared dock CSS | Replace hero/rail/inspector/card rules with canonical shell CSS. Keep global reset, root sizing, reduced-motion handling, and titlebar drag/no-drag behavior as host concerns. Feed colors through 22.2 variables. |
| `apps/desktop-renderer/src/main.tsx` | Solid DOM mount only | Keep minimal. |

The Electron host already uses `titleBarStyle: "hiddenInset"` on macOS and
`"hidden"` elsewhere; macOS traffic lights remain native, while the renderer
shows finite minimize/maximize/close buttons only off macOS. That division is
the correct Card 22.3 window-chrome boundary.

## Card 22.2 — theme, typography, icon, and host adapters

### 22.2a: shared token conformance (first)

Dependency: landed 22.1 exports.

1. Add fixture-level tests beside the 22.1 kernel proving all required token,
   icon, status, surface, and pane-role IDs are exhaustive and serializable.
2. Freeze one `CohesionFixtureV1` input for all adapter tests. Adapters may add
   host measurements, never mutate or decorate the fixture with cells/pixels.
3. Add an import-boundary test proving the 22.1 graph contains no DOM,
   Electron, Node, OpenTUI, `string-width`, or terminal geometry imports.

This slice changes kernel tests only after 22.1; it does not touch either
renderer and can land before the two host adapters.

### 22.2b: OpenTUI adapter

Files to edit:

- `packages/daemon/src/tui/mirror/theme.ts`: make
  `createSemanticThemeSnapshot` a compatibility facade over canonical tokens;
  keep `RGBA` conversion and resolved terminal theme mode here.
- `packages/daemon/src/tui/mirror/recipes.ts`: consume canonical interaction
  precedence and tone roles; keep `Rect`, cell widths, scrollbar glyphs, and
  gallery geometry local.
- `packages/daemon/src/tui/mirror/workspace/icons.ts`: map canonical icon IDs to
  Unicode-safe primary/fallback glyphs and accessible text.
- `packages/daemon/src/tui/mirror/shell-chrome.tsx`,
  `workspace/workbench-dock-opentui.tsx`, and `workspace/pane-frame.tsx`: consume
  only the facade/adapter, not raw shared color strings.
- `packages/daemon/src/tui/mirror/sidebar.tsx` and the four native dock surface
  renderers: remove direct product-color ownership as each is brought through
  the facade. Temporary exported aliases are acceptable only with a removal
  test/list.

Tests/snapshots:

- extend `theme.test.ts`, `recipes.test.ts`, and `workspace/icons.test.ts` with
  the common fixture and light/dark/high-contrast mappings;
- update renderer snapshots only after asserting semantic spans/colors, so an
  all-dark blank snapshot cannot pass accidentally;
- run the complete `test:tui-renderer` suite, because theme changes reach every
  surface even when only shell snapshots visibly change.

### 22.2c: DOM adapter

Files to add/edit on the shared 19a/19b base:

- add a desktop token adapter under `apps/desktop-renderer/src/experience/`
  that emits CSS custom properties and returns canonical vector/icon metadata;
- edit `apps/desktop-renderer/src/styles.css` to consume those variables;
- edit `packages/daemon/src/ui/workbench-dock/web-host.css` to replace
  `--dock-*` literals and the literal attention color with canonical variables;
- edit `apps/desktop-renderer/src/App.tsx` only enough to install theme and
  accessibility variables on the root. Full layout replacement belongs to
  22.3.

Tests:

- pure adapter tests for light/dark/high-contrast and missing optional tokens;
- DOM computed-style assertions for selected/focused/attention/disabled states;
- keep `prefers-reduced-motion` behavior and add a fixture flag assertion so
  host preference and product state cannot disagree silently.

22.2b and 22.2c have disjoint host files and can run in parallel after 22.2a.

## Card 22.3 — canonical application shell and dock

### 22.3a: shared shell command/projection seam

Dependency: 22.1 and 22.2a. No renderer JSX in this slice.

- Use the 22.1 surface registry as the sole source for Home, Terminals, Files,
  Changes, Missions, and Activity identity/order/labels/shortcuts.
- Keep Files/Changes/Missions/Activity in the bottom dock; do not reintroduce
  persistent top tabs or rail entries for those tools.
- Define one semantic shell action trace covering surface activation, dock
  collapse/open/maximize, focus-zone movement, palette open/close, and focus
  return. Feed it through existing `CommandInvocation`/`CommandDescriptor`
  shapes from `packages/contracts/src/commands.ts`.
- Keep host geometry out. The OpenTUI `application-shell.ts` and
  `workbench-shell.ts` continue to calculate cells; CSS calculates desktop
  layout.

Tests: one fixture-to-command trace test shared by both host harnesses and a
forbidden-geometry/import test for the semantic projection.

### 22.3b: OpenTUI shell integration

Files to edit:

- `packages/daemon/src/tui/mirror/app.tsx`: construct one
  `ApplicationShellProjection`, render one `ApplicationShell`, and pass the
  existing `WorkbenchShell` as its content. Route shell hits through
  `applicationShellHitTest`; keep the existing root route and `useKeyboard`.
- `packages/daemon/src/tui/mirror/workspace/application-shell.ts`: accept the
  canonical shell semantic projection plus host dimensions, while retaining
  cell rectangles and hit zones.
- `packages/daemon/src/tui/mirror/workspace/application-shell.tsx`: expose a
  sidebar slot or richer canonical sidebar props so sessions, agents,
  attention, add-agent, and palette affordances survive migration.
- `packages/daemon/src/tui/mirror/sidebar.tsx` and
  `packages/daemon/src/tui/mirror/shell-chrome.tsx`: consolidate to one sidebar
  leaf. Delete `ShellMiniSidebar` only after the production sidebar is covered
  by the canonical shell renderer test.
- `packages/daemon/src/tui/mirror/workspace/workbench-shell.tsx`: start from
  corrected 19a and keep `OpenTuiWorkbenchDock`; no manual second tab bar.
- `packages/daemon/src/tui/mirror/renderer-commands.ts` and
  `workbench-controller.ts`: translate shortcuts/pointer hits to the shared
  semantic command IDs and trace.

Legacy JSX to delete from `app.tsx` after the replacement passes:

- the outer direct `ShellTabBar` wrapper;
- the direct side-by-side `Sidebar`/main composition;
- local duplicate top-surface registry/order where 22.1 supplies it;
- any old palette fallback overlay that bypasses `CommandPaletteSurface`, once
  its asynchronous tmux paste-buffer subflow is represented inside the native
  palette host.

Do **not** delete the tmux window strip, framebuffer layers, search footer, pane
chrome layers, or native dock tool bodies. They are content supplied to the new
shell, not legacy shell ownership.

Tests/snapshots to update:

- `workspace/application-shell.test.ts` and
  `workspace/application-shell-renderer.test.tsx`;
- `workspace/workbench-shell.test.ts` and renderer snapshots from corrected
  19a;
- `shell-chrome.test.ts` and `shell-chrome-renderer.test.tsx`;
- root input/lifecycle, renderer-command, pointer, paste, and workspace-state
  tests affected by the new coordinate origin;
- paired acceptance snapshots at exactly 80x24, 120x40, and 200x60.

The existing `ApplicationShell` renderer test already covers those three sizes,
pointer/keyboard routing, renderer destruction, and Solid disposal. Convert it
from an isolated harness into the fixture baseline, then add one production-root
smoke that proves `app.tsx` actually uses the boundary.

### 22.3c: DOM shell integration

Files to add/edit:

- replace the composition in `apps/desktop-renderer/src/App.tsx` with canonical
  titlebar, shared workspace/session/agent sidebar, Home/Terminals canvas,
  `WebWorkbenchDock`, status/recovery strip, and overlay root;
- add DOM components under `apps/desktop-renderer/src/experience/` for those
  host leaves; use real landmarks, buttons, tabs, dialog/listbox semantics, and
  focus restoration;
- replace temporary `.rail`, `.canvas` hero, `.cards`, and `.inspector` rules in
  `styles.css` with responsive shell rules at the three acceptance sizes;
- keep `.titlebar__drag`, `.window-controls`, root sizing, and reduced-motion
  rules, adapted to the canonical tokens;
- keep `host-capabilities.ts` as the only native bridge;
- use the corrected 19a `WebWorkbenchDock`; remove the combined preview's local
  `DOCK_TABS` and fabricated one-pixel `dockProjection`.

Tests/evidence:

- DOM semantic tests for landmarks, sidebar selection, ARIA tab relationships,
  dialog/listbox Cmd-K behavior, disabled reasons, Escape, and focus return;
- keyboard/mouse tests that emit the same semantic command trace as OpenTUI;
- screenshots at 720x480, 1280x820, and 1600x1000, in dark and light mode where
  token differences matter;
- browser-dev build plus Electron smoke. The shell must work in Vite without a
  preload bridge, using the existing browser-safe fallback.

22.3b and 22.3c can proceed in parallel after 22.3a and 22.2 host adapters.

## Card 22.4 — cross-host PaneFrame

### 22.4a: shared intrinsic-free presenter

Dependency: 22.1 `PaneAppearance` and the shell body-slot contract from 22.3a.

Add an intrinsic-free shared Solid presenter beside the dock precedent, for
example under `packages/daemon/src/ui/pane-frame/`. It should accept:

- stable semantic pane identity and kind;
- composed `PaneAppearance` from 22.1;
- semantic title/subtitle/status/chips/actions;
- injected `Root`, `Header`, `Grip`, `Title`, `Status`, `ActionList`, `Action`,
  and `Body` leaves;
- semantic action callbacks only.

It must not accept cell rectangles, CSS pixels, `%pane_id`, Electron window IDs,
xterm IDs, PTY IDs, OpenTUI `RGBA`, DOM events, or transport handles. Like the
shared dock presenter, it owns only Solid control flow and stable identity.

Add import-DAG tests matching
`packages/daemon/src/ui/workbench-dock/import-dag.test.ts`: presenter runtime
imports are `solid-js` only; web leaves have no OpenTUI/Node imports; OpenTUI
leaves have no DOM/Node imports.

### 22.4b: OpenTUI PaneFrame leaves

Files to edit:

- `workspace/pane-frame.ts`: change `projectPaneFrame` to accept a semantic
  appearance and host action descriptors; retain all cell fitting, spans,
  clipping, border rectangles, and hit testing;
- `workspace/pane-frame.tsx`: implement injected OpenTUI leaves or a thin
  wrapper around them; retain `keyedChips` semantics;
- `workspace/terminal-pane-chrome.ts`: map live pane metadata/state to
  `PaneAppearance`, then map semantic actions to cell targets. Keep placement,
  overlap proof, pointer intent, focus-before-action ordering, and zoom/menu
  effects;
- `workspace/terminal-pane-chrome-view.tsx`: retain pane-ID keyed renderables and
  the native/framebuffer layer split;
- `app.tsx`: only wire the new semantic input/callbacks. Do not restructure the
  terminal body.

Regression tests that must remain and be extended:

- `pane-frame.test.ts`: tiny bounds, Unicode clipping, orthogonal state matrix,
  action priority, and exact hit zones;
- `pane-frame-renderer.test.tsx`: 80x24/120x40/200x60 snapshots, semantic
  span/color assertions, disabled/hovered/pressed actions;
- `terminal-pane-chrome.test.ts`: no body overlap, lower separator pass-through,
  exact tmux sizing, focus-before-action, and lifecycle reconciliation;
- `agent-terminal-canvas-renderer.test.tsx`: stable pane/action renderable
  identity across fresh projections and no `insertBefore`/anchor warnings.

### 22.4c: DOM PaneFrame leaves

Add the DOM host next to the shared presenter and export it through a generated
package entry consumed by `apps/desktop-renderer`. It must provide:

- a semantic heading and status/chip text;
- focus-visible and attention styling as separate channels;
- actual buttons for actions, with labels/tooltips and disabled/pressed state;
- a body slot whose keyed child is supplied by the terminal host.

Add DOM tests for the complete `PaneAppearance` matrix, accessible action names,
keyboard activation, focus/attention coexistence, and stable body node identity
while appearance changes. Use a fake stable body sentinel until Card 21 supplies
live xterm attachments; later replace the sentinel without changing PaneFrame.

22.4b and 22.4c can run in parallel after 22.4a.

## Package and build constraints

These constraints come from the corrected 19a/19b code, not from the current
main tree:

1. Card 16b must land before the desktop host is wired to daemon lifecycle. Its
   canonical `tmux-ide --headless` owner, lock/wire protocol, contention,
   takeover, authentication, and shutdown behavior are the front door; Card 22
   must consume them rather than start a second daemon implementation.
2. `pnpm-workspace.yaml` must include `apps/*` before desktop packages can be
   filtered or linked.
3. `apps/desktop-renderer` is Solid/Vite, depends on `@tmux-ide/contracts`, and
   may consume generated browser-safe daemon UI exports. It may not import
   Electron, Node built-ins, or `@tmux-ide/electron-shell`.
4. `apps/electron-shell` builds the renderer first, copies its dist, validates
   CSP, bundles main/preload with esbuild, and requires Node >=22. Do not bypass
   those scripts with a second renderer bundle path.
5. The corrected shared-dock build deliberately separates:
   - normal daemon `tsc` output;
   - OpenTUI JSX typechecking;
   - DOM JSX typechecking and declarations;
   - Vite's DOM library output leaf.
6. Vite must never clear the parent `dist/ui/workbench-dock` directory after
   daemon `tsc`; corrected 19a writes the web bundle to a nested `web/` leaf.
7. Any new exported PaneFrame DOM host needs the same pack-consumer proof as
   `check-workbench-dock-package.mjs`: clean dist, pack, TypeScript consumer,
   runtime import, and CSS export. A stale local dist must not make CI pass.
8. Keep the intrinsic-free presenter on `solid-js` only. Do not import
   `solid-js/web` into code used by OpenTUI, and do not import `@opentui/*` into
   the DOM graph.
9. Update root `test`, `test:unit`, `check`, and renderer-test lists when the
   desktop/presenter tests land. The current main scripts do not include either
   desktop package because those packages are not on main yet.

Prefer one explicit browser UI build surface for additional shared components
instead of accumulating unrelated Vite commands. If 22.4 extends the existing
dock library build, rename/generalize its config and package check in the same
commit; do not leave exports whose generated files depend on command order.

## Legacy deletion checklist

Delete only when the replacement has fixture and host coverage:

- [ ] direct production `ShellTabBar`/`Sidebar` shell composition in OpenTUI
- [ ] redundant `ShellMiniSidebar` after agent/session/action parity
- [ ] local duplicate surface/tab registries superseded by 22.1
- [ ] manual OpenTUI dock JSX from pre-19a `workbench-shell.tsx`
- [ ] desktop foundation rail, hero/cards, and host-status inspector
- [ ] combined preview's fabricated dock projection and placeholder dock body
- [ ] hard-coded desktop and shared-dock product color literals
- [ ] local pane marker/status/icon priority tables superseded by
      `PaneAppearance`
- [ ] old palette fallback overlay after tmux paste-buffer loading/error/retry is
      represented in the canonical native palette host

Keep:

- [ ] OpenTUI root input/effect/lifecycle ownership
- [ ] Electron native titlebar/window/security ownership
- [ ] browser-safe renderer fallback
- [ ] tmux framebuffer and exact resize truth
- [ ] keyed OpenTUI pane renderables and keyed desktop terminal bodies
- [ ] all native Files/Changes/Missions/Activity surfaces

## Smallest safe parallel implementation slices after 22.1

The following slices minimize overlapping files:

1. **Prerequisite integration:** land Card 16b, then rebase/land corrected 19a
   and 19b together on that revision; rerun Card 16b headless ownership/stress
   tests, shared dock package proof, desktop tests/build/smoke, daemon typecheck,
   and the OpenTUI renderer suite. This is serial.
2. **22.2 shared conformance:** kernel fixture/exhaustiveness/import-boundary
   tests. Serial and first.
3. **22.2 OpenTUI adapter:** `theme.ts`, `recipes.ts`, `icons.ts`, OpenTUI leaves,
   and renderer snapshots.
4. **22.2 DOM adapter:** desktop CSS-variable/icon adapter and dock CSS. Runs in
   parallel with slice 3.
5. **22.3 shared command trace:** semantic shell actions and fixture trace. Serial
   before host shell integration.
6. **22.3 OpenTUI shell:** `app.tsx`, application-shell/sidebar/chrome, root
   routing, and TUI acceptance snapshots.
7. **22.3 DOM shell:** desktop `App.tsx`, experience components/CSS, ARIA tests,
   and screenshots. Runs in parallel with slice 6.
8. **22.4 shared PaneFrame presenter:** intrinsic-free composition, import DAG,
   fixture trace, and package export skeleton. Serial before host leaves.
9. **22.4 OpenTUI PaneFrame:** cell projection/leaves, terminal bridge, identity
   and flicker tests.
10. **22.4 DOM PaneFrame:** DOM leaves/CSS/ARIA/body-identity tests and generated
    package proof. Runs in parallel with slice 9.
11. **Cross-host qualification:** paired fixture traces, screenshots/snapshots,
    theme/focus/attention stress, browser build, Electron smoke, TUI build, and
    the full repository check. Serial final gate.

No two parallel slices above need to edit `app.tsx`, desktop `App.tsx`, or the
same host adapter. The shared semantic slices land first so host agents consume
one contract instead of resolving drift during integration.

## Verification commands for implementers

Run the focused commands while iterating, then the full gate:

```bash
# OpenTUI
pnpm --filter @tmux-ide/daemon typecheck
pnpm test:tui-renderer
pnpm build:tui

# Shared browser UI package (names from corrected 19a; generalize if 22.4 does)
pnpm build:workbench-dock-web
pnpm test:workbench-dock-package

# Desktop foundation after 19b lands
pnpm --filter @tmux-ide/desktop-renderer test
pnpm --filter @tmux-ide/desktop-renderer typecheck
pnpm --filter @tmux-ide/desktop-renderer build
pnpm --filter @tmux-ide/electron-shell test
pnpm --filter @tmux-ide/electron-shell typecheck
pnpm --filter @tmux-ide/electron-shell smoke

# Final
pnpm check
git diff --check
```

Electron packaging smoke is a release-quality follow-up gate when platform and
CI time permit; ordinary `smoke` plus the package-consumer proof should remain
the per-card baseline.

## Audit evidence index

Every ownership claim above was checked against these concrete symbols or
tests:

- OpenTUI root: `app.tsx` imports/renders `ShellTabBar`, `Sidebar`,
  `WorkbenchShell`, `AgentTerminalCanvas`, `TerminalPaneChromeLayer`, and
  `CommandPaletteSurface`; its single `useKeyboard` owns global input.
- Unwired shell: `projectApplicationShell`, `applicationShellHitTest`, and
  `ApplicationShell`; no `ApplicationShell` reference exists in `app.tsx`.
- Dock geometry: `projectWorkbenchShell`, `workbenchShellHitTest`, and corrected
  19a's `WorkbenchDockPresenter`, `OpenTuiWorkbenchDock`, `WebWorkbenchDock`.
- Terminal isolation: `projectAgentTerminalCanvas` and its `tmuxSize` contract;
  `projectTerminalPaneChrome` and `terminalPaneChromeOverlapsBodies`.
- Flicker guard: `TerminalPaneChromeLayer` keys by `paneId`; the renderer test
  retains renderable identity and rejects anchor/`insertBefore` warnings.
- Desktop boundary: `runDesktopApp`, `secureWebPreferences`, `denyRendererEscapes`,
  `HostCapabilities`, and the package READMEs/import-boundary tests.
- Build boundary: corrected 19a's daemon exports, separate OpenTUI/DOM
  tsconfigs, nested Vite output, and `check-workbench-dock-package.mjs`.

The audit intentionally made no production, package, config, tmux, or mission
state changes.
