# Application workspace boundary

M31 turns the mirror TUI into a persistent application workspace. This folder
is the migration boundary between app-owned presentation and runtime adapters.

## Rules

- `.ts` files project immutable view state, geometry, commands, and hit targets.
- `.tsx` files only render those projections with Solid/OpenTUI.
- The root controller remains the single keyboard, pointer-routing, renderer,
  and shutdown owner during the migration.
- This layer does not import tmux mirrors, command-center handlers, filesystem or
  process APIs, or the legacy `app.tsx` root.
- New surfaces get pure model tests plus headless renderer snapshots at `80x24`,
  `120x40`, and `200x60`.

## M31 delivery order

1. Application boundary and shared renderer harness.
2. `PaneFrame` v1 with focus, attention, metadata, and action chrome.
3. Application-owned agent canvas and persistent bottom-dock projection.
4. Named workspace layouts and persisted restore.
5. Keyboard/mouse move, resize, dock, and float interactions.
6. New-pane templates and project lifecycle actions.
7. Command descriptors and a contribution registry.
8. Harness-neutral mission runtime, followed by the native desktop host.

Card 01 is intentionally behavior-neutral: it records the responsive shell
baseline and makes architectural back-edges fail before new window behavior lands.

## PaneFrame window chrome

`pane-frame.ts` projects one reusable window contract for terminals, files,
changes, missions, previews, and home surfaces. It owns responsive title/status/
action geometry and hit targets; `pane-frame.tsx` paints that projection without
installing input hooks. Semantic status survives narrow layouts before optional
actions, while terminal focus, attention, keyboard focus, window-edit selection,
floating, maximized, and idle state remain orthogonal. The projection explicitly
models border, grip, header, body, status/state chips, and action cells; hit
testing returns only those zones so the root controller can remain the single
keyboard, pointer, lifecycle, and tmux-command owner.

Action descriptors are represented and renderer-tested, but production command
routing and any app/root integration remain with later cards. PaneFrame must not
consume or reflow tmux framebuffer cells unless a future integration card changes
the root canvas geometry and tests that explicitly.

## WorkbenchShell and bottom dock

`workbench-shell.ts` projects the agent canvas and the application-owned bottom
dock without reading runtime state. The dock exposes Files, Changes, Missions,
and Activity tabs; collapsed, open, and maximized geometry; a separately
preserved preferred open height; effective focus zones; responsive minimums;
and exact tab, action, canvas, and dock-body hit cells.

`workbench-shell.tsx` only paints that projection. Its production dock now runs
through `ui/workbench-dock/presenter.tsx`, an intrinsic-free Solid presenter
whose capitalized leaves are supplied by either the OpenTUI or standard DOM
host. `workbench-shell.ts` remains the single geometry/state projection and
`workbench-controller.ts` remains the input policy boundary; neither host
derives a second dock model.

The OpenTUI leaves preserve the existing cell tree and root-owned event routing.
The DOM leaves expose a semantic tablist, tab and action buttons, and a tabpanel
with roving keyboard focus. The two hosts share one fixture/action trace and
have separate JSX typecheck/build lanes plus transitive import-DAG guards.
Browser/Electron renderers can consume `@tmux-ide/daemon/workbench-dock-web`
and its explicit `@tmux-ide/daemon/workbench-dock-web.css` style export.
