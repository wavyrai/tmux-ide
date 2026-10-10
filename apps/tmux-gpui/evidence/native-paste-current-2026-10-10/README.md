# Physical native paste — 2026-10-10

Passed using the current unsigned packaged macOS ARM64 preview. Native source
commit `3b3abe18`; native SHA256 `db7ef7cab470f8fd71e90e27cbcdefc2394c3c937a4f21d6558adc435994a110`.
The disposable app differs from the Session Opening demo only in bundle ID.

Operator activated Home with Escape, refreshed the private catalog, opened its
sole session, waited for Keyboard ready and PASTE*READY, clicked terminal, and
used native CUA app.paste exactly once with `PASTE*界*e\u0301*🙂\nSECOND_LINE`.
No Return was sent. The screenshot in the chat showed RECEIVED_BYTES=42.
Fixture independently captured raw PTY bytes, including bracketed-paste framing;
expected/actual hex is preserved in bytes.json. Cmd-Q closed only this app.
Same producer PID and live pane survived native close; exact bytes remained
unchanged, then private cleanup completed. Controller 62864 and producer 62891
were independently absent afterward; user demo controller 54706 remained live.

Fixture reviewer approved SHA256
`8ad54777e781ad5abc18be52ef7fbb3e1894488a7340c796bfbe38cb1b7ebd66`.
Syntax, ESLint and Prettier pass. This is one physical clipboard path, not full
IME, all clipboard formats, large-paste or signed-distribution qualification.

Reproduce with a fresh absolute evidence directory and explicit owned app:

```sh
TMUX_GPUI_TEST_APP='/absolute/Preview.app' \
TMUX_GPUI_PASTE_DIR=/tmp/new-paste-evidence \
node --import tsx apps/tmux-gpui/bridge/native-paste-smoke.mjs
```

Follow the printed payload exactly, without Return, then Cmd-Q when requested.
