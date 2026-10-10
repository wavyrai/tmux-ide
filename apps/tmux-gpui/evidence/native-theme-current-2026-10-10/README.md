# Physical native theme selection — 2026-10-10

Current unsigned macOS ARM64 packaged app, native source `3b3abe18`, native SHA256
`db7ef7cab470f8fd71e90e27cbcdefc2394c3c937a4f21d6558adc435994a110`.
Disposable Visual Qualification bundle ID; user Session Opening demo untouched.

First attempt failed before launching the app: missing private config parent
(ENOENT). Preserved failed-setup.log. Fixture now creates the owned parent before
exclusive config seeding. Independent reviewer approved corrected fixture SHA256
`07fa8264d70e0dea8ab85c6a81ac3c6f4f2d22512921caf869836b72425e9d89`.
Syntax, ESLint and Prettier pass. Fresh-directory rerun exited 0.

Physical operator path: activate Home with Escape, refresh, open sole session,
wait for THEME_READY and Keyboard ready, open Theme, focus search, type Dracula,
Return; Cmd-A in search, type Nord, Return; Escape, Cmd-Q. Chat screenshots showed
Applied: dracula with purple accents, then Applied: nord with blue-gray surfaces
and cyan accents; same terminal content stayed visible. Escape restored Sessions
sidebar and Keyboard ready footer. Screenshots are in chat, not persisted PNGs.

Independent raw PTY capture stayed empty throughout (no leaked search text,
Return, Cmd-A or dismissal Escape). Config files prove both named presets saved
in dark mode while unrelated nested sentinel remained intact. Same producer
survived native close, before owned cleanup. Receipt proves cleanup helpers
returned; controller 64909 and producer 64934 were independently checked absent.
User demo controller 54706 remained live.

Scope: two named-theme choices, native search/selection/dismissal, visible shell
and default terminal recoloring, persistence writes and input isolation. No
pixel colorimetry, all-theme matrix, actual System transitions, restart reload,
IME or signed-distribution acceptance is claimed.

Run with a fresh absolute evidence directory and explicit disposable app:

```sh
TMUX_GPUI_TEST_APP='/absolute/Preview.app' \
TMUX_GPUI_THEME_DIR=/tmp/new-theme-evidence \
node --import tsx apps/tmux-gpui/bridge/native-theme-smoke.mjs
```
