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

## Follow-up failure
A genuinely serverless private fixture reaches available → running → stopped-waiting without observing a daemon record. The failure is retained in `.tasks/native-reliability-mission/nr07/empty-setup-corrected.json`; cleanup passed. This does not prove the later no-server catalog hypothesis: bootstrap requires separate investigation.
