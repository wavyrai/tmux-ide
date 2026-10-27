# Embedded tools and native design system

Research snapshot: 11 October 2026. Latest fetched Herdr main is
`1500fd2f8a226490ae7355b7ff4a4be59484182e`; our imported baseline is
`302700e1486977092e4a9165bc083ecdc9236227`. The research checkout is separate;
no upstream update has been applied to the working native client.

## Herdr integration

Herdr embeds browser pages and VS Code within its app. Browser tabs are client-owned
workspace items, separate from daemon terminal panes. A page can sit beside terminals
in another editor group. VS Code can be a workspace side panel or a group tab.

The implementation uses `gpui-wry` 0.6.6 and `lb-wry` 0.53.3. Native child webviews
sit above the GPUI surface, so it explicitly manages geometry, visibility and overlays.
The current source enables embedded pages on macOS and Windows; Linux has an external
browser fallback. Sources: [browser model](https://github.com/penso/herdr-gpui/blob/1500fd2f8a226490ae7355b7ff4a4be59484182e/crates/tmux-ide-gpui/src/browser.rs),
[native views](https://github.com/penso/herdr-gpui/blob/1500fd2f8a226490ae7355b7ff4a4be59484182e/crates/tmux-ide-gpui/src/browser/native.rs).

VS Code uses a web server, not a GPUI rewrite of the editor. Herdr discovers the
VS Code CLI and supervises `code serve-web` off the UI thread, with token/port handling,
readiness, restart backoff and shutdown. It asks the user to accept the server terms
before launching with the acceptance flag. Sources:
[launcher](https://github.com/penso/herdr-gpui/blob/1500fd2f8a226490ae7355b7ff4a4be59484182e/crates/tmux-ide-gpui/src/code_server/launcher.rs),
[supervisor](https://github.com/penso/herdr-gpui/blob/1500fd2f8a226490ae7355b7ff4a4be59484182e/crates/tmux-ide-gpui/src/code_server/supervisor.rs).

For tmux-ide, reuse these modules selectively and replace Herdr workspace assumptions
with our live daemon context. Keep terminal identity/input/geometry in the daemon;
keep embedded page state and the editor process lifecycle in the native client.
The entire latest upstream tree should not replace our adapted baseline wholesale.

## Design system direction

Zed separates reusable UI components from style primitives. Its UI source includes
icons, buttons, tabs/tab bars, tree rows, menus, tooltips, badges, dialogs and scrollbars.
Style modules cover spacing, typography, colors, elevation and appearance. We should
adopt this organization for our own native component library, with tmux-ide theme
tokens as its color source and the TUI as its information architecture.

Create one component gallery before polishing screens independently. Define compact
and normal density, icon sizes, focus rings and states centrally. Replace ad hoc text
actions with labeled icon buttons where appropriate, with consistent tooltips and
keyboard hints. Retain text for ambiguous/destructive actions. Share PaneHeader,
TabBar and SidebarRow across terminal, browser and editor surfaces.

Zed snapshot: `93d745668805029476e6d7fbb19652116fed51de`.
Its [ui crate](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/ui/Cargo.toml)
declares GPL-3.0-or-later; its
[GPUI crate](https://github.com/zed-industries/zed/blob/93d745668805029476e6d7fbb19652116fed51de/crates/gpui/Cargo.toml)
declares Apache-2.0. Use Zed UI architecture as reference, not an assumed permissive
copy source. Check individual icon assets and dependencies before reuse, and retain
Herdr attribution for adapted code. No VS Code redistribution assumption is made.

## Bounded implementation sequence

1. Native tokens, SVG icon registry, core controls and component gallery.
2. Migrate existing sidebar, pane headers, tabs and action menus to those components.
3. One embedded browser tab with focus/resize/overlay/close acceptance.
4. Embedded VS Code using the same page host and an adapted supervised server.
5. Workspace groups, persistence and failure/recovery acceptance.

These are planned capabilities, not claims about the running demo. The present
demo still only launches an external VS Code folder through its Actions menu.
