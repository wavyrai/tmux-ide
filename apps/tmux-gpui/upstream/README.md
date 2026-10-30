# tmux-ide native app workspace

This directory is the Cargo workspace for the tmux-ide native macOS app. It
started as an import of [Herdr GPUI](https://github.com/penso/herdr-gpui)
(see `../upstream-provenance.json` and `NOTICE`); the Herdr-only app, its
`herdr-gpui` binary and its release, Homebrew, Nix and updater tooling were
removed in the Mac app cleanup, and git history keeps them.

| Crate | Role |
|---|---|
| `crates/tmux-ide-gpui` | The app: `src/tmux_main.rs` and `src/tmux_snapshot/` |
| `crates/herdr-client` | tmux control, delivery and daemon transport |
| `crates/herdr-protocol` | Wire types shared with the daemon |
| `crates/tmux-native-surface-sdk` | Native surface contract for producers |

Build, run, test and packaging instructions are in `../README.md`. The gates CI
runs are in `../../../.github/workflows/gpui-preview.yml`; `AGENTS.md` lists
them for local use.
