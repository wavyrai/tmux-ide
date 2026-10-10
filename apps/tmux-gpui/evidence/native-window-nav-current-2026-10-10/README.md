# Current packaged native window routing — 2026-10-10

Complete physical run of maintained native-window-nav-smoke.mjs passed, exit0.
Native source `3b3abe18`, native SHA256
`db7ef7cab470f8fd71e90e27cbcdefc2394c3c937a4f21d6558adc435994a110`.
Disposable Visual Qualification app differs only in bundle identifier from the
current Session Opening user demo. Bundled Node/helper, minimal PATH, isolated
cwd, private daemon/HOME/socket; NODE_OPTIONS/NODE_PATH poisoning in fixture.

Operator activated Home with Escape before opening the session. Refresh then
Open automatically selected active window two, without clicking a tab. After
Keyboard ready, clicked terminal and typed echo WINDOW_TWO_OK + Return once.
Clicked tab one, waited Keyboard ready, clicked terminal and typed
echo WINDOW_ONE_OK + Return once. The fixture independently captured both panes,
verified distinct markers and no crossed targets. Chat screenshots showed the
matching selected tab/header and command output. Cmd-Q exited cleanly; fixture
verified source survived before disposing owned daemon/tmux. Controller66081
absent after cleanup; protected user demo controller54706 still live.

This completes the previously partial initial-active-window journey on the
current package. No interruption-signal variant, narrow/crowded layout, signing,
clean-machine distribution or general terminal parity claim.

```sh
TMUX_GPUI_TEST_APP='/absolute/disposable/Preview.app' \
TMUX_GPUI_TEST_INITIAL_WINDOW=two \
node --import tsx apps/tmux-gpui/bridge/native-window-nav-smoke.mjs
```

Follow printed operator markers once. Do not type before Keyboard ready.
