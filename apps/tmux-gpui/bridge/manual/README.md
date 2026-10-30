# Manual smokes

No CI job runs these. Each needs a real GUI, a real OpenSSH server, an operator,
or an ignored Rust test binary, and covers something no CI test does. Run them
from the repository root with `node --import tsx apps/tmux-gpui/bridge/manual/<file>`.

- `direct-terminal-smoke.mjs`: seeds the alternate-screen projection through `tmux_direct_probe`.
- `home-recovery-smoke.mjs`: Home load-more over 33 real agents with a real daemon.
- `kitty-graphics-smoke.mjs`: kitty graphics passthrough in real tmux, digest reattach and re-pull from the daemon store.
- `live-smoke.mjs`: daemon replacement gets a new generation, and the retired preview gets no state.
- `local-setup-smoke.mjs`: a real managed daemon start with one owner and an owned shutdown.
- `native-config-namespace-smoke.mjs`: runs the ignored Rust config-namespace test against the TypeScript runtime namespace.
- `native-discovery-smoke.mjs`: runs the ignored Rust discovery and native-local GUI tests against an owned daemon.
- `native-font-smoke.mjs`: packaged GUI font save and restart, with no PTY leakage (operator-driven).
- `native-pane-selection-smoke.mjs`: packaged two-pane selection and pane chrome, with screenshots.
- `native-pane-split-smoke.mjs`: a menu split in the GUI adds exactly one pane and keeps the source PID.
- `native-paste-smoke.mjs`: the real clipboard to GUI to PTY path, including bracketed paste.
- `native-recovery-smoke.mjs`: daemon replacement in the same running app, with a signal file.
- `native-ssh-smoke.mjs`: runs the ignored Rust OpenSSH tests against an owned sshd.
- `native-theme-smoke.mjs`: the GUI theme picker saves to an isolated config and keeps unrelated keys.
- `native-visual-smoke.mjs`: visual capture of the native app; `--prepare-only` only prepares the tmux screen.
- `native-window-nav-smoke.mjs`: GUI window navigation with a narrow window and long labels.
- `packaged-app-smoke.mjs`: type into a packaged app and check the pane capture.
