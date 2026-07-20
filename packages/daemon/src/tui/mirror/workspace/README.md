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
3. Named workspace layouts and persisted restore.
4. Keyboard/mouse move, resize, dock, and float interactions.
5. New-pane templates and project lifecycle actions.
6. Command descriptors and a contribution registry.
7. Harness-neutral mission runtime, followed by the native desktop host.

Card 01 is intentionally behavior-neutral: it records the responsive shell
baseline and makes architectural back-edges fail before new window behavior lands.

## PaneFrame v1

`pane-frame.ts` projects one reusable window contract for terminals, files,
changes, missions, previews, and home surfaces. It owns responsive title/status/
action geometry and hit targets; `pane-frame.tsx` paints that projection without
installing input hooks. Semantic status survives narrow layouts before optional
actions, while terminal focus, attention, keyboard focus, and idle state keep
distinct markers.

The live composite workspace now uses `PaneFrameHeader`. Action descriptors are
already represented and renderer-tested, but production command routing remains
with the root controller and will be connected by the command-adapter card.
