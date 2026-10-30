# tmux-ide-gpui

The native macOS app for tmux-ide. `src/tmux_main.rs` is its only entry point,
and `src/tmux_snapshot/` holds the app: the Home and workspace windows, the
native terminal renderer, and the Rust worker that talks to the tmux-ide daemon
through `herdr-client`.

A few small modules outside `tmux_snapshot/` are shared helpers: window chrome
(`titlebar`, `window`), fonts and theme colours (`config`, `fonts`, `contrast`),
the terminal painter (`terminal_painter`, `terminal`), and text input
(`search_input`, `input`).

The crate started as the Herdr GPUI app. Its Herdr modules (the Herdr window,
sidebar, menus, settings, browser tabs, updater, usage meters, GitHub, review,
worktrees, cloud devices and the `herdr-gpui` binary) were removed in the Mac
app cleanup; git history keeps them. See `apps/tmux-gpui/README.md` for how to
build, run and test the app.
