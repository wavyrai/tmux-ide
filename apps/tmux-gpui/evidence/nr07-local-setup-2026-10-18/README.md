# NR07 explicit local setup — 2026-10-18

Reviewed local increment; NR07 not complete, no release claim.

## Reproduction and owner
`before.json`: private HOME/config/state/socket, source browser --local, Node24.21. Startup and Refresh both remain unavailable and previously instructed manual --headless startup. No daemon record or tmux socket appeared. Discovery is deliberately read-only; repeating discovery cannot bootstrap an absent owner.

An explicit Home setup action now validates the fixed managed CLI installation and invokes its supported `update --daemon --json` path. It never installs or downgrades a CLI. Currently qualified stable CLI versions are 2.9.6 and 2.9.7; unknown versions fail closed. Path/marker/package/version checks and exact child invocation avoid PATH discovery. Cancellation means stopping the CLI wait, not rolling back a detached daemon. The bridge independently rediscovers identity before Home refresh. Navigation, background, shutdown and route changes fence late results; foreground reevaluates discovery without starting anything.

## Evidence
`source-setup-pass.json`: real copied Node24/CLI in a private managed tree, ordinary scratch tmux sessions, initially absent canonical daemon. Offer alone did not start it. Two setup commands produced a verified Home with two sessions and one observed identity. Pane births/PIDs survived. Exact private identity-authenticated shutdown and owned cleanup passed; stderr empty. Source dependency symlink is used, so this is not packaged or clean-machine qualification.

Six resolver/runner unit tests and source-browser lifecycle tests cover malformed/missing/unsupported installation, changed installation, invalid response, abort, no implicit startup, stale request, duplicate action, background cancellation, foreground restoration and failed retry. Combined affected bridge suite:26 passed. Three focused native parser/action tests passed before final Home-only parser hardening. Full Rust default suite: 3093 passed, 0 failed, 11 ignored; all-features: 3127 passed, 0 failed, 18 ignored. Both clippy configurations, formatting and file-size gates passed. Independent review completed.

## Limits
No native GUI or second-Mac install-to-input check: Mac locked. Missing CLI installation remains installer-owned; unsupported installations require updating rather than an automatic downgrade. No-session/no-tmux first run, creating and typing into a new shell/agent, existing-daemon repair and packaged runtime checks remain acceptance work. No production daemon, tmux sessions or settings were altered. Generic upstream no-start guidance is superseded only for this explicit user-requested setup action; discovery and launch remain read-only.

## Serverless follow-up: two distinct mechanisms
`empty-path-trace.json` proves an explicitly selected absent socket path fails immediately in `captureUnixSocketIdentity` during pinned runner construction; an existing private path starts successfully. The detached CLI bootstrap discards the child error and the browser eventually stops waiting. This is not evidence that ordinary named cold startup fails, and the path identity checks have not been relaxed.

`empty-named-trace.json` proves cold startup on a unique named socket succeeds. `empty-named-before.json` drives the actual source-browser setup flow: one verified daemon, zero initial sessions, then Home unavailable with no-server guidance and no usable local creation target. No session was observed after sending the existing scoped create-session command in that unavailable state; this bounded observation is not a correlated rejection acknowledgement. The receipt's passed field means the missing journey was reproduced, not that onboarding is complete. Exact owned cleanup passed; source-browser stderr was empty.

Run the retained reproducer `apps/tmux-gpui/bridge/local-setup-empty-smoke.mjs` with qualified Node 24 and explicit absolute TMUX_GPUI_TEST_CLI/TMUX_GPUI_TEST_OUTPUT. It uses a fresh unique named socket because the pinned tmux environment strips TMUX_TMPDIR; merely setting a private TMUX_TMPDIR would not safely isolate a default socket. This proves cold named authority, not physical default-socket installation.

Next owner change: expose explicitly verified local-daemon first-session creation through the existing daemon-owned workspace.session.create action. Do not fabricate an online server, select a remote route, or weaken path identity fencing. Native GUI and packaged fresh-user acceptance remain open.
